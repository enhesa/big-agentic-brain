import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { config } from "./config";
import { parseDbTime } from "./dates";
import { ValidationError } from "./errors";
import { verifyDueIds } from "./swarm-gc";
import type { LearningKind } from "./types";

/**
 * Self-healing memory (docs/spec.md "Self-healing memory"): how fresh each memory is, and who can
 * tell. One agent can be wrong; the shared memory corrects it over time. Agents fix what breaks,
 * people check what can't break.
 *
 * - check_by: `agent` when an agent can test the memory (a command, a path, a setting, an API, how
 *   the code works). It breaks loudly, so the agent that uses it is the best witness: the existing
 *   `verify: true` hint (lib/swarm-gc.ts) is its "due" state, and no person is ever asked about it.
 *   `person` when nothing fails if it goes stale (a price, a limit, a policy, a team decision).
 *   After its window BAB asks a person "Is this still true?" (lib/checks.ts).
 * - Four states, worked out from stored dates and the flags, never stored themselves:
 *   fresh, due (past its window), disputed (an open flag, or a No or Not sure waiting for a fix)
 *   and stale (disputed for DISPUTE_STALE_DAYS with no fix, or a business fact a person was asked
 *   about with no answer for UNANSWERED_STALE_DAYS).
 *
 * This module writes nothing and imports no lib module that writes learnings, so lib/learnings.ts
 * and lib/trust.ts can import it.
 */

export const CHECK_BY_VALUES = ["agent", "person"] as const;
export type CheckBy = (typeof CHECK_BY_VALUES)[number];

export const FRESHNESS_STATES = ["fresh", "due", "disputed", "stale"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/** The default window for a business fact, by kind. Counted from the last of: made, confirmed or answered Yes. */
export const PERSON_CHECK_DAYS: Record<LearningKind, number> = {
  decision: 180,
  standard: 120,
  learning: 90,
  practice: 90,
};
/** The author's own window, when they set one (checkEveryDays). */
export const CHECK_EVERY_MIN_DAYS = 30;
export const CHECK_EVERY_MAX_DAYS = 365;
/** Disputed this long with no fix: stale. */
export const DISPUTE_STALE_DAYS = 14;
/** A business fact asked about with no answer this long: stale. */
export const UNANSWERED_STALE_DAYS = 30;

/**
 * Against flag spam: at most this many new flags, and this many corrections of other people's
 * memories, per person in any 24 hours. More are refused with a message. Guesses, like the windows.
 */
export const DAILY_FLAG_MAX = 5;
export const DAILY_SUPERSEDE_MAX = 5;

const DAY_MS = 86_400_000;

/**
 * The one rule for which check answers a flag, as SQL over a vote `v` (a confirm, keep or restore)
 * and its memory `l`: a check by someone other than the author, or a keep or restore by a
 * maintainer, also on their own memory (that is how a maintainer answers a flag on a standard).
 * Search rank, the trust label and freshness all use it, so a flag one of them calls answered is
 * answered for all three. Maintainer ids come from the configuration and are quoted here, because
 * the search rank expression takes no parameters.
 */
export function flagAnswerSql(v: string, l: string): string {
  const maintainers = [...config().identity.maintainers].map((id) => `'${id.replace(/'/g, "''")}'`);
  const own = maintainers.length > 0 ? ` OR lower(${v}.voter_id) IN (${maintainers.join(", ")})` : "";
  return `(lower(${v}.voter_id) <> lower(${l}.author_id)${own})`;
}

/** The default check_by for a kind, when the writing agent does not pick: decisions and standards are a person's. */
export function defaultCheckBy(kind: LearningKind): CheckBy {
  return kind === "decision" || kind === "standard" ? "person" : "agent";
}

/** `checkBy` from a request: agent, person or absent. Anything else is refused. */
export function parseCheckBy(raw: unknown): CheckBy | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string" || !(CHECK_BY_VALUES as readonly string[]).includes(raw.trim().toLowerCase())) {
    throw new ValidationError("checkBy must be agent or person");
  }
  return raw.trim().toLowerCase() as CheckBy;
}

/** `checkEveryDays` from a request: a whole number of days from 30 to 365, or absent (null: the default for the kind). */
export function parseCheckEveryDays(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < CHECK_EVERY_MIN_DAYS || n > CHECK_EVERY_MAX_DAYS) {
    throw new ValidationError(`checkEveryDays must be a whole number of days from ${CHECK_EVERY_MIN_DAYS} to ${CHECK_EVERY_MAX_DAYS}`);
  }
  return n;
}

/** What freshnessFor reads of a memory. */
export interface FreshnessRow {
  id: string;
  kind: LearningKind;
  author_id: string;
  status: string;
  created_at: string;
  check_by: CheckBy;
  check_every_days: number | null;
  checked_at: string | null;
  disputed_at: string | null;
  dispute_kind: "no" | "unsure" | null;
}

/** The person-check window of one memory in days: its own, or the default for its kind. */
export function personWindowDays(row: Pick<FreshnessRow, "kind" | "check_every_days">): number {
  return row.check_every_days ?? PERSON_CHECK_DAYS[row.kind] ?? 90;
}

export interface Freshness {
  freshness: FreshnessState;
  checkBy: CheckBy;
  /** A business fact past its window: BAB asks a person. Never set on a tech fact. */
  checkDue: boolean;
  /** Why it is disputed, when it is: an open flag, a No, or a Not sure. */
  disputeKind?: "flag" | "no" | "unsure";
  /** When the dispute began (the oldest open flag or the No or Not sure), SQLite datetime. */
  disputedSince?: string;
  /** The last check (made, confirmed, kept by someone else or answered Yes), SQLite datetime. */
  checkedAt: string;
}

/** personWindowDays as SQL over a `learnings` row: its own window, or the default for its kind. */
export const PERSON_WINDOW_DAYS_SQL = `COALESCE(check_every_days, CASE kind ${Object.entries(PERSON_CHECK_DAYS)
  .map(([kind, days]) => `WHEN '${kind}' THEN ${days}`)
  .join(" ")} ELSE 90 END)`;

/** One SQLite datetime, `days` before `now`. */
export function sqlTimeBefore(now: number, days: number): string {
  return new Date(now - days * DAY_MS).toISOString().slice(0, 19).replace("T", " ");
}

function chunks<T>(items: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function maxTime(...values: Array<string | null | undefined>): string {
  return values.filter((v): v is string => !!v).sort().at(-1)!;
}

/**
 * The freshness of each memory id, in a few grouped queries however many there are. Reads the
 * stored columns itself, so a caller may pass any rows it holds. Deleted or unknown ids are left
 * out of the map.
 */
export function freshnessFor(
  ids: string[],
  now: number = Date.now(),
  db: DatabaseSync = getDb(),
): Map<string, Freshness> {
  const out = new Map<string, Freshness>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const rows: FreshnessRow[] = [];
  const lastCheck = new Map<string, string>();
  const openFlagSince = new Map<string, string>();
  const asks = new Map<string, string[]>();
  for (const chunk of chunks(unique)) {
    const marks = chunk.map(() => "?").join(",");
    rows.push(
      ...(db
        .prepare(
          `SELECT id, kind, author_id, status, created_at, check_by, check_every_days, checked_at, disputed_at, dispute_kind
           FROM learnings WHERE id IN (${marks}) AND status <> 'deleted'`,
        )
        .all(...chunk) as unknown as FreshnessRow[]),
    );
    // The newest check by someone other than the author (the same rule as lib/trust.ts).
    for (const r of db
      .prepare(
        `SELECT v.learning_id AS id, MAX(v.created_at) AS at FROM votes v JOIN learnings l ON l.id = v.learning_id
         WHERE v.learning_id IN (${marks}) AND v.kind IN ('confirm', 'keep', 'restore') AND lower(v.voter_id) <> lower(l.author_id)
         GROUP BY v.learning_id`,
      )
      .all(...chunk) as Array<{ id: string; at: string }>) {
      lastCheck.set(r.id, r.at);
    }
    // Flags newer than the newest answering check (flagAnswerSql) are open; the oldest of them is
    // when the dispute began.
    for (const r of db
      .prepare(
        `SELECT f.learning_id AS id, MIN(f.created_at) AS at FROM votes f JOIN learnings l ON l.id = f.learning_id
         WHERE f.learning_id IN (${marks}) AND f.kind = 'flag'
           AND f.created_at > COALESCE((SELECT MAX(c.created_at) FROM votes c
             WHERE c.learning_id = f.learning_id AND c.kind IN ('confirm', 'keep', 'restore')
               AND ${flagAnswerSql("c", "l")}), '')
         GROUP BY f.learning_id`,
      )
      .all(...chunk) as Array<{ id: string; at: string }>) {
      openFlagSince.set(r.id, r.at);
    }
    // When a person was asked about it through their session, oldest first.
    for (const r of db
      .prepare(`SELECT learning_id AS id, delivered_at AS at FROM check_asks WHERE learning_id IN (${marks}) AND via = 'hook' ORDER BY delivered_at`)
      .all(...chunk) as Array<{ id: string; at: string }>) {
      asks.set(r.id, [...(asks.get(r.id) ?? []), r.at]);
    }
  }
  const verify = verifyDueIds(db, rows, now);
  for (const r of rows) {
    const checkBy: CheckBy = r.check_by === "person" ? "person" : "agent";
    const checkedAt = maxTime(r.created_at, r.checked_at, lastCheck.get(r.id));
    const live = r.status === "active";
    const pastWindow = parseDbTime(checkedAt).getTime() < now - personWindowDays(r) * DAY_MS;
    const checkDue = live && checkBy === "person" && pastWindow;
    const flagAt = openFlagSince.get(r.id);
    const disputeKind: Freshness["disputeKind"] = flagAt ? "flag" : r.dispute_kind ?? undefined;
    const disputedSince = [flagAt, r.dispute_kind ? r.disputed_at : null].filter((v): v is string => !!v).sort()[0];
    let state: FreshnessState = "fresh";
    if (disputeKind) {
      state =
        disputedSince && parseDbTime(disputedSince).getTime() < now - DISPUTE_STALE_DAYS * DAY_MS ? "stale" : "disputed";
    } else if (checkBy === "agent" ? verify.has(r.id) : checkDue) {
      state = "due";
      if (checkBy === "person") {
        // Asked about after its last check, and still no answer that moved the clock.
        const firstAsk = (asks.get(r.id) ?? []).find((at) => at > checkedAt);
        if (firstAsk && parseDbTime(firstAsk).getTime() < now - UNANSWERED_STALE_DAYS * DAY_MS) state = "stale";
      }
    }
    if (!live) state = "fresh";
    out.set(r.id, {
      freshness: state,
      checkBy,
      checkDue,
      ...(disputeKind && live ? { disputeKind, ...(disputedSince ? { disputedSince } : {}) } : {}),
      checkedAt,
    });
  }
  return out;
}

/**
 * The rank penalty of a disputed or stale memory, as SQL over the `learnings` row (the open-flag
 * test is the caller's OPEN_FLAG_SQL): a No, a Not sure older than DISPUTE_STALE_DAYS, or a
 * business fact asked about UNANSWERED_STALE_DAYS ago with no answer since its last check. A Not
 * sure alone has no penalty: someone was unsure, nobody said it is wrong.
 */
export const DISPUTED_OR_STALE_SQL = `(
  learnings.dispute_kind = 'no'
  OR (learnings.dispute_kind = 'unsure' AND learnings.disputed_at < datetime('now', '-${DISPUTE_STALE_DAYS} days'))
  OR (learnings.check_by = 'person' AND EXISTS (
    SELECT 1 FROM check_asks a WHERE a.learning_id = learnings.id AND a.via = 'hook'
      AND a.delivered_at < datetime('now', '-${UNANSWERED_STALE_DAYS} days')
      AND a.delivered_at > COALESCE(learnings.checked_at, learnings.created_at))))`;

/** What search sends next to results that carry checkDue: a business fact due a person's check. */
export const CHECK_DUE_HINT =
  "Results marked checkDue: true are business facts due a human check. Use one, but tell the user it may be out of date, and ask before anything that cannot be undone. " +
  "Never mark a business fact true or false yourself: only a person answers bab_react recheck.";

/** The plain line for a disputed or stale result. */
export function freshnessWarning(f: Freshness): string | undefined {
  if (f.freshness === "stale") return "Not checked for a long time, or disputed with no fix. Treat it with caution.";
  if (f.disputeKind === "flag") return "Someone flagged this as wrong. Read the flag in its history before you act on it.";
  if (f.disputeKind === "no") return "A person said this is no longer true. Do not act on it until it is fixed.";
  if (f.disputeKind === "unsure") return "Someone was not sure this still holds. Check it before you act on it.";
  return undefined;
}
