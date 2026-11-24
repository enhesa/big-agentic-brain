import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { parseDbTime } from "./dates";
import { verifyDueIds } from "./swarm-gc";
import type { LearningKind, LearningRow } from "./types";
import { readEvidence, type FlagEvidence } from "./evidence";
import { flagAnswerSql, freshnessFor } from "./freshness";

/**
 * Explicit, auditable validation of memories (docs/spec.md "Trust labels and validation history").
 *
 * - The history: every confirm, flag, keep, restore, retire and supersede is one row in
 *   `trust_events` (migration v58), never updated, with who, when, the note and whether the actor
 *   is the author. `votes` keeps one row per person and kind and the audit log is purged, so this
 *   table is the record. Shown on the memory page and in GET /api/learnings/:id (`history`).
 * - The label: a plain line for each memory where agents and people read it (search results, the
 *   hook, the memory list and page), from counts and dates only, never note text or names:
 *   "flagged by 1 (newest 2 days ago); not checked by anyone but its author". A memory nobody else
 *   has checked is `unchecked` from day one; after VERIFY_AFTER_DAYS without a check it is also
 *   due a check (`verify`, lib/swarm-gc.ts). The author's own keep or restore never counts as a check.
 *
 * This module imports no lib module that writes learnings, so lib/learnings.ts can import it.
 */

export const TRUST_EVENT_KINDS = [
  "confirm",
  "flag",
  "keep",
  "restore",
  "retire",
  "supersede",
  "archive",
  // Self-healing memory (lib/checks.ts): a person's answer to "Is this still true?", and a change
  // of who checks it. A non-author Yes is stored as a confirm, so recheck_yes is the author's own.
  "recheck_yes",
  "recheck_no",
  "recheck_unsure",
  "recheck_agent",
  "check_by_changed",
] as const;
export type TrustEventKind = (typeof TRUST_EVENT_KINDS)[number];

/** The newest events a memory page and GET /api/learnings/:id return. */
export const TRUST_HISTORY_LIMIT = 50;

/**
 * Appends one event. Call it inside the same transaction as the vote or status change it records,
 * next to the audit() call. `note` must already be normalized and redacted by the caller.
 */
export function recordTrustEvent(
  db: DatabaseSync,
  e: {
    learningId: string;
    actorId: string;
    kind: TrustEventKind;
    authorId: string;
    note?: string | null;
    relatedId?: string | null;
    /** Structured evidence on a flag or a correction (lib/evidence.ts), already validated and redacted. */
    evidence?: FlagEvidence | null;
  },
): void {
  db.prepare(
    "INSERT INTO trust_events (learning_id, actor_id, kind, by_author, note, related_id, evidence) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    e.learningId,
    e.actorId,
    e.kind,
    e.actorId.toLowerCase() === e.authorId.toLowerCase() ? 1 : 0,
    e.note ?? null,
    e.relatedId ?? null,
    e.evidence ? JSON.stringify(e.evidence) : null,
  );
}

export interface TrustEvent {
  kind: TrustEventKind;
  actorName: string;
  /** true when the author did it (a keep, restore, retire or correction of their own memory). */
  byAuthor: boolean;
  note: string | null;
  /** For a supersede: the memory that replaced this one. */
  related?: { id: string; title: string };
  /** SQLite datetime text (UTC). */
  at: string;
  /** Copied from older records by migration v58: the date is the newest one those records kept. */
  backfilled?: true;
  /** Structured evidence on a flag or a correction: failure, tried, saw, where. */
  evidence?: FlagEvidence;
}

/**
 * The validation history of one memory, newest first, at most `limit` events. Plain data: every
 * surface renders the notes as text. A deleted memory has none: its notes often paraphrase it.
 */
export function trustHistory(learningId: string, limit: number = TRUST_HISTORY_LIMIT): TrustEvent[] {
  const db = getDb();
  const row = db.prepare("SELECT status FROM learnings WHERE id = ?").get(learningId) as { status: string } | undefined;
  if (!row || row.status === "deleted") return [];
  const rows = db
    .prepare(
      `SELECT t.kind AS kind, t.by_author AS byAuthor, t.note AS note, t.at AS at, t.backfilled AS backfilled, t.evidence AS evidence,
              t.related_id AS relatedId, r.title AS relatedTitle, r.status AS relatedStatus,
              COALESCE(u.name, t.actor_id) AS actorName
       FROM trust_events t
       LEFT JOIN users u ON u.id = t.actor_id
       LEFT JOIN learnings r ON r.id = t.related_id
       WHERE t.learning_id = ?
       ORDER BY t.id DESC LIMIT ?`,
    )
    .all(learningId, limit) as Array<{
    kind: TrustEventKind;
    byAuthor: number;
    note: string | null;
    at: string;
    backfilled: number;
    evidence: string | null;
    relatedId: string | null;
    relatedTitle: string | null;
    relatedStatus: string | null;
    actorName: string;
  }>;
  return rows.map((r) => ({
    kind: r.kind,
    actorName: r.actorName,
    byAuthor: r.byAuthor === 1,
    note: r.note,
    ...(r.relatedId && r.relatedTitle != null && r.relatedStatus !== "deleted"
      ? { related: { id: r.relatedId, title: r.relatedTitle } }
      : {}),
    at: r.at,
    ...(r.backfilled === 1 ? { backfilled: true as const } : {}),
    ...(readEvidence(r.evidence) ? { evidence: readEvidence(r.evidence)! } : {}),
  }));
}

export interface TrustSummary {
  /**
   * Distinct people whose flag no later check answered: a confirm, keep or restore after the flag
   * by someone other than the author, or by a maintainer (flagAnswerSql in lib/freshness.ts; a tie
   * in the same second counts as before, like swarm-gc). The flags stay on record in the history
   * either way.
   */
  flags: number;
  /** The newest of those open flags. */
  lastFlagAt: string | null;
  /** Distinct people whose flag a later check answered. */
  answeredFlags: number;
  /** Distinct people other than the author who confirmed it. */
  confirmations: number;
  /** Newest check by someone other than the author: a confirm, keep or restore. */
  lastCheckedAt: string | null;
  /** Nobody but the author has ever confirmed, kept or restored it. */
  unchecked: boolean;
  /** Over VERIFY_AFTER_DAYS old and not checked by anyone else inside that window (search's `verify`). */
  verify: boolean;
  /** The line agents and people read. Counts and dates only. */
  label: string;
}

const DAY_MS = 86_400_000;

/** What trustFor needs of a memory. */
export type TrustRow = Pick<LearningRow, "id" | "created_at" | "author_id"> & { status: string };

function daysAgo(at: string, now: number): string {
  const d = Math.max(0, Math.floor((now - parseDbTime(at).getTime()) / DAY_MS));
  return d === 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
}

/** The label for one summary, see TrustSummary.label. */
export function trustLabel(s: Omit<TrustSummary, "label">, now: number = Date.now()): string {
  const parts: string[] = [];
  if (s.flags > 0) parts.push(`flagged by ${s.flags} (newest ${daysAgo(s.lastFlagAt!, now)})`);
  if (s.unchecked) parts.push("not checked by anyone but its author");
  else if (s.confirmations > 0) {
    parts.push(`confirmed by ${s.confirmations}, last checked ${daysAgo(s.lastCheckedAt!, now)}`);
  } else parts.push(`kept by a colleague, last checked ${daysAgo(s.lastCheckedAt!, now)}`);
  if (s.answeredFlags > 0) parts.push(`${s.answeredFlags === 1 ? "1 earlier flag" : `${s.answeredFlags} earlier flags`} answered by a later check`);
  if (s.verify) parts.push("due a check");
  return parts.join("; ");
}

/**
 * A short tag for the hook's one-line lists, or "" for a memory with no warning: "flagged 2x",
 * "unchecked", "due a check". The hook route has no sign-in, so counts only.
 */
export function trustTag(s: Pick<TrustSummary, "flags" | "unchecked" | "verify">): string {
  const parts: string[] = [];
  if (s.flags > 0) parts.push(`flagged ${s.flags}x`);
  if (s.unchecked) parts.push("unchecked");
  if (s.verify) parts.push("due a check");
  return parts.join(", ");
}

/**
 * The trust summary of each row, in three queries however many rows there are (the grouped votes,
 * the flags, and verifyDueIds). Votes by the author never count as a check; a maintainer's keep or
 * restore of their own memory still answers a flag on it (flagAnswerSql in lib/freshness.ts).
 */
export function trustFor(
  rows: Array<TrustRow>,
  now: number = Date.now(),
): Map<string, TrustSummary> {
  const out = new Map<string, TrustSummary>();
  if (rows.length === 0) return out;
  const db = getDb();
  const ids = [...new Set(rows.map((r) => r.id))];
  const marks = ids.map(() => "?").join(",");
  const votes = db
    .prepare(
      `SELECT v.learning_id AS id, v.kind AS kind, (lower(v.voter_id) = lower(l.author_id)) AS own,
              COUNT(DISTINCT lower(v.voter_id)) AS n, MAX(v.created_at) AS last
       FROM votes v JOIN learnings l ON l.id = v.learning_id
       WHERE v.learning_id IN (${marks}) AND v.kind IN ('confirm', 'keep', 'restore')
         AND ${flagAnswerSql("v", "l")}
       GROUP BY v.learning_id, v.kind, own`,
    )
    .all(...ids) as Array<{ id: string; kind: string; own: number | bigint; n: number | bigint; last: string }>;
  // One row per flag (votes keeps one per person), so each can be weighed against the newest check.
  const flagRows = db
    .prepare(`SELECT learning_id AS id, lower(voter_id) AS voter, created_at AS at FROM votes WHERE learning_id IN (${marks}) AND kind = 'flag'`)
    .all(...ids) as Array<{ id: string; voter: string; at: string }>;
  const flagsBy = new Map<string, Array<{ voter: string; at: string }>>();
  for (const f of flagRows) {
    if (!flagsBy.has(f.id)) flagsBy.set(f.id, []);
    flagsBy.get(f.id)!.push(f);
  }
  const by = new Map<string, Map<string, { n: number; last: string }>>();
  // The newest check that answers a flag (flagAnswerSql): any of the checks below, or a
  // maintainer's keep or restore of their own memory, which is not a check for the label.
  const answeredAt = new Map<string, string>();
  for (const v of votes) {
    if (v.last > (answeredAt.get(v.id) ?? "")) answeredAt.set(v.id, v.last);
    if (Number(v.own) === 1) continue;
    if (!by.has(v.id)) by.set(v.id, new Map());
    by.get(v.id)!.set(v.kind, { n: Number(v.n), last: v.last });
  }
  const due = verifyDueIds(db, rows, now);
  for (const r of rows) {
    const k = by.get(r.id) ?? new Map<string, { n: number; last: string }>();
    const checks = ["confirm", "keep", "restore"].map((kind) => k.get(kind)?.last).filter((x): x is string => !!x);
    const lastCheckedAt = checks.length > 0 ? checks.sort().at(-1)! : null;
    const flags = flagsBy.get(r.id) ?? [];
    const flagsAnsweredAt = answeredAt.get(r.id) ?? null;
    const open = flags.filter((f) => flagsAnsweredAt === null || f.at > flagsAnsweredAt);
    const openVoters = new Set(open.map((f) => f.voter));
    const answered = new Set(flags.map((f) => f.voter).filter((v) => !openVoters.has(v)));
    const base = {
      flags: openVoters.size,
      lastFlagAt: open.length > 0 ? open.map((f) => f.at).sort().at(-1)! : null,
      answeredFlags: answered.size,
      confirmations: k.get("confirm")?.n ?? 0,
      lastCheckedAt,
      unchecked: lastCheckedAt === null,
      verify: due.has(r.id),
    };
    out.set(r.id, { ...base, label: trustLabel(base, now) });
  }
  return out;
}

/** trustFor for one memory. */
export function trustOf(row: TrustRow, now: number = Date.now()): TrustSummary {
  return trustFor([row], now).get(row.id)!;
}

/** One line of the review page (app/memory/review). */
export interface ReviewItem {
  id: string;
  title: string;
  kind: LearningKind;
  authorId: string;
  authorName: string;
  createdAt: string;
  trust: TrustSummary;
}

export interface ReviewQueue {
  /** Active memories with a flag no later check answered, newest flag first. */
  flagged: ReviewItem[];
  /** Active memories due a check (a tech fact over 90 days that nobody else checked lately, or a business fact past its window), oldest first. */
  due: ReviewItem[];
  /** Active memories nobody but the author has checked, not already listed above, newest first. */
  unchecked: ReviewItem[];
}

/** At most this many memories in each part of the review page. */
export const REVIEW_QUEUE_LIMIT = 30;

/**
 * The maintainer's review page: what a person may want to look at. It changes nothing; the page's
 * buttons call confirm, keep and retire (lib/learnings.ts) like an agent would. BAB works without
 * anyone using it: flags, the sweeps and the labels do not wait for it.
 */
export function reviewQueue(limit: number = REVIEW_QUEUE_LIMIT, now: number = Date.now()): ReviewQueue {
  const db = getDb();
  type Row = Pick<LearningRow, "id" | "title" | "kind" | "author_id" | "created_at" | "status"> & { authorName: string | null };
  const select = `SELECT l.id, l.title, l.kind, l.author_id, l.created_at, l.status, u.name AS authorName FROM learnings l LEFT JOIN users u ON u.id = l.author_id`;
  // Every memory with a flag, newest flag first; trustFor then drops the ones a later check
  // answered, so a Keep or Confirm on this page takes an item off the list. Read a wider window.
  const flaggedRows = db
    .prepare(
      `${select} JOIN (SELECT learning_id, MAX(created_at) AS at FROM votes WHERE kind = 'flag' GROUP BY learning_id) f ON f.learning_id = l.id
       WHERE l.status = 'active' ORDER BY f.at DESC, l.id LIMIT ?`,
    )
    .all(limit * 10) as unknown as Row[];
  const cutoff = new Date(now - 90 * DAY_MS).toISOString().slice(0, 19).replace("T", " ");
  // Old enough to be due; verifyDueIds then drops the ones somebody else checked lately. Read a
  // wider window than the limit, since checked ones drop out.
  const oldRows = db
    .prepare(`${select} WHERE l.status = 'active' AND l.created_at < ? ORDER BY l.created_at, l.id LIMIT ?`)
    .all(cutoff, limit * 10) as unknown as Row[];
  const recentRows = db
    .prepare(
      `${select} WHERE l.status = 'active' AND NOT EXISTS (
         SELECT 1 FROM votes v WHERE v.learning_id = l.id AND v.kind IN ('confirm', 'keep', 'restore')
           AND lower(v.voter_id) <> lower(l.author_id))
       ORDER BY l.created_at DESC, l.id LIMIT ?`,
    )
    .all(limit * 3) as unknown as Row[];
  const trust = trustFor([...flaggedRows, ...oldRows, ...recentRows], now);
  // A business fact past its window is due a person's check, not a verify (lib/freshness.ts).
  const fresh = freshnessFor(oldRows.map((r) => r.id), now);
  const item = (r: Row): ReviewItem => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    authorId: r.author_id,
    authorName: r.authorName ?? r.author_id,
    createdAt: r.created_at,
    trust: trust.get(r.id)!,
  });
  const flagged = flaggedRows.filter((r) => trust.get(r.id)!.flags > 0).slice(0, limit).map(item);
  const shown = new Set(flagged.map((i) => i.id));
  const due = oldRows.filter((r) => !shown.has(r.id) && (trust.get(r.id)!.verify || fresh.get(r.id)?.checkDue)).slice(0, limit).map(item);
  for (const i of due) shown.add(i.id);
  const unchecked = recentRows.filter((r) => !shown.has(r.id)).slice(0, limit).map(item);
  return { flagged, due, unchecked };
}
