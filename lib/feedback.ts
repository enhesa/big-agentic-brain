import { randomUUID } from "node:crypto";
import { config } from "./config";
import { getDb, inTransaction } from "./db";
import { audit } from "./audit";
import { emit } from "./events";
import { redact, assertMaxLength, assertRawLength } from "./redact";
import { normalizeTokens, quoteFtsToken, similarityScore, DUPLICATE_THRESHOLD } from "./similarity";
import { ConflictError, ForbiddenError, NotFoundError, TooManyRequestsError, ValidationError } from "./errors";
import type { SimilarLearning } from "./learnings";
import type { AuditVia } from "./types";

/**
 * Feedback about BAB itself (docs/spec.md "Feedback"): agents and people file bugs, ideas,
 * improvements and questions, vote on each other's, and maintainers triage them. The point
 * is a self-healing loop, so the write path is deliberately cheap for agents (autopilot
 * posting) and guarded against noise: a duplicate check, a daily cap and redaction.
 */

export const FEEDBACK_KINDS = ["bug", "idea", "improvement", "question"] as const;
export const FEEDBACK_AREAS = ["memory", "messages", "reminders", "notifications", "hooks", "plugin", "mcp", "web", "other"] as const;
export const FEEDBACK_STATUSES = ["open", "planned", "done", "wontfix", "duplicate"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export type FeedbackSource = "agent" | "human";

const TITLE_MAX = 160;
const BODY_MAX = 8000;
const COMMENT_MAX = 4000;
const NOTE_MAX = 1000;
const CLIENT_VERSION_MAX = 80;
/** New feedback items per author per UTC day (was 5): a guard against a loop, not a quota. */
export const FEEDBACK_DAILY_LIMIT = 50;
export const FEEDBACK_LIST_LIMIT_DEFAULT = 10;
export const FEEDBACK_LIST_LIMIT_MAX = 50;
/** What a list shows when no status is asked for: work that still needs attention. */
const DEFAULT_STATUSES: FeedbackStatus[] = ["open", "planned"];
/** Closed items are not duplicate candidates: re-reporting something that was fixed is legitimate. */
const DUPLICATE_SCAN_STATUSES = "('open','planned')";
const FTS_TOKEN_CAP = 20;
const FTS_CANDIDATE_LIMIT = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Feedback ids are UUIDs; anything else reaching a link or a query is rejected first. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export interface FeedbackActor {
  id: string;
  name?: string | null;
  email?: string | null;
}

export interface FeedbackRow {
  id: string;
  author_id: string;
  source: FeedbackSource;
  kind: FeedbackKind;
  area: FeedbackArea;
  title: string;
  body: string;
  status: FeedbackStatus;
  duplicate_of: string | null;
  client_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeedbackSummary extends FeedbackRow {
  votes: number;
  commentCount: number;
  authorName: string | null;
}

export interface FeedbackComment {
  id: string;
  feedback_id: string;
  author_id: string;
  authorName: string | null;
  body: string;
  kind: "comment" | "status";
  created_at: string;
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

// ------------------------------------------------------------------ maintainers

/** Long-form emails in BAB_MAINTAINERS, lowercased. Read on every call so a config change needs no restart. */
function maintainerIds(): Set<string> {
  return config().identity.maintainers;
}

export function isMaintainer(userId: string): boolean {
  return maintainerIds().has(userId.trim().toLowerCase());
}

/** The ids in BAB_MAINTAINERS, sorted: who decides about a flagged standard or decision (bab_people shows them). */
export function maintainerIdList(): string[] {
  return [...maintainerIds()].sort();
}

export function assertMaintainer(userId: string, what = "change a feedback status") {
  const ids = maintainerIds();
  // No default and no "everyone": an unset list must fail loudly instead of opening triage to all.
  if (ids.size === 0) throw new ForbiddenError("BAB_MAINTAINERS is not configured");
  if (!ids.has(userId.trim().toLowerCase())) throw new ForbiddenError(`Only maintainers can ${what}`);
}

// ------------------------------------------------------------------ reads

const SUMMARY_SELECT = `
  SELECT f.*,
    (SELECT COUNT(*) FROM feedback_votes v WHERE v.feedback_id = f.id) AS votes,
    (SELECT COUNT(*) FROM feedback_comments c WHERE c.feedback_id = f.id AND c.kind = 'comment') AS commentCount,
    u.name AS authorName
  FROM feedback f LEFT JOIN users u ON u.id = f.author_id`;

function summaryById(id: string): FeedbackSummary | undefined {
  return getDb().prepare(`${SUMMARY_SELECT} WHERE f.id = ?`).get(id) as unknown as FeedbackSummary | undefined;
}

function requireSummary(id: string): FeedbackSummary {
  const item = summaryById(id);
  if (!item) throw new NotFoundError("Feedback not found");
  return item;
}

export interface ListFeedbackFilters {
  /** One status, a comma-separated list, an array, or "all". Default: open and planned. */
  status?: string | string[];
  kind?: string;
  area?: string;
  author?: string;
  q?: string;
  sort?: "top" | "new";
  limit?: number;
  offset?: number;
}

export interface FeedbackPage {
  items: FeedbackSummary[];
  total: number;
  nextOffset: number | null;
}

function statusFilter(raw: string | string[] | undefined): FeedbackStatus[] | null {
  if (raw === undefined || raw === "") return DEFAULT_STATUSES;
  const parts = (Array.isArray(raw) ? raw : raw.split(",")).map((p) => p.trim()).filter(Boolean);
  if (parts.includes("all")) return null;
  return parts.map((p) => oneOf("status", p, FEEDBACK_STATUSES));
}

export function list(filters: ListFeedbackFilters = {}): FeedbackPage {
  const db = getDb();
  const statuses = statusFilter(filters.status);
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (statuses) {
    clauses.push(`f.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (filters.kind) {
    clauses.push("f.kind = ?");
    params.push(oneOf("kind", filters.kind, FEEDBACK_KINDS));
  }
  if (filters.area) {
    clauses.push("f.area = ?");
    params.push(oneOf("area", filters.area, FEEDBACK_AREAS));
  }
  if (filters.author) {
    clauses.push("f.author_id = ?");
    params.push(filters.author);
  }

  // Free text: every term first, any term when that matches nothing (same idea as bab_search).
  const tokens = Array.from(new Set(normalizeTokens(filters.q ?? "")));
  let textClause: string | null = null;
  let textParam: string | null = null;
  const textWhere = (clause: string) => `${clause ? `${clause} AND ` : ""}f.rowid IN (SELECT rowid FROM feedback_fts WHERE feedback_fts MATCH ?)`;
  const whereBase = clauses.join(" AND ");
  const count = (where: string, extra: string[]) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM feedback f ${where ? `WHERE ${where}` : ""}`).get(...params, ...extra) as { n: number }).n;

  let total: number;
  if (tokens.length > 0) {
    const all = tokens.map(quoteFtsToken).join(" ");
    textClause = textWhere(whereBase);
    textParam = all;
    total = count(textClause, [all]);
    if (total === 0 && tokens.length > 1) {
      textParam = tokens.map(quoteFtsToken).join(" OR ");
      total = count(textClause, [textParam]);
    }
  } else {
    total = count(whereBase, []);
  }

  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? FEEDBACK_LIST_LIMIT_DEFAULT) || FEEDBACK_LIST_LIMIT_DEFAULT, 1), FEEDBACK_LIST_LIMIT_MAX);
  const offset = Math.max(Math.trunc(filters.offset ?? 0) || 0, 0);
  const order = filters.sort === "new" ? "f.created_at DESC, f.rowid DESC" : "votes DESC, f.created_at DESC, f.rowid DESC";
  const where = textClause ?? whereBase;

  const items = db
    .prepare(`${SUMMARY_SELECT} ${where ? `WHERE ${where}` : ""} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, ...(textParam ? [textParam] : []), limit, offset) as unknown as FeedbackSummary[];

  return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
}

export function get(id: string): { item: FeedbackSummary; comments: FeedbackComment[] } | undefined {
  const item = summaryById(id);
  if (!item) return undefined;
  const comments = getDb()
    .prepare(
      `SELECT c.*, u.name AS authorName FROM feedback_comments c
       LEFT JOIN users u ON u.id = c.author_id
       WHERE c.feedback_id = ? ORDER BY c.created_at, c.rowid`,
    )
    .all(id) as unknown as FeedbackComment[];
  return { item, comments };
}

// ------------------------------------------------------------------ writes

export interface CreateFeedbackInput {
  authorId: string;
  source: FeedbackSource;
  kind: FeedbackKind;
  area: FeedbackArea;
  title: string;
  body: string;
  clientVersion?: string | null;
  /** Bypasses the duplicate check once the caller has seen the candidates. */
  confirmNotDuplicate?: boolean;
}

function findDuplicates(title: string, body: string): SimilarLearning[] {
  const tokens = Array.from(new Set([...normalizeTokens(title), ...normalizeTokens(body)].slice(0, FTS_TOKEN_CAP)));
  if (tokens.length === 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT f.id, f.title, f.body, f.author_id, f.status, f.created_at, u.name AS authorName
       FROM feedback_fts
       CROSS JOIN feedback f ON f.rowid = feedback_fts.rowid
       LEFT JOIN users u ON u.id = f.author_id
       WHERE feedback_fts MATCH ? AND f.status IN ${DUPLICATE_SCAN_STATUSES}
       ORDER BY bm25(feedback_fts), f.rowid
       LIMIT ?`,
    )
    .all(tokens.map(quoteFtsToken).join(" OR "), FTS_CANDIDATE_LIMIT) as unknown as {
    id: string;
    title: string;
    body: string;
    author_id: string;
    status: string;
    created_at: string;
    authorName: string | null;
  }[];

  return rows
    .map((r) => ({ r, score: similarityScore({ title: r.title, body: r.body }, { title, body }) }))
    .filter(({ score }) => score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ r, score }) => ({
      id: r.id,
      title: r.title,
      score,
      author_id: r.author_id,
      authorName: r.authorName,
      tags: [],
      created_at: r.created_at,
      // ConflictError carries the learnings candidate shape; status is informational only.
      status: r.status as SimilarLearning["status"],
      verdict: "duplicate" as const,
    }));
}

export function create(input: CreateFeedbackInput, via: AuditVia = "mcp"): FeedbackSummary {
  const db = getDb();

  const kind = oneOf("kind", input.kind, FEEDBACK_KINDS);
  const area = oneOf("area", input.area, FEEDBACK_AREAS);
  const source = oneOf("source", input.source, ["agent", "human"] as const);

  assertRawLength("title", input.title, TITLE_MAX);
  assertRawLength("body", input.body, BODY_MAX);
  const title = redact(input.title.trim());
  const body = redact(input.body.trim());
  if (!title || !body) throw new ValidationError("title and body are required");
  assertMaxLength("title", title, TITLE_MAX);
  assertMaxLength("body", body, BODY_MAX);

  const clientVersion = input.clientVersion ? redact(input.clientVersion.trim().slice(0, CLIENT_VERSION_MAX)) || null : null;

  const today = db
    .prepare("SELECT COUNT(*) AS n FROM feedback WHERE author_id = ? AND date(created_at) = date('now')")
    .get(input.authorId) as { n: number };
  if (today.n >= FEEDBACK_DAILY_LIMIT) {
    throw new TooManyRequestsError("Daily feedback limit reached: vote on or comment on an existing item instead");
  }

  const id = randomUUID();
  let overridden: string[] = [];
  const duplicates = findDuplicates(title, body);
  if (duplicates.length > 0) {
    if (input.confirmNotDuplicate !== true) {
      audit(db, input.authorId, "create_rejected_duplicate", "feedback", id, via, {
        details: { candidateIds: duplicates.map((d) => d.id) },
      });
      throw new ConflictError("Looks like a duplicate of an open item: vote on it or add a comment instead", duplicates);
    }
    overridden = duplicates.map((d) => d.id);
  }

  db.prepare(
    `INSERT INTO feedback (id, author_id, source, kind, area, title, body, client_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.authorId, source, kind, area, title, body, clientVersion);

  audit(db, input.authorId, "create", "feedback", id, via, {
    details: overridden.length > 0 ? { overriddenCandidateIds: overridden } : undefined,
  });
  emit("feedback.created", id, { id, title, kind });
  return requireSummary(id);
}

/** One vote per identity; the author's own vote and a repeat are no-ops (changed: false). */
export function vote(feedbackId: string, voterId: string, via: AuditVia = "mcp"): { item: FeedbackSummary; changed: boolean } {
  const db = getDb();
  const item = requireSummary(feedbackId);
  if (item.author_id === voterId) return { item, changed: false };

  const res = db.prepare("INSERT OR IGNORE INTO feedback_votes (feedback_id, voter_id) VALUES (?, ?)").run(feedbackId, voterId);
  const changed = Number(res.changes) > 0;
  if (changed) {
    audit(db, voterId, "vote", "feedback", feedbackId, via);
    emit("feedback.updated", feedbackId, { id: feedbackId, title: item.title });
  }
  return { item: requireSummary(feedbackId), changed };
}

export function comment(feedbackId: string, authorId: string, text: string, via: AuditVia = "mcp"): FeedbackComment {
  const db = getDb();
  const item = requireSummary(feedbackId);
  assertRawLength("comment", text, COMMENT_MAX);
  const body = redact(text.trim());
  if (!body) throw new ValidationError("comment is required");
  assertMaxLength("comment", body, COMMENT_MAX);

  const id = randomUUID();
  db.prepare("INSERT INTO feedback_comments (id, feedback_id, author_id, body) VALUES (?, ?, ?, ?)").run(id, feedbackId, authorId, body);
  audit(db, authorId, "comment", "feedback", id, via, { details: { feedbackId } });
  emit("feedback.updated", feedbackId, { id: feedbackId, title: item.title });
  return get(feedbackId)!.comments.find((c) => c.id === id)!;
}

export interface SetStatusOptions {
  note?: string | null;
  duplicateOf?: string | null;
}

/**
 * Maintainers only. Every change leaves a "status: X -> Y" record (plus the optional note)
 * in the thread, so the history is on the page. Marking a duplicate moves its votes onto
 * the original, without doubling anyone and without counting the original's own author.
 */
export function setStatus(
  feedbackId: string,
  actor: FeedbackActor,
  status: FeedbackStatus,
  options: SetStatusOptions = {},
  via: AuditVia = "mcp",
): FeedbackSummary {
  const db = getDb();
  assertMaintainer(actor.id);
  const next = oneOf("status", status, FEEDBACK_STATUSES);
  const item = requireSummary(feedbackId);
  if (item.status === next && next !== "duplicate") throw new ConflictError(`Feedback is already ${next}`);

  const note = options.note?.trim() ?? "";
  if (note) {
    assertRawLength("note", note, NOTE_MAX);
    assertMaxLength("note", redact(note), NOTE_MAX);
  }

  let duplicateOf: string | null = null;
  if (next === "duplicate") {
    if (!options.duplicateOf) throw new ValidationError("duplicateOf is required when status is duplicate");
    if (options.duplicateOf === feedbackId) throw new ValidationError("An item cannot be a duplicate of itself");
    const target = summaryById(options.duplicateOf);
    if (!target) throw new NotFoundError("duplicateOf points at an item that was not found");
    if (target.status === "duplicate") throw new ValidationError("duplicateOf points at an item that is itself a duplicate");
    duplicateOf = target.id;
  }

  const text = [`status: ${item.status} -> ${next}`, duplicateOf ? `duplicate of ${duplicateOf}` : "", note ? redact(note) : ""]
    .filter(Boolean)
    .join("\n");

  inTransaction(db, () => {
    db.prepare("UPDATE feedback SET status = ?, duplicate_of = ?, updated_at = datetime('now') WHERE id = ?").run(next, duplicateOf, feedbackId);
    if (duplicateOf) {
      db.prepare(
        `INSERT OR IGNORE INTO feedback_votes (feedback_id, voter_id, created_at)
         SELECT ?, voter_id, created_at FROM feedback_votes
         WHERE feedback_id = ? AND voter_id != (SELECT author_id FROM feedback WHERE id = ?)`,
      ).run(duplicateOf, feedbackId, duplicateOf);
      db.prepare("DELETE FROM feedback_votes WHERE feedback_id = ?").run(feedbackId);
    }
    db.prepare("INSERT INTO feedback_comments (id, feedback_id, author_id, body, kind) VALUES (?, ?, ?, ?, 'status')").run(
      randomUUID(),
      feedbackId,
      actor.id,
      text,
    );
    audit(db, actor, "status", "feedback", feedbackId, via, { details: { from: item.status, to: next, duplicateOf } });
  });

  emit("feedback.updated", feedbackId, { id: feedbackId, title: item.title, kind: next });
  return requireSummary(feedbackId);
}

// ------------------------------------------------------------------ maintainer nudge

/**
 * The one line a maintainer's session hears when items arrived since they last looked
 * (app/api/hook/route.ts). Counts only: that route is unauthenticated, so no titles.
 * Their own posts are not news to them. Null when nothing is new, for a non-maintainer,
 * and while BAB_MAINTAINERS is unset. Recording the look is part of asking, so the same
 * items are never announced twice.
 */
export function maintainerFeedbackNudge(ownerId: string): string | null {
  if (!isMaintainer(ownerId)) return null;
  const db = getDb();
  const seen = db.prepare("SELECT seen_at FROM maintainer_feedback_seen WHERE owner_id = ?").get(ownerId) as
    | { seen_at: string }
    | undefined;

  // First ever look: everything still open counts as new, then the marker starts.
  const { n } = (
    seen
      ? db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE created_at > ? AND author_id != ?").get(seen.seen_at, ownerId)
      : db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'open' AND author_id != ?").get(ownerId)
  ) as { n: number };

  db.prepare(
    `INSERT INTO maintainer_feedback_seen (owner_id, seen_at) VALUES (?, datetime('now'))
     ON CONFLICT(owner_id) DO UPDATE SET seen_at = excluded.seen_at`,
  ).run(ownerId);

  if (n === 0) return null;
  return `Big Agentic Brain: ${n} new feedback item${n === 1 ? "" : "s"} about BAB since you last looked. Call bab_feedback with action list to triage.`;
}
