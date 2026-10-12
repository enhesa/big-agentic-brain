import { randomUUID } from "node:crypto";
import { getDb, inTransaction } from "./db";
import { audit } from "./audit";
import { emit } from "./events";
import { redact, assertMaxLength, assertRawLength } from "./redact";
import { getUser, getUsersByIds } from "./users";
import { deliveryFor, type Delivery } from "./delivery";
import { NotFoundError, ForbiddenError, ValidationError } from "./errors";
import type {
  AuditVia,
  MessageKind,
  MessageRequest,
  MessageRow,
  ThreadLease,
  ThreadRow,
} from "./types";

const BODY_MAX = 8000;
const SUBJECT_MAX = 200;

const REQUEST_KIND_MAX = 40;
const REQUEST_GOAL_MAX = 2000;
const REQUEST_REPO_MAX = 300;
const REQUEST_REF_MAX = 300;
const REQUEST_CWD_MAX = 120;
const REQUEST_LINK_MAX = 500;
const REQUEST_LINKS_MAX_COUNT = 5;
const REQUEST_KIND_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The 400 for a new thread with no recipient. Messages go to a person's inbox, never to a session. */
export const NEW_THREAD_NEEDS_TO = "to is required when starting a new thread: messages go to a person's inbox";

/**
 * Parses a stored `request` column (JSON or null) back into a `MessageRequest`
 * for API/UI responses. Malformed JSON (shouldn't happen — we only ever write
 * what validateRequest() produced) degrades to null rather than throwing.
 */
function parseRequest(raw: string | null): MessageRequest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MessageRequest) : null;
  } catch {
    return null;
  }
}

/**
 * Replaces a row's raw `request` JSON string with the parsed object (or
 * null), for every place a message reaches an API response or the UI.
 */
export function withRequest<T extends { request: string | null }>(
  message: T,
): Omit<T, "request"> & { request: MessageRequest | null } {
  // messages.to_session is an unused column from session addressing: it never leaves the server.
  const { to_session: _unused, ...rest } = message as T & { to_session?: unknown };
  void _unused;
  return { ...(rest as unknown as Omit<T, "request">), request: parseRequest(message.request) };
}

/**
 * Validates a caller-supplied `request` object against the collaborative
 * request contract, redacts free-text fields (`goal`, `links`) through
 * redact(), and returns a clean `MessageRequest`. Throws ValidationError
 * with a precise message on any violation.
 */
export function validateRequest(input: unknown): MessageRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("request must be an object");
  }
  const record = input as Record<string, unknown>;

  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (!kind) throw new ValidationError("request.kind is required");
  if (kind.length > REQUEST_KIND_MAX) {
    throw new ValidationError(`request.kind must be ${REQUEST_KIND_MAX} characters or fewer`);
  }
  if (!REQUEST_KIND_RE.test(kind)) {
    throw new ValidationError(
      "request.kind must be a lowercase slug matching /^[a-z0-9][a-z0-9-]*$/",
    );
  }

  const goalRaw = typeof record.goal === "string" ? record.goal.trim() : "";
  if (!goalRaw) throw new ValidationError("request.goal is required");
  if (goalRaw.length > REQUEST_GOAL_MAX) {
    throw new ValidationError(`request.goal must be ${REQUEST_GOAL_MAX} characters or fewer`);
  }
  const goal = redact(goalRaw);

  const result: MessageRequest = { kind, goal };

  if (record.repo !== undefined) {
    if (typeof record.repo !== "string" || !record.repo.trim()) {
      throw new ValidationError("request.repo must be a non-empty string");
    }
    const repo = record.repo.trim();
    if (repo.length > REQUEST_REPO_MAX) {
      throw new ValidationError(`request.repo must be ${REQUEST_REPO_MAX} characters or fewer`);
    }
    result.repo = redact(repo);
  }

  if (record.ref !== undefined) {
    if (typeof record.ref !== "string" || !record.ref.trim()) {
      throw new ValidationError("request.ref must be a non-empty string");
    }
    const ref = record.ref.trim();
    if (ref.length > REQUEST_REF_MAX) {
      throw new ValidationError(`request.ref must be ${REQUEST_REF_MAX} characters or fewer`);
    }
    result.ref = redact(ref);
  }

  if (record.cwd !== undefined) {
    if (typeof record.cwd !== "string" || !record.cwd.trim()) {
      throw new ValidationError("request.cwd must be a non-empty string");
    }
    const cwd = record.cwd.trim();
    if (cwd.length > REQUEST_CWD_MAX) {
      throw new ValidationError(`request.cwd must be ${REQUEST_CWD_MAX} characters or fewer`);
    }
    if (cwd.includes("/") || cwd.includes("\\")) {
      throw new ValidationError("request.cwd must be a folder name, not a path (no / or \\)");
    }
    result.cwd = cwd;
  }

  if (record.links !== undefined) {
    if (!Array.isArray(record.links)) {
      throw new ValidationError("request.links must be an array of strings");
    }
    if (record.links.length > REQUEST_LINKS_MAX_COUNT) {
      throw new ValidationError(`request.links must have at most ${REQUEST_LINKS_MAX_COUNT} entries`);
    }
    const links: string[] = [];
    for (const link of record.links) {
      if (typeof link !== "string" || !link.trim()) {
        throw new ValidationError("request.links entries must be non-empty strings");
      }
      const trimmed = link.trim();
      if (trimmed.length > REQUEST_LINK_MAX) {
        throw new ValidationError(`request.links entries must be ${REQUEST_LINK_MAX} characters or fewer`);
      }
      // Rendered as clickable anchors on /conversations: only web URLs, so a
      // `javascript:` link from another user can never reach a colleague's browser.
      if (!/^https?:\/\/\S+$/i.test(trimmed)) {
        throw new ValidationError("request.links entries must be http(s) URLs");
      }
      links.push(redact(trimmed));
    }
    if (links.length > 0) result.links = links;
  }

  return result;
}

export interface SendInput {
  fromId: string;
  /** Recipient id or email. Optional on a reply (inferred from the thread). */
  to?: string;
  body: string;
  subject?: string;
  threadId?: string;
  kind?: MessageKind;
  /** True when the request carried `X-Bab-Lease: 1` — decrements the sender's lease on this thread. */
  useLease?: boolean;
  /** A structured collaborative request (review-pr, pair, question, ...) attached to this message. */
  request?: MessageRequest;
}

/** Whether actorId created the thread or has sent/received a message in it. */
function isParticipant(db: ReturnType<typeof getDb>, threadId: string, actorId: string): boolean {
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as | ThreadRow
    | undefined;
  if (!t) return false;
  if (t.created_by === actorId) return true;

  const { n } = db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND (from_id = ? OR to_id = ?)",
    )
    .get(threadId, actorId, actorId) as unknown as { n: number };
  return n > 0;
}

/**
 * The other side of a thread from `fromId`'s point of view: the counterpart of the most
 * recent message involving them, else the thread's creator. Lets a reply omit `to`.
 */
function inferRecipient(db: ReturnType<typeof getDb>, threadId: string, fromId: string): string | null {
  const last = db
    .prepare(
      `SELECT from_id, to_id FROM messages
       WHERE thread_id = ? AND (from_id = ? OR to_id = ?)
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(threadId, fromId, fromId) as unknown as { from_id: string; to_id: string } | undefined;
  if (last) return last.from_id === fromId ? last.to_id : last.from_id;
  const t = db.prepare("SELECT created_by FROM threads WHERE id = ?").get(threadId) as unknown as
    | { created_by: string }
    | undefined;
  if (t && t.created_by !== fromId) return t.created_by;
  return null;
}

export function send(
  input: SendInput,
  via: AuditVia = "ui",
): {
  thread: ThreadRow;
  message: Omit<MessageRow, "request"> & { request: MessageRequest | null };
  /** What BAB knows about whether the recipient can see it now (lib/delivery.ts); never "read". */
  delivery: Delivery;
} {
  const db = getDb();

  let threadId = input.threadId;
  let to = (input.to ?? "").trim().toLowerCase();
  if (threadId) {
    const existing = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as | ThreadRow
      | undefined;
    if (!existing) throw new NotFoundError("Thread not found");
    if (!isParticipant(db, threadId, input.fromId)) {
      throw new ForbiddenError("Not a participant of this thread");
    }
    if (!to) {
      to = inferRecipient(db, threadId, input.fromId) ?? "";
      if (!to) throw new ValidationError("Cannot infer the recipient; pass `to`");
    } else {
      const target = getUser(to);
      if (!target || !isParticipant(db, threadId, target.id)) {
        throw new ForbiddenError("Recipient is not a participant of this thread");
      }
      to = target.id;
    }
  }

  const recipient = getUser(to);
  if (!recipient) throw new ValidationError("Unknown recipient");
  // A note to yourself is fine: it lands in your own inbox like any other message.
  to = recipient.id;

  assertRawLength("body", input.body, BODY_MAX);
  const body = redact(input.body.trim());
  assertMaxLength("body", body, BODY_MAX);

  const requestJson = input.request ? JSON.stringify(input.request) : null;

  if (input.kind !== undefined && input.kind !== "human") {
    throw new ValidationError(
      'kind "auto" is no longer supported: every reply must be approved by the user (draft mode)',
    );
  }
  const kind: MessageKind = "human";

  // A lease-backed send (a plain send carrying X-Bab-Lease: 1, a human-approved chat loop)
  // is refused once the lease is spent.
  if (input.useLease && threadId) {
    const lease = getLeaseForActor(threadId, input.fromId);
    if (!lease || lease.turnsLeft <= 0) {
      throw new ForbiddenError("No live lease turns left for this thread");
    }
  }

  const isNewThread = !threadId;
  let newSubject: string | null = null;
  if (isNewThread) {
    assertRawLength("subject", input.subject ?? "", SUBJECT_MAX);
    newSubject = redact((input.subject ?? "(no subject)").trim());
    assertMaxLength("subject", newSubject, SUBJECT_MAX);
    threadId = randomUUID();
  }
  // Definitely assigned at this point: either passed in, or just minted above.
  const finalThreadId = threadId as string;

  const messageId = randomUUID();

  // Thread insert (if new), message insert, audit row and lease decrement
  // must land together: a crash partway through — e.g. after the message
  // insert but before the audit row or the lease decrement — would otherwise
  // leave a message with no audit trail, or a lease that never got spent for
  // a reply that did go out.
  inTransaction(db, () => {
    if (isNewThread) {
      db.prepare(
        "INSERT INTO threads (id, subject, created_by) VALUES (?, ?, ?)",
      ).run(finalThreadId, newSubject, input.fromId);
    }

    db.prepare(
      `INSERT INTO messages (id, thread_id, from_id, to_id, body, kind, request)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(messageId, finalThreadId, input.fromId, to, body, kind, requestJson);

    audit(db, input.fromId, "send", "message", messageId, via, { details: { kind } });

    if (input.useLease) {
      decrementLease(db, finalThreadId, input.fromId);
    }
  });

  const thread = db.prepare("SELECT * FROM threads WHERE id = ?").get(finalThreadId) as unknown as ThreadRow;
  const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as unknown as MessageRow;

  // /api/events is served without SSO (public path), so a message event must not
  // carry the subject or body: participants read those via the authenticated
  // thread API, the UI only needs a pointer to refresh. Emitted only after a
  // successful commit above — a rollback must never announce a message that
  // was never actually written.
  // No sender name either: the stream is public, and a name says who is talking to whom
  // (P0.3, 2026-10-01). LiveUpdates uses no payload field.
  emit("message.created", finalThreadId, {
    id: messageId,
    kind,
  });

  return { thread, message: withRequest(message), delivery: deliveryFor(recipient, input.fromId) };
}

export interface InboxThread {
  thread: ThreadRow;
  lastMessage: Omit<MessageRow, "request"> & { request: MessageRequest | null };
  unreadCount: number;
}

/**
 * Threads where the user is a participant (sent to or received), newest
 * activity first. Single set-based query (CTEs for "my threads", each
 * thread's last message by rowid, and per-thread unread counts) instead of
 * a per-thread round trip.
 */
export function inboxFor(userId: string): InboxThread[] {
  const db = getDb();

  const rows = db
    .prepare(
      `WITH my_threads AS (
         SELECT DISTINCT thread_id FROM messages WHERE to_id = ? OR from_id = ?
       ),
       last_msg AS (
         SELECT m.*, m.rowid AS rowid
         FROM messages m
         JOIN (
           SELECT thread_id, MAX(rowid) AS rid
           FROM messages
           WHERE thread_id IN (SELECT thread_id FROM my_threads)
           GROUP BY thread_id
         ) x ON x.thread_id = m.thread_id AND x.rid = m.rowid
       ),
       unread AS (
         SELECT thread_id, COUNT(*) AS n
         FROM messages
         WHERE to_id = ? AND read_at IS NULL
         GROUP BY thread_id
       )
       SELECT
         t.id AS thread_id, t.subject AS thread_subject, t.created_by AS thread_created_by,
         t.created_at AS thread_created_at,
         lm.id AS msg_id, lm.from_id AS msg_from_id, lm.to_id AS msg_to_id,
         lm.body AS msg_body, lm.read_at AS msg_read_at, lm.created_at AS msg_created_at,
         lm.kind AS msg_kind, lm.request AS msg_request,
         COALESCE(u.n, 0) AS unread_count
       FROM threads t
       JOIN last_msg lm ON lm.thread_id = t.id
       LEFT JOIN unread u ON u.thread_id = t.id
       WHERE t.id IN (SELECT thread_id FROM my_threads)
       ORDER BY lm.created_at DESC, lm.rowid DESC`,
    )
    .all(userId, userId, userId) as unknown as {
    thread_id: string;
    thread_subject: string | null;
    thread_created_by: string;
    thread_created_at: string;
    msg_id: string;
    msg_from_id: string;
    msg_to_id: string;
    msg_body: string;
    msg_read_at: string | null;
    msg_created_at: string;
    msg_kind: string;
    msg_request: string | null;
    unread_count: number;
  }[];

  return rows.map((r) => ({
    thread: {
      id: r.thread_id,
      subject: r.thread_subject,
      created_by: r.thread_created_by,
      created_at: r.thread_created_at,
    } as ThreadRow,
    lastMessage: withRequest({
      id: r.msg_id,
      thread_id: r.thread_id,
      from_id: r.msg_from_id,
      to_id: r.msg_to_id,
      body: r.msg_body,
      read_at: r.msg_read_at,
      created_at: r.msg_created_at,
      kind: r.msg_kind,
      request: r.msg_request,
    } as MessageRow),
    unreadCount: r.unread_count,
  }));
}

export function unreadCountFor(userId: string): number {
  const db = getDb();
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND read_at IS NULL")
    .get(userId) as unknown as { n: number };
  return n;
}

/** A message row as exposed to API/UI consumers: `request` parsed, never the raw JSON string. */
export type ClientMessage = Omit<MessageRow, "request"> & { request: MessageRequest | null };

export function thread(
  threadId: string,
  actorId: string,
): { thread: ThreadRow; messages: ClientMessage[] } | undefined {
  const db = getDb();
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as | ThreadRow
    | undefined;
  if (!t) return undefined;
  if (!isParticipant(db, threadId, actorId)) return undefined;

  const messages = db
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
    .all(threadId) as unknown as MessageRow[];

  return { thread: t, messages: messages.map(withRequest) };
}

/**
 * Same lookup as thread(), but for the API: distinguishes "doesn't exist"
 * (404) from "exists, you're just not in it" (403) instead of collapsing
 * both into undefined.
 */
export function requireThreadForActor(
  threadId: string,
  actorId: string,
): { thread: ThreadRow; messages: ClientMessage[] } {
  const db = getDb();
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as | ThreadRow
    | undefined;
  if (!t) throw new NotFoundError("Thread not found");
  if (!isParticipant(db, threadId, actorId)) {
    throw new ForbiddenError("Not a participant of this thread");
  }

  const messages = db
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
    .all(threadId) as unknown as MessageRow[];

  return { thread: t, messages: messages.map(withRequest) };
}

export function markRead(threadId: string, userId: string, via: AuditVia = "ui") {
  const db = getDb();
  const result = db.prepare(
    "UPDATE messages SET read_at = datetime('now') WHERE thread_id = ? AND to_id = ? AND read_at IS NULL",
  ).run(threadId, userId);
  // Nothing changed means nothing to record: a second click or a refresh must not add audit rows.
  if (Number(result.changes ?? 0) > 0) {
    audit(db, userId, "read", "thread", threadId, via);
    emit("message.created", threadId, { id: threadId, kind: "read" });
  }
}

export interface ThreadParticipant {
  id: string;
  name: string | null;
  email: string | null;
}

export interface ThreadSummary {
  id: string;
  subject: string | null;
  created_by: string;
  createdByName: string | null;
  participants: ThreadParticipant[];
  messageCount: number;
  lastMessageAt: string;
  lastSnippet: string;
}

export interface ListAllThreadsOptions {
  /** Filters subject/body via LIKE. */
  q?: string;
  /** Max results, clamped to 1..100 (default 50). */
  limit?: number;
  /** ISO cursor: only threads whose last activity is strictly before this. */
  before?: string;
}

const SNIPPET_MAX = 140;
/** Bounds the LIKE-search candidate scan in listAllThreads before ranking/pagination. */
const SEARCH_CANDIDATE_LIMIT = 200;

/** First `SNIPPET_MAX` chars of the last message body, plain text (no HTML escaping needed here). */
function snippetOf(body: string): string {
  return body.slice(0, SNIPPET_MAX);
}

/**
 * Every thread in the system, newest-activity-first, for the human-facing
 * read-only Conversations browser. Unlike inboxFor()/thread(), this carries
 * no participant restriction — it's deliberately open to all signed-in staff.
 *
 * Single set-based pass: one query gets the page of threads (with their
 * message count / last message body already joined in), one batched query
 * gets every participant id for that whole page, and one batched query
 * resolves every distinct user id (creators + participants) to name/email —
 * instead of a per-thread creator lookup, last-message lookup and
 * participant scan.
 */
export function listAllThreads(options: ListAllThreadsOptions = {}): ThreadSummary[] {
  const db = getDb();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 100);

  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (options.before) {
    clauses.push("mc.lastMessageAt < ?");
    params.push(options.before);
  }

  const q = options.q?.trim();
  if (q) {
    const like = `%${q}%`;
    // Bound the LIKE scan to a candidate set of (at most) SEARCH_CANDIDATE_LIMIT
    // threads before the outer query joins/ranks/paginates it, so an
    // unfiltered wildcard-ish query can't force a full-table LIKE scan on
    // every request.
    clauses.push(
      `t.id IN (
         SELECT t2.id FROM threads t2
         WHERE t2.subject LIKE ? OR EXISTS (
           SELECT 1 FROM messages m2 WHERE m2.thread_id = t2.id AND m2.body LIKE ?
         )
         ORDER BY t2.created_at DESC
         LIMIT ${SEARCH_CANDIDATE_LIMIT}
       )`,
    );
    params.push(like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT t.id, t.subject, t.created_by, mc.messageCount AS messageCount,
              mc.lastMessageAt AS lastMessageAt, lastMsg.body AS lastBody
       FROM threads t
       JOIN (
         SELECT thread_id, COUNT(*) AS messageCount, MAX(created_at) AS lastMessageAt, MAX(rowid) AS lastRowid
         FROM messages
         GROUP BY thread_id
       ) mc ON mc.thread_id = t.id
       JOIN messages lastMsg ON lastMsg.rowid = mc.lastRowid
       ${where}
       ORDER BY mc.lastMessageAt DESC, mc.lastRowid DESC
       LIMIT ?`,
    )
    .all(...params, limit) as unknown as {
    id: string;
    subject: string | null;
    created_by: string;
    messageCount: number;
    lastMessageAt: string;
    lastBody: string;
  }[];

  if (rows.length === 0) return [];

  const threadIds = rows.map((r) => r.id);
  const placeholders = threadIds.map(() => "?").join(",");
  const participantRows = db
    .prepare(
      `SELECT thread_id, from_id AS id FROM messages WHERE thread_id IN (${placeholders})
       UNION
       SELECT thread_id, to_id AS id FROM messages WHERE thread_id IN (${placeholders})`,
    )
    .all(...threadIds, ...threadIds) as unknown as { thread_id: string; id: string }[];

  const participantIdsByThread = new Map<string, string[]>();
  for (const r of rows) participantIdsByThread.set(r.id, [r.created_by]);
  for (const p of participantRows) {
    const ids = participantIdsByThread.get(p.thread_id);
    if (ids && !ids.includes(p.id)) ids.push(p.id);
  }

  const allUserIds = new Set<string>();
  for (const ids of participantIdsByThread.values()) for (const id of ids) allUserIds.add(id);
  const userMap = getUsersByIds(Array.from(allUserIds));

  return rows.map((r) => {
    const participantIds = participantIdsByThread.get(r.id) ?? [r.created_by];
    return {
      id: r.id,
      subject: r.subject,
      created_by: r.created_by,
      createdByName: userMap.get(r.created_by)?.name ?? null,
      participants: participantIds.map((id) => {
        const u = userMap.get(id);
        return { id, name: u?.name ?? null, email: u?.email ?? null };
      }),
      messageCount: r.messageCount,
      lastMessageAt: r.lastMessageAt,
      lastSnippet: snippetOf(r.lastBody),
    };
  });
}

export interface ViewerMessage extends ClientMessage {
  fromName: string | null;
  fromEmail: string | null;
  toName: string | null;
  toEmail: string | null;
}

/**
 * Thread + all its messages, chronologically, with sender/recipient names
 * and emails resolved — for the human-facing Conversations browser. No
 * participant restriction (unlike thread()/requireThreadForActor(), which
 * the agent-facing API keeps unchanged).
 */
export function threadForViewer(
  threadId: string,
): { thread: ThreadRow; messages: ViewerMessage[] } | undefined {
  const db = getDb();
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as | ThreadRow
    | undefined;
  if (!t) return undefined;

  const messages = db
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
    .all(threadId) as unknown as MessageRow[];

  const userIds = new Set<string>();
  for (const m of messages) {
    userIds.add(m.from_id);
    userIds.add(m.to_id);
  }
  const userMap = getUsersByIds(Array.from(userIds));

  const enriched: ViewerMessage[] = messages.map((m) => {
    const from = userMap.get(m.from_id);
    const to = userMap.get(m.to_id);
    return {
      ...withRequest(m),
      fromName: from?.name ?? null,
      fromEmail: from?.email ?? null,
      toName: to?.name ?? null,
      toEmail: to?.email ?? null,
    };
  });

  return { thread: t, messages: enriched };
}

// ---------------------------------------------------------------------------
// Chat leases: a human-approved run of replies in one thread.
// ---------------------------------------------------------------------------

export const LEASE_MAX_TURNS = 10;
export const LEASE_MAX_MINUTES = 60;

interface LeaseStore {
  [actorId: string]: ThreadLease;
}

function parseLeaseStore(leaseJson: string | null): LeaseStore {
  if (!leaseJson) return {};
  try {
    const parsed = JSON.parse(leaseJson);
    return parsed && typeof parsed === "object" ? (parsed as LeaseStore) : {};
  } catch {
    return {};
  }
}

/**
 * Records that `actorId` pre-approved up to `turns` of their own future
 * replies in this thread, expiring after `minutes`. One lease per (thread,
 * actor); a new call overwrites the previous one. The server never enforces
 * approvals itself (that's the agent's job per the skill) — it only
 * decrements `turnsLeft` on each lease-backed send and refuses sends once
 * spent or expired.
 */
export function recordLease(
  threadId: string,
  actorId: string,
  turns: number,
  minutes: number,
): ThreadLease {
  const db = getDb();
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as ThreadRow | undefined;
  if (!t) throw new NotFoundError("Thread not found");
  if (!isParticipant(db, threadId, actorId)) {
    throw new ForbiddenError("Not a participant of this thread");
  }

  const clampedTurns = Math.min(Math.max(Math.trunc(turns) || 0, 1), LEASE_MAX_TURNS);
  const clampedMinutes = Math.min(Math.max(Math.trunc(minutes) || 0, 1), LEASE_MAX_MINUTES);

  const { expiresAt } = db
    .prepare("SELECT datetime('now', ?) AS expiresAt")
    .get(`+${clampedMinutes} minutes`) as unknown as { expiresAt: string };

  const store = parseLeaseStore(t.lease_json);
  const lease: ThreadLease = { actorId, turnsLeft: clampedTurns, expiresAt };
  store[actorId] = lease;

  db.prepare("UPDATE threads SET lease_json = ? WHERE id = ?").run(JSON.stringify(store), threadId);
  audit(db, actorId, "lease", "thread", threadId, "mcp", { details: { turns: clampedTurns, minutes: clampedMinutes } });

  return lease;
}

/** The caller's live lease on a thread, or undefined if none/expired/spent-out isn't filtered here (turnsLeft may be 0). */
export function getLeaseForActor(threadId: string, actorId: string): ThreadLease | undefined {
  const db = getDb();
  const t = db.prepare("SELECT lease_json FROM threads WHERE id = ?").get(threadId) as unknown as
    | { lease_json: string | null }
    | undefined;
  if (!t) return undefined;
  const store = parseLeaseStore(t.lease_json);
  const lease = store[actorId];
  if (!lease) return undefined;
  const { isLive } = db
    .prepare("SELECT (? > datetime('now')) AS isLive")
    .get(lease.expiresAt) as unknown as { isLive: number };
  if (!isLive) return undefined;
  return lease;
}

/** Decrements the caller's lease turnsLeft by one (floor 0), if a live lease exists. Silent no-op otherwise. */
function decrementLease(db: ReturnType<typeof getDb>, threadId: string, actorId: string): void {
  const t = db.prepare("SELECT lease_json FROM threads WHERE id = ?").get(threadId) as unknown as
    | { lease_json: string | null }
    | undefined;
  if (!t) return;
  const store = parseLeaseStore(t.lease_json);
  const lease = store[actorId];
  if (!lease) return;
  lease.turnsLeft = Math.max(0, lease.turnsLeft - 1);
  db.prepare("UPDATE threads SET lease_json = ? WHERE id = ?").run(JSON.stringify(store), threadId);
}
