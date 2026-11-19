import { randomUUID } from "node:crypto";
import { getDb, inTransaction } from "./db";
import { audit } from "./audit";
import { emit } from "./events";
import { redact, assertMaxLength, assertRawLength } from "./redact";
import { getUsersByIds } from "./users";
import { deliveryFor, groupDelivery, type Delivery } from "./delivery";
import { NotFoundError, ForbiddenError, ValidationError } from "./errors";
import { isMaintainer } from "./feedback";
import type {
  AuditVia,
  MessageKind,
  MessageRequest,
  MessageRow,
  RequestAnswer,
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
export const REQUEST_OPTIONS_MIN = 2;
export const REQUEST_OPTIONS_MAX = 6;
export const REQUEST_OPTION_MAX = 60;
export const ANSWER_NOTE_MAX = 300;
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

  if (record.options !== undefined) result.options = validateOptions(record.options);

  return result;
}

/**
 * The answer choices of a request: 2 to 6 short, unique strings. A choice that redaction would
 * change is refused, not silently altered: the sender's agent must see the text a recipient picks.
 */
function validateOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ValidationError("request.options must be an array of strings");
  if (raw.length < REQUEST_OPTIONS_MIN || raw.length > REQUEST_OPTIONS_MAX) {
    throw new ValidationError(`request.options must have ${REQUEST_OPTIONS_MIN} to ${REQUEST_OPTIONS_MAX} entries`);
  }
  const options: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ValidationError("request.options entries must be non-empty strings");
    }
    const option = entry.trim();
    if (option.length > REQUEST_OPTION_MAX) {
      throw new ValidationError(`request.options entries must be ${REQUEST_OPTION_MAX} characters or fewer`);
    }
    if (redact(option) !== option) {
      throw new ValidationError("request.options entries must not contain secrets or personal data");
    }
    if (options.some((o) => o.toLowerCase() === option.toLowerCase())) {
      throw new ValidationError("request.options entries must be unique");
    }
    options.push(option);
  }
  return options;
}

/**
 * Records `actorId`'s pick on a request with options, in the request JSON of the message (no
 * table: the pick travels with the message everywhere the request is read). Only a recipient may
 * answer, never the sender. One answer per person: a later pick replaces theirs and takes the new
 * time. In a group message each recipient answers for themselves. `option` is the 0-based index
 * into `request.options`. `note` is optional, redacted, at most ANSWER_NOTE_MAX characters.
 *
 * The answer also tells the sender the way a reply does: a short reply lands in the thread, so it
 * shows up as unread in the sender's inbox.
 */
export function answerRequest(
  messageId: string,
  actorId: string,
  input: { option: unknown; note?: unknown },
  via: AuditVia = "ui",
): { threadId: string; answer: RequestAnswer; changed: boolean } {
  const db = getDb();
  const index = typeof input.option === "string" && /^\d{1,2}$/.test(input.option.trim()) ? Number(input.option) : input.option;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new ValidationError("option must be the number of one of the request's options");
  }
  let note: string | undefined;
  if (input.note !== undefined && input.note !== null && input.note !== "") {
    if (typeof input.note !== "string") throw new ValidationError("note must be a string");
    const trimmed = input.note.trim();
    if (trimmed.length > ANSWER_NOTE_MAX) throw new ValidationError(`note must be ${ANSWER_NOTE_MAX} characters or fewer`);
    const clean = redact(trimmed);
    if (clean.length > ANSWER_NOTE_MAX) throw new ValidationError(`note must be ${ANSWER_NOTE_MAX} characters or fewer`);
    if (clean) note = clean;
  }

  const result = inTransaction(db, () => {
    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(messageId) as unknown as MessageRow | undefined;
    if (!row) throw new NotFoundError("Message not found");
    const isRecipient =
      db.prepare("SELECT 1 AS n FROM message_recipients WHERE message_id = ? AND user_id = ?").get(messageId, actorId) !== undefined;
    if (row.from_id === actorId || !isRecipient) throw new ForbiddenError("Only a recipient can answer this question");
    const request = parseRequest(row.request);
    const options = request?.options;
    if (!request || !options) throw new ValidationError("This message has no options to answer");
    if (index >= options.length) throw new ValidationError("option must be the number of one of the request's options");

    const { now } = db.prepare("SELECT datetime('now') AS now").get() as unknown as { now: string };
    const answer: RequestAnswer = { by: actorId, option: options[index], ...(note ? { note } : {}), at: now };
    const previous = (request.answers ?? []).find((a) => a.by === actorId);
    request.answers = [...(request.answers ?? []).filter((a) => a.by !== actorId), answer];
    db.prepare("UPDATE messages SET request = ? WHERE id = ?").run(JSON.stringify(request), messageId);
    audit(db, actorId, "answer", "message", messageId, via, { details: { option: index, replaced: previous !== undefined } });
    return { threadId: row.thread_id, answer, changed: previous !== undefined };
  });

  send(
    {
      fromId: actorId,
      threadId: result.threadId,
      body: `${result.changed ? "Changed my answer" : "Answer"}: ${result.answer.option}${note ? ` (${note})` : ""}`,
    },
    via,
  );
  return result;
}

/** Most people one message may go to, not counting the sender. A constant, so error texts build from it. */
export const MAX_RECIPIENTS = 10;
/** Longest address accepted in `to` (the longest valid email address). */
const ADDRESS_MAX = 320;
/** A `to` list longer than this is refused before any work, duplicates or not. */
const RAW_TO_LIST_MAX = 50;

export interface SendInput {
  fromId: string;
  /**
   * Recipient id (email), or a list of them for a group. A string is one address, never split.
   * Optional on a reply: a reply reaches every other participant.
   */
  to?: string | string[];
  body: string;
  subject?: string;
  threadId?: string;
  kind?: MessageKind;
  /** True when the request carried `X-Bab-Lease: 1` — decrements the sender's lease on this thread. */
  useLease?: boolean;
  /** A structured collaborative request (review-pr, pair, question, ...) attached to this message. */
  request?: MessageRequest;
}

/**
 * Reads a caller's raw `to` (a JSON body or MCP arguments) into SendInput.to: a string or a list.
 * Entries are checked in send(). Absent is undefined.
 */
export function toArgument(raw: unknown): string | string[] | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw as string[];
  throw new ValidationError("to must be an email or a list of emails");
}

/** Whether a raw `to` names anyone: a non-blank string or any list (an empty list is refused in send()). */
export function hasTo(to: string | string[] | undefined): boolean {
  return Array.isArray(to) || (typeof to === "string" && to.trim() !== "");
}

/** The addresses in `to`, trimmed, lowercased and without duplicates, in the order given. */
function parseRecipients(to: string | string[] | undefined): string[] {
  if (to == null) return [];
  if (typeof to === "string") {
    const one = to.trim().toLowerCase();
    return one ? [one] : [];
  }
  if (to.length === 0) throw new ValidationError("to must name at least one recipient");
  if (to.length > RAW_TO_LIST_MAX) throw new ValidationError(`to takes at most ${MAX_RECIPIENTS} recipients`);
  const out: string[] = [];
  for (const entry of to) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ValidationError("to entries must be non-empty email strings");
    }
    const address = entry.trim().toLowerCase();
    if (address.length > ADDRESS_MAX) {
      throw new ValidationError(`to entries must be ${ADDRESS_MAX} characters or fewer`);
    }
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

/** Whether actorId is a participant of the thread (thread_participants, migration v59). */
function isParticipant(db: ReturnType<typeof getDb>, threadId: string, actorId: string): boolean {
  return db.prepare("SELECT 1 AS n FROM thread_participants WHERE thread_id = ? AND user_id = ?").get(threadId, actorId) !== undefined;
}

/** The participant ids of a thread, in the order they joined (the creator first). */
function participantIds(db: ReturnType<typeof getDb>, threadId: string): string[] {
  return (
    db.prepare("SELECT user_id FROM thread_participants WHERE thread_id = ? ORDER BY added_at, rowid").all(threadId) as unknown as {
      user_id: string;
    }[]
  ).map((r) => r.user_id);
}

/**
 * Everyone in a thread, with names, in the order they joined. Every participant may see this list.
 * Callers check participation first.
 */
export function participantsOf(threadId: string): ThreadParticipant[] {
  const ids = participantIds(getDb(), threadId);
  const users = getUsersByIds(ids);
  return ids.map((id) => ({ id, name: users.get(id)?.name ?? null, email: users.get(id)?.email ?? null }));
}

/** One recipient of a sent message, with what BAB knows about whether they can see it now. */
export interface SentRecipient {
  id: string;
  name: string | null;
  delivery: Delivery;
}

/**
 * Who a message goes to. A new thread goes to the people named in `to` (the sender dropped from a
 * list with others; only the sender is a note to self). A reply goes to every other participant:
 * `to` must name participants but does not narrow a group. In a thread of two, an explicit `to`
 * keeps today's meaning, so 1:1 threads behave exactly as before group messages.
 */
function resolveRecipients(
  db: ReturnType<typeof getDb>,
  input: SendInput,
  named: string[],
): string[] {
  const single = !Array.isArray(input.to);
  const withoutSender = (ids: string[]) => {
    const others = ids.filter((id) => id !== input.fromId);
    return others.length > 0 ? others : [input.fromId];
  };

  if (input.threadId) {
    const members = participantIds(db, input.threadId);
    for (const id of named) {
      if (!members.includes(id)) throw new ForbiddenError("Recipient is not a participant of this thread");
    }
    if (members.length <= 2 && named.length > 0) return single ? named : withoutSender(named);
    return withoutSender(members);
  }

  // The routes answer NEW_THREAD_NEEDS_TO before this; a direct call keeps its old message.
  if (named.length === 0) throw new ValidationError("Unknown recipient");
  const recipients = single ? named : withoutSender(named);
  if (recipients.length > MAX_RECIPIENTS) {
    throw new ValidationError(`to takes at most ${MAX_RECIPIENTS} recipients`);
  }
  const known = getUsersByIds(recipients);
  const unknown = recipients.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    if (single) throw new ValidationError("Unknown recipient");
    throw new ValidationError(
      `Unknown recipient${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Nothing was sent.`,
    );
  }
  return recipients;
}

export function send(
  input: SendInput,
  via: AuditVia = "ui",
): {
  thread: ThreadRow;
  message: Omit<MessageRow, "request"> & { request: MessageRequest | null };
  /**
   * What BAB knows about whether the recipient can see it now (lib/delivery.ts); never "read".
   * For a group, a summary of `recipients[].delivery`.
   */
  delivery: Delivery;
  /** Everyone this message went to, in order; to_id on the message is the first of them. */
  recipients: SentRecipient[];
} {
  const db = getDb();

  let threadId = input.threadId;
  const named = parseRecipients(input.to);
  if (threadId) {
    const existing = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as | ThreadRow
      | undefined;
    if (!existing) throw new NotFoundError("Thread not found");
    if (!isParticipant(db, threadId, input.fromId)) {
      throw new ForbiddenError("Not a participant of this thread");
    }
  }

  // A note to yourself is fine: it lands in your own inbox like any other message.
  const recipientIds = resolveRecipients(db, input, named);
  const recipientUsers = getUsersByIds(recipientIds);
  const to = recipientIds[0];

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
      const join = db.prepare("INSERT OR IGNORE INTO thread_participants (thread_id, user_id) VALUES (?, ?)");
      for (const id of [input.fromId, ...recipientIds]) join.run(finalThreadId, id);
    }

    // to_id keeps the first recipient, so readers of the one-recipient columns still work.
    db.prepare(
      `INSERT INTO messages (id, thread_id, from_id, to_id, body, kind, request)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(messageId, finalThreadId, input.fromId, to, body, kind, requestJson);
    const addRecipient = db.prepare("INSERT INTO message_recipients (message_id, user_id) VALUES (?, ?)");
    for (const id of recipientIds) addRecipient.run(messageId, id);

    const details = recipientIds.length > 1 ? { kind, recipients: recipientIds.length } : { kind };
    audit(db, input.fromId, "send", "message", messageId, via, { details });

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
  // LiveUpdates uses no payload field.
  emit("message.created", finalThreadId, {
    id: messageId,
    kind,
  });

  const recipients: SentRecipient[] = recipientIds.map((id) => ({
    id,
    name: recipientUsers.get(id)?.name ?? null,
    delivery: deliveryFor(recipientUsers.get(id), input.fromId),
  }));
  const delivery =
    recipients.length === 1 ? recipients[0].delivery : groupDelivery(recipients.map((r) => r.delivery));
  return { thread, message: withRequest(message), delivery, recipients };
}

export interface InboxThread {
  thread: ThreadRow;
  /**
   * The thread's last message. `to_id` is its first recipient; `read_at` is the caller's own read
   * time when the caller received it, and when the caller sent it, the time the last recipient read
   * it (null until all have), the same as an opened thread.
   */
  lastMessage: Omit<MessageRow, "request"> & { request: MessageRequest | null };
  unreadCount: number;
  /**
   * Everyone in the thread, the caller included, in the order they joined. Only with
   * `participants: true`: a whole inbox of names is work most callers do not need.
   */
  participants?: ThreadParticipant[];
}

/**
 * Threads where the user is a participant (sent to or received), newest
 * activity first. Single set-based query (CTEs for "my threads", each
 * thread's last message by rowid, and per-thread unread counts) instead of
 * a per-thread round trip. `unreadOnly`, `limit` and `offset` filter and page in SQL, so a
 * caller that shows one page never loads the whole inbox. `participants` adds each thread's
 * participant list (participantsForThreads).
 */
export function inboxFor(
  userId: string,
  opts: { unreadOnly?: boolean; limit?: number; offset?: number; participants?: boolean } = {},
): InboxThread[] {
  const db = getDb();
  const where = opts.unreadOnly ? " AND COALESCE(u.n, 0) > 0" : "";
  const page = opts.limit == null ? "" : " LIMIT ? OFFSET ?";
  const params: (string | number)[] = [userId, userId, userId, userId];
  if (opts.limit != null) params.push(Math.max(0, Math.trunc(opts.limit)), Math.max(0, Math.trunc(opts.offset ?? 0)));

  const rows = db
    .prepare(
      `WITH my_threads AS (
         SELECT thread_id FROM thread_participants WHERE user_id = ?
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
         SELECT m.thread_id, COUNT(*) AS n
         FROM message_recipients r
         JOIN messages m ON m.id = r.message_id
         WHERE r.user_id = ? AND r.read_at IS NULL
         GROUP BY m.thread_id
       )
       SELECT
         t.id AS thread_id, t.subject AS thread_subject, t.created_by AS thread_created_by,
         t.created_at AS thread_created_at,
         lm.id AS msg_id, lm.from_id AS msg_from_id, lm.to_id AS msg_to_id,
         lm.body AS msg_body,
         CASE
           WHEN mr.user_id IS NOT NULL THEN mr.read_at
           WHEN lm.from_id = ? THEN (
             SELECT CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(r2.read_at) THEN MAX(r2.read_at) END
             FROM message_recipients r2 WHERE r2.message_id = lm.id
           )
           ELSE lm.read_at
         END AS msg_read_at,
         lm.created_at AS msg_created_at,
         lm.kind AS msg_kind, lm.request AS msg_request,
         COALESCE(u.n, 0) AS unread_count
       FROM threads t
       JOIN last_msg lm ON lm.thread_id = t.id
       LEFT JOIN message_recipients mr ON mr.message_id = lm.id AND mr.user_id = ?
       LEFT JOIN unread u ON u.thread_id = t.id
       WHERE t.id IN (SELECT thread_id FROM my_threads)${where}
       ORDER BY lm.created_at DESC, lm.rowid DESC${page}`,
    )
    .all(...params) as unknown as {
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

  const participants = opts.participants ? participantsForThreads(rows.map((r) => r.thread_id)) : null;

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
    ...(participants ? { participants: participants.get(r.thread_id) ?? [] } : {}),
  }));
}

/**
 * Participants with names for a set of threads, in one query per 500 ids (well under SQLite's
 * parameter limit), each list in the order people joined. Callers check participation first.
 */
export function participantsForThreads(threadIds: string[]): Map<string, ThreadParticipant[]> {
  const db = getDb();
  const out = new Map<string, ThreadParticipant[]>();
  const rows: { thread_id: string; user_id: string }[] = [];
  for (let i = 0; i < threadIds.length; i += 500) {
    const chunk = threadIds.slice(i, i + 500);
    rows.push(
      ...(db
        .prepare(
          `SELECT thread_id, user_id FROM thread_participants WHERE thread_id IN (${chunk.map(() => "?").join(",")})
           ORDER BY thread_id, added_at, rowid`,
        )
        .all(...chunk) as unknown as { thread_id: string; user_id: string }[]),
    );
  }
  const users = getUsersByIds([...new Set(rows.map((r) => r.user_id))]);
  for (const r of rows) {
    const u = users.get(r.user_id);
    const list = out.get(r.thread_id) ?? [];
    list.push({ id: r.user_id, name: u?.name ?? null, email: u?.email ?? null });
    out.set(r.thread_id, list);
  }
  return out;
}

/**
 * How many threads inboxFor(userId) would list, and how many of them hold unread messages,
 * without loading any message body. The same thread set as inboxFor: a thread the user is in
 * that has at least one message.
 */
export function inboxCounts(userId: string): { threads: number; unreadThreads: number } {
  const row = getDb()
    .prepare(
      `WITH my_threads AS (
         SELECT tp.thread_id FROM thread_participants tp
         WHERE tp.user_id = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = tp.thread_id)
       ),
       unread AS (
         SELECT DISTINCT m.thread_id
         FROM message_recipients r
         JOIN messages m ON m.id = r.message_id
         WHERE r.user_id = ? AND r.read_at IS NULL
       )
       SELECT COUNT(*) AS threads,
              COALESCE(SUM(CASE WHEN t.id IN (SELECT thread_id FROM unread) THEN 1 ELSE 0 END), 0) AS unread_threads
       FROM threads t
       WHERE t.id IN (SELECT thread_id FROM my_threads)`,
    )
    .get(userId, userId) as unknown as { threads: number; unread_threads: number };
  return { threads: Number(row.threads), unreadThreads: Number(row.unread_threads) };
}

export function unreadCountFor(userId: string): number {
  const db = getDb();
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM message_recipients WHERE user_id = ? AND read_at IS NULL")
    .get(userId) as unknown as { n: number };
  return n;
}

/** A message row as exposed to API/UI consumers: `request` parsed, never the raw JSON string. */
export type ClientMessage = Omit<MessageRow, "request"> & { request: MessageRequest | null };

/**
 * One person a message went to. `readAt` is shown to the message's sender and to that person
 * only; every other participant sees null, so read receipts stay between sender and reader.
 */
export interface MessageRecipient {
  id: string;
  name: string | null;
  readAt: string | null;
}

/**
 * A message in an opened thread, with every recipient. `read_at` is the viewer's own read time on
 * a message they received; on one they sent, when the last recipient read it (null until all
 * have, which for one recipient is the stored value).
 */
export type ThreadMessage = ClientMessage & { recipients: MessageRecipient[] };

/** Every message of a thread, oldest first, with recipients and read state as `viewerId` may see them. */
function threadMessages(db: ReturnType<typeof getDb>, threadId: string, viewerId: string): ThreadMessage[] {
  const messages = db
    .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(threadId) as unknown as MessageRow[];
  const rows = db
    .prepare(
      `SELECT r.message_id, r.user_id, r.read_at FROM message_recipients r
       JOIN messages m ON m.id = r.message_id
       WHERE m.thread_id = ? ORDER BY r.rowid`,
    )
    .all(threadId) as unknown as { message_id: string; user_id: string; read_at: string | null }[];
  const users = getUsersByIds([...new Set(rows.map((r) => r.user_id))]);
  const byMessage = new Map<string, { user_id: string; read_at: string | null }[]>();
  for (const r of rows) {
    const list = byMessage.get(r.message_id) ?? [];
    list.push(r);
    byMessage.set(r.message_id, list);
  }

  return messages.map((m) => {
    const own = byMessage.get(m.id) ?? [];
    const isSender = m.from_id === viewerId;
    const mine = own.find((r) => r.user_id === viewerId);
    let readAt = m.read_at;
    if (mine) readAt = mine.read_at;
    else if (isSender && own.length > 0) {
      readAt = own.every((r) => r.read_at) ? (own.map((r) => r.read_at as string).sort().at(-1) ?? null) : null;
    } else if (own.length > 1) {
      // Neither sender nor recipient (a maintainer on /conversations): no one's read time in a group.
      readAt = null;
    }
    return {
      ...withRequest({ ...m, read_at: readAt }),
      recipients: own.map((r) => ({
        id: r.user_id,
        name: users.get(r.user_id)?.name ?? null,
        readAt: isSender || r.user_id === viewerId ? r.read_at : null,
      })),
    };
  });
}

export function thread(
  threadId: string,
  actorId: string,
): { thread: ThreadRow; messages: ThreadMessage[] } | undefined {
  const db = getDb();
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as | ThreadRow
    | undefined;
  if (!t) return undefined;
  if (!isParticipant(db, threadId, actorId)) return undefined;

  return { thread: t, messages: threadMessages(db, threadId, actorId) };
}

/**
 * Same lookup as thread(), but for the API: distinguishes "doesn't exist"
 * (404) from "exists, you're just not in it" (403) instead of collapsing
 * both into undefined.
 */
export function requireThreadForActor(
  threadId: string,
  actorId: string,
): { thread: ThreadRow; messages: ThreadMessage[] } {
  const db = getDb();
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as | ThreadRow
    | undefined;
  if (!t) throw new NotFoundError("Thread not found");
  if (!isParticipant(db, threadId, actorId)) {
    throw new ForbiddenError("Not a participant of this thread");
  }

  return { thread: t, messages: threadMessages(db, threadId, actorId) };
}

/**
 * Marks the user's own unread messages in the thread read (message_recipients), and mirrors that
 * into messages.read_at where the user is the first recipient, for readers of the old column.
 */
export function markRead(threadId: string, userId: string, via: AuditVia = "ui") {
  const db = getDb();
  const changed = inTransaction(db, () => {
    const result = db
      .prepare(
        `UPDATE message_recipients SET read_at = datetime('now')
         WHERE user_id = ? AND read_at IS NULL
           AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)`,
      )
      .run(userId, threadId);
    db.prepare(
      "UPDATE messages SET read_at = datetime('now') WHERE thread_id = ? AND to_id = ? AND read_at IS NULL",
    ).run(threadId, userId);
    const n = Number(result.changes ?? 0);
    // Nothing changed means nothing to record: a second click or a refresh must not add audit rows.
    if (n > 0) audit(db, userId, "read", "thread", threadId, via);
    return n;
  });
  if (changed > 0) emit("message.created", threadId, { id: threadId, kind: "read" });
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
      `SELECT thread_id, user_id AS id FROM thread_participants WHERE thread_id IN (${placeholders})
       ORDER BY thread_id, added_at, rowid`,
    )
    .all(...threadIds) as unknown as { thread_id: string; id: string }[];

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

export interface ViewerMessage extends ThreadMessage {
  fromName: string | null;
  fromEmail: string | null;
  /** The first recipient (to_id); `recipients` has everyone. */
  toName: string | null;
  toEmail: string | null;
}

/**
 * Thread + all its messages, chronologically, with sender/recipient names
 * and emails resolved, for the human-facing thread page. Only a participant
 * or a maintainer (BAB_MAINTAINERS) may read it: anyone else gets the same
 * ForbiddenError as requireThreadForActor(). A missing thread is undefined.
 */
export function threadForViewer(
  threadId: string,
  viewerId: string,
): { thread: ThreadRow; messages: ViewerMessage[] } | undefined {
  const db = getDb();
  const t = db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as unknown as | ThreadRow
    | undefined;
  if (!t) return undefined;
  if (!isParticipant(db, threadId, viewerId) && !isMaintainer(viewerId)) {
    throw new ForbiddenError("Not a participant of this thread");
  }

  const messages = threadMessages(db, threadId, viewerId);

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
      ...m,
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
