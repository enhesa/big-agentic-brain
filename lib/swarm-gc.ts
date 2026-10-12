import type { DatabaseSync } from "node:sqlite";
import { parseDbTime } from "./dates";

/**
 * Swarm garbage collection (docs/spec.md "Swarm garbage collection"): the votes agents already cast
 * keep the memory clean. Shared by maintenance (lib/maintenance.ts), search (lib/learnings.ts), the
 * hook (app/api/hook/route.ts) and the maintainer nudge:
 *
 * - downvotedSql() / downvotedLive(): active memories that enough colleagues marked not helpful,
 *   and that those people outnumber the memory's support. The hourly sweep archives such a learning
 *   or practice once no agent has read it for DOWNVOTE_UNREAD_DAYS (a second branch of
 *   sweepInactive's WHERE clause; no new state). A standard, a decision or a pinned house rule is
 *   never archived this way: it only waits for a maintainer.
 * - verifyDueIds(): the memories search marks `verify: true`, because they are old and nobody has
 *   checked them lately.
 *
 * This module imports no other lib module that writes, so learnings.ts can import it without a cycle.
 */

/** Distinct people who must have marked a memory not helpful. */
export const DOWNVOTE_MIN_PEOPLE = 3;
/** A downvoted learning or practice is archived once no agent has read it for this many days. */
export const DOWNVOTE_UNREAD_DAYS = 90;
/** A memory older than this, with no confirm or keep inside it, is marked `verify: true` in search. */
export const VERIFY_AFTER_DAYS = 90;

const DAY_MS = 86_400_000;

/**
 * Distinct people (case-insensitive ids) who marked the memory `alias` not helpful after the newest
 * keep, restore or confirm on it. A keep, a restore or a confirm is an answer to the votes before
 * it, like a restore answers flags (a tie in the same second counts as before); without that, a
 * keep would be undone by the next hourly sweep.
 */
function notHelpfulSql(alias: string): string {
  return `(SELECT COUNT(DISTINCT lower(v.voter_id)) FROM votes v
            WHERE v.learning_id = ${alias}.id AND v.kind = 'not_helpful'
              AND v.created_at > COALESCE(
                (SELECT MAX(a.created_at) FROM votes a
                  WHERE a.learning_id = ${alias}.id AND a.kind IN ('keep', 'restore', 'confirm')), ''))`;
}

/** helpful + confirm + kudos rows on the memory `alias`, all time. */
function supportSql(alias: string): string {
  return `(SELECT COUNT(*) FROM votes s WHERE s.learning_id = ${alias}.id AND s.kind IN ('helpful', 'confirm', 'kudos'))`;
}

/**
 * The downvote condition for the learnings row `alias`, as SQL with no parameters: at least
 * DOWNVOTE_MIN_PEOPLE distinct not-helpful voters since the last answer, outnumbering its support.
 * The first clause is a cheap pre-filter on the votes index, so the per-memory counts only run for
 * the few memories that have enough not-helpful votes at all. Status, kind and the read clock are
 * the caller's.
 */
export function downvotedSql(alias = "learnings"): string {
  return `${alias}.id IN (
            SELECT learning_id FROM votes WHERE kind = 'not_helpful'
            GROUP BY learning_id HAVING COUNT(DISTINCT lower(voter_id)) >= ${DOWNVOTE_MIN_PEOPLE})
          AND ${notHelpfulSql(alias)} >= ${DOWNVOTE_MIN_PEOPLE}
          AND ${notHelpfulSql(alias)} > ${supportSql(alias)}`;
}

export interface DownvotedMemory {
  id: string;
  title: string;
  kind: string;
  author_id: string;
  /** Distinct people who marked it not helpful since the last keep, restore or confirm. */
  notHelpful: number;
  /** helpful + confirm + kudos rows, all time. */
  support: number;
  /** The newest keep, restore or confirm (SQL datetime), or null: the not-helpful votes after it count. */
  answeredAt: string | null;
  /** A standard, a decision or a pinned house rule: never archived this way, only a maintainer decides about it. */
  protectedEntry: boolean;
}

/** Active memories that meet the downvote condition (downvotedSql), oldest first. */
export function downvotedLive(db: DatabaseSync): DownvotedMemory[] {
  const rows = db
    .prepare(
      `SELECT l.id AS id, l.title AS title, l.kind AS kind, l.author_id AS author_id, l.pinned AS pinned,
              ${notHelpfulSql("l")} AS down, ${supportSql("l")} AS support,
              (SELECT MAX(a.created_at) FROM votes a
                WHERE a.learning_id = l.id AND a.kind IN ('keep', 'restore', 'confirm')) AS answeredAt
       FROM learnings l
       WHERE l.status = 'active' AND ${downvotedSql("l")}
       ORDER BY l.created_at, l.id`,
    )
    .all() as Array<{
    id: string;
    title: string;
    kind: string;
    author_id: string;
    pinned: number | bigint;
    down: number | bigint;
    support: number | bigint;
    answeredAt: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    author_id: r.author_id,
    notHelpful: Number(r.down),
    support: Number(r.support),
    answeredAt: r.answeredAt,
    protectedEntry: r.kind === "standard" || r.kind === "decision" || Number(r.pinned) === 1,
  }));
}

/**
 * The ids among `rows` that search marks `verify: true`: live, created more than VERIFY_AFTER_DAYS
 * ago, and with no confirm, keep or restore in the last VERIFY_AFTER_DAYS days. A correction is a
 * new memory (supersede stores a new row), so its age starts again and it never qualifies. One
 * grouped query however many rows there are. `now` is injectable for tests.
 */
export function verifyDueIds(
  db: DatabaseSync,
  rows: Array<{ id: string; status: string; created_at: string }>,
  now: number = Date.now(),
): Set<string> {
  const cutoff = now - VERIFY_AFTER_DAYS * DAY_MS;
  const old = rows.filter((r) => r.status === "active" && parseDbTime(r.created_at).getTime() < cutoff);
  const due = new Set<string>();
  if (old.length === 0) return due;
  const ids = [...new Set(old.map((r) => r.id))];
  const checked = new Set<string>();
  const since = new Date(cutoff).toISOString().slice(0, 19).replace("T", " ");
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const marks = chunk.map(() => "?").join(",");
    const recent = db
      .prepare(
        `SELECT DISTINCT learning_id AS id FROM votes
         WHERE learning_id IN (${marks}) AND kind IN ('confirm', 'keep', 'restore') AND created_at >= ?`,
      )
      .all(...chunk, since) as Array<{ id: string }>;
    for (const r of recent) checked.add(r.id);
  }
  for (const id of ids) if (!checked.has(id)) due.add(id);
  return due;
}

/** What search sends next to a result marked `verify: true`: who checks it, how, and the four ways to answer. */
export const VERIFY_HINT =
  "Results marked verify: true are over 90 days old and nobody has confirmed or kept them lately. If you use one, check it against code or docs in this task first, " +
  "then confirm it (bab_react confirm, note: where you checked), correct it (bab_learn with supersedes), or flag or retire it (note: the evidence).";
