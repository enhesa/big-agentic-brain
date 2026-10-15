import { getDb, inTransaction } from "./db";
import { config } from "./config";
import { downvotedLive, downvotedSql, DOWNVOTE_UNREAD_DAYS } from "./swarm-gc";
import { redact } from "./redact";
import { sweepSessions } from "./sessions";
import { todayUtc } from "./dates";
import { audit } from "./audit";
import { INACTIVITY_ARCHIVE_DAYS, INACTIVITY_CLOCK_START } from "./learnings";
import { maybeSnapshotBackup } from "./backup";
import { revokeStaleDevices } from "./devices";
import { expireStaleConnections } from "./mcp-connections";

/** How long an idempotency-replay row is kept (matches TTL_MS in lib/idempotency.ts). */
const IDEMPOTENCY_RETENTION_HOURS = 24;
/**
 * How long a `deleted` learning (an explicit, audited admin action — see
 * docs/spec.md "Garbage collection") sticks around before the retention
 * sweep purges it and its votes for good. Deletions are rare and already a
 * deliberate human decision, so this is a generous undo/audit window, not a
 * tight one — nowhere near the audit retention, since there are far fewer
 * deleted learnings than audit rows and the table cost of keeping them a
 * bit longer is negligible.
 */
const DELETED_LEARNING_RETENTION_DAYS = 30;
/** Run at most this often per process, so bursts of requests don't each re-run the sweep. */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
/**
 * Max rows moved/deleted per sweep TYPE per run, so a large backlog (e.g. the
 * sweep not having run for a long time) can't turn one opportunistic
 * maintenance call into an unbounded table scan/write. Left-over rows are
 * picked up on the next run (at most an hour later).
 */
const MAINTENANCE_BATCH_LIMIT = 500;
/** A session_nudges row for a session id with no `sessions` row is kept this long. */
export const NUDGE_ORPHAN_RETENTION_DAYS = 7;
/** Every session_nudges row is deleted after this long, whatever its session. */
export const NUDGE_RETENTION_DAYS = 30;

let lastRunAt = 0;

export interface MaintenanceResult {
  idempotencyDeleted: number;
  auditDeleted: number;
  /** Rows whose text changed under the current redaction patterns. */
  rowsRedacted: number;
  /** Sessions marked ended (no heartbeat for >24h). */
  sessionsEnded: number;
  /** Ended sessions permanently deleted (ended >7d ago). */
  sessionsDeleted: number;
  /** Learnings archived because their own valid-until date (expires_at) has passed. */
  learningsExpired: number;
  /** Learnings archived because no agent read them for INACTIVITY_ARCHIVE_DAYS. */
  learningsInactive: number;
  /** Learnings and practices archived because colleagues marked them not helpful and no agent read them for DOWNVOTE_UNREAD_DAYS (lib/swarm-gc.ts). */
  learningsDownvoted: number;
  /** `deleted` learnings (and their votes) permanently purged past DELETED_LEARNING_RETENTION_DAYS. */
  learningsPurged: number;
  /** Threads with no messages permanently deleted. */
  threadsPurged: number;
  /** Expired session_links rows (dead link tokens) permanently deleted. */
  sessionLinksPurged: number;
  /** session_deliveries rows for sessions that no longer exist, permanently deleted. */
  sessionDeliveriesPurged: number;
  /** session_learning_deliveries rows for sessions that no longer exist, permanently deleted. */
  learningDeliveriesPurged: number;
  /** reminder_deliveries rows whose todo is gone or has since moved to a new due_at, permanently deleted. */
  reminderDeliveriesPurged: number;
  /** session_nudges rows deleted: no session row and older than 7 days, or older than 30 days. */
  sessionNudgesPurged: number;
  /** Devices forgotten because they were not seen for 90 days (lib/devices.ts). */
  devicesExpired: number;
  /** MCP connections (Mcp-Session-Id) deleted because they were not seen for 7 days. */
  connectionsExpired: number;
}

type Db = ReturnType<typeof getDb>;

/** Column groups the sweep re-redacts. Every free-text field an agent can write. */
const REDACTABLE: { table: string; id: string; columns: string[] }[] = [
  { table: "learnings", id: "id", columns: ["title", "body", "tags", "repo"] },
  { table: "todos", id: "id", columns: ["title", "body", "related_key"] },
  { table: "threads", id: "id", columns: ["subject"] },
  { table: "messages", id: "id", columns: ["body"] },
  { table: "votes", id: "rowid", columns: ["note"] },
  { table: "users", id: "id", columns: ["name"] },
];

/**
 * Re-applies `redact()` to every stored free-text column. Writes are redacted
 * on the fly too (lib/learnings.ts etc.), so this only changes rows when a
 * pattern was added after they were written. Full scans, but the tables are
 * small (thousands of rows) and it runs at most hourly.
 */
export function redactStoredRows(db: Db): number {
  let changed = 0;
  // Without an internal-domain list every address would count as external: a fresh deployment
  // would lose every stored colleague address. Writes still mask; only the sweep holds back.
  const emailMasking = config().redact.domains.length > 0;
  for (const spec of REDACTABLE) {
    const select = `SELECT ${spec.id} AS rid, ${spec.columns.join(", ")} FROM ${spec.table}`;
    const rows = db.prepare(select).all() as Record<string, unknown>[];
    for (const row of rows) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const col of spec.columns) {
        const value = row[col];
        if (typeof value !== "string" || !value) continue;
        const clean = redact(value, { emails: emailMasking });
        if (clean !== value) {
          sets.push(`${col} = ?`);
          params.push(clean);
        }
      }
      if (sets.length === 0) continue;
      params.push(row.rid);
      db.prepare(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE ${spec.id} = ?`).run(...(params as never[]));
      changed += 1;
    }
  }
  return changed;
}

/**
 * Selects up to MAINTENANCE_BATCH_LIMIT ids matching `whereClause` (bound to
 * `params`) and, if any matched, runs `mutate` (a DELETE/UPDATE ... WHERE id
 * IN (...)) against exactly that id set. Shared by every bounded sweep below
 * so each stays a plain two-statement select-then-mutate instead of relying
 * on SQLite `UPDATE/DELETE ... LIMIT` (not available in this build).
 */
function sweepBatch(
  db: Db,
  table: string,
  whereClause: string,
  params: (string | number)[],
  mutate: (idList: string, ids: string[]) => number,
  idColumn = "id",
): number {
  const rows = db
    .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE ${whereClause} LIMIT ?`)
    .all(...params, MAINTENANCE_BATCH_LIMIT) as { id: string }[];
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  const idList = ids.map(() => "?").join(",");
  return mutate(idList, ids);
}

/**
 * Moves one batch of live learnings to `archived`, with one `auto-archive` audit row each (actor
 * `system`, details `{ reason }`) so the memory page can say why and the usage page can count them.
 * One transaction: a memory is never archived without its row.
 */
function archiveBatch(db: Db, idList: string, ids: string[], reason: "valid-until" | "inactive"): number {
  return inTransaction(db, () => {
    const result = db
      .prepare(`UPDATE learnings SET status = 'archived', updated_at = datetime('now') WHERE id IN (${idList})`)
      .run(...ids);
    for (const id of ids) audit(db, "system", "auto-archive", "learning", id, "ui", { details: { reason } });
    return Number(result.changes ?? 0);
  });
}

/**
 * Garbage collection (docs/spec.md "Garbage collection"), part 1: archives a learning whose own
 * valid-until date (expires_at, chosen by its author for a time-bound fact such as a campaign or a
 * freeze) is over: the memory is valid through that day and archived the day after. Memories have no expiry by default, so this only ever
 * touches the few that carry a date. Idempotent: an archived row no longer matches.
 */
function sweepExpiry(db: Db): number {
  return sweepBatch(
    db,
    "learnings",
    "status = 'active' AND expires_at IS NOT NULL AND substr(expires_at, 1, 10) < ?",
    [todayUtc()],
    (idList, ids) => archiveBatch(db, idList, ids, "valid-until"),
  );
}

/**
 * Garbage collection, part 2: archives a live learning or practice that no agent
 * has read for a while. "Read" is what touchRead records (lib/learnings.ts): a search result, a
 * fetch by id or a reaction by an agent, never a person opening a page. The clock is the last read,
 * else the day it was saved, and never starts before INACTIVITY_CLOCK_START (reads were not recorded
 * earlier). Standards and decisions, and pinned house rules, are never archived this way: a rule
 * consulted once a year is still a rule. Archived is reversible (bab_react keep). Two branches of
 * one WHERE clause, no new state:
 *
 * - inactive: no agent read it for INACTIVITY_ARCHIVE_DAYS. Audited as `auto-archive`, reason
 *   `inactive`.
 * - downvoted (swarm garbage collection, docs/spec.md "Swarm garbage collection"): at least
 *   DOWNVOTE_MIN_PEOPLE distinct people marked it not helpful since the last keep, restore or
 *   confirm, they outnumber its helpful + confirm + kudos (downvotedSql in lib/swarm-gc.ts), and no
 *   agent read it for DOWNVOTE_UNREAD_DAYS. Audited as `downvote_archived` with
 *   `{ notHelpful, support }`. A row that meets both is counted as downvoted.
 *
 * Idempotent and bounded like the other sweeps: an archived row no longer matches. Returns how many
 * it archived for each reason; sweepInactive adds them up.
 */
export function sweepUnread(db: Db, now = "now"): { inactive: number; downvoted: number } {
  // `now` is SQLite's time string for "the present" ("now", or a fixed "YYYY-MM-DD HH:MM:SS" in a test).
  const clock = "max(COALESCE(last_accessed_at, created_at), ?)";
  const rows = db
    .prepare(
      `SELECT id, CASE WHEN ${clock} < datetime(?, ?) AND ${downvotedSql("learnings")} THEN 1 ELSE 0 END AS downvoted
       FROM learnings
       WHERE status = 'active' AND kind IN ('learning', 'practice') AND pinned = 0
         AND (${clock} < datetime(?, ?)
              OR (${clock} < datetime(?, ?) AND ${downvotedSql("learnings")}))
       LIMIT ?`,
    )
    .all(
      INACTIVITY_CLOCK_START,
      now,
      `-${DOWNVOTE_UNREAD_DAYS} days`,
      INACTIVITY_CLOCK_START,
      now,
      `-${INACTIVITY_ARCHIVE_DAYS} days`,
      INACTIVITY_CLOCK_START,
      now,
      `-${DOWNVOTE_UNREAD_DAYS} days`,
      MAINTENANCE_BATCH_LIMIT,
    ) as Array<{ id: string; downvoted: number | bigint }>;
  if (rows.length === 0) return { inactive: 0, downvoted: 0 };

  const inactiveIds = rows.filter((r) => Number(r.downvoted) === 0).map((r) => r.id);
  const downvotedIds = rows.filter((r) => Number(r.downvoted) === 1).map((r) => r.id);
  const inactive =
    inactiveIds.length > 0 ? archiveBatch(db, inactiveIds.map(() => "?").join(","), inactiveIds, "inactive") : 0;
  let downvoted = 0;
  if (downvotedIds.length > 0) {
    const marks = downvotedIds.map(() => "?").join(",");
    // The counts at the moment of archiving, for the audit row (the memory page and /usage read it).
    const counts = new Map(downvotedLive(db).map((m) => [m.id, { notHelpful: m.notHelpful, support: m.support }]));
    downvoted = inTransaction(db, () => {
      const result = db
        .prepare(`UPDATE learnings SET status = 'archived', updated_at = datetime('now') WHERE id IN (${marks})`)
        .run(...downvotedIds);
      for (const id of downvotedIds) {
        audit(db, "system", "downvote_archived", "learning", id, "ui", { details: counts.get(id) ?? {} });
      }
      return Number(result.changes ?? 0);
    });
  }
  return { inactive, downvoted };
}

/** sweepUnread, as one number: how many memories it archived, for either reason. */
export function sweepInactive(db: Db, now = "now"): number {
  const { inactive, downvoted } = sweepUnread(db, now);
  return inactive + downvoted;
}

/**
 * Permanently purges `deleted` learnings (an explicit, audited admin action)
 * older than DELETED_LEARNING_RETENTION_DAYS, and their votes. Votes are
 * deleted first: `votes.learning_id` has a foreign key to `learnings(id)`
 * with no ON DELETE CASCADE, and `PRAGMA foreign_keys = ON` (lib/db.ts) means
 * deleting the learning first would fail the constraint. The `learnings_ad`
 * trigger (lib/db.ts migration v1) removes the matching learnings_fts row as
 * part of the `learnings` DELETE, so no separate FTS cleanup is needed here.
 * Both deletes run in one transaction: a crash between them must not leave
 * the learning gone but its votes orphaned (harmless) or, worse, leave a
 * learning whose votes were wiped but the row itself still present (bogus
 * vote counts for something that's supposedly been deleted).
 */
function sweepDeletedLearnings(db: Db): number {
  return sweepBatch(
    db,
    "learnings",
    "status = 'deleted' AND updated_at < datetime('now', ?)",
    [`-${DELETED_LEARNING_RETENTION_DAYS} days`],
    (idList, ids) =>
      inTransaction(db, () => {
        db.prepare(`DELETE FROM votes WHERE learning_id IN (${idList})`).run(...ids);
        // supersession_links and learnings.supersedes_id both hold foreign keys to learnings;
        // without unlinking them first the DELETE below fails and rolls the whole batch back.
        db.prepare(`DELETE FROM supersession_links WHERE old_id IN (${idList}) OR new_id IN (${idList})`).run(
          ...ids,
          ...ids,
        );
        db.prepare(`UPDATE learnings SET supersedes_id = NULL WHERE supersedes_id IN (${idList})`).run(...ids);
        const result = db.prepare(`DELETE FROM learnings WHERE id IN (${idList})`).run(...ids);
        return Number(result.changes ?? 0);
      }),
  );
}

/**
 * Deletes `session_links` rows past `expires_at`. This table has no owner-based cap and
 * is written from POST /api/hook, an unauthenticated route (lib/session-links.ts) — the
 * idx_session_links_expires_at index existed before any sweep used it, and expired rows
 * are otherwise dead weight forever. `mintOrReuseLinkToken` already stops most repeat
 * calls from creating new rows, but a session that never links still leaves its last
 * token behind once it expires; this clears those out, keyed on `token` since the table
 * has no `id` column.
 */
function sweepExpiredLinks(db: Db): number {
  return sweepBatch(
    db,
    "session_links",
    "expires_at < datetime('now')",
    [],
    (idList, ids) => {
      const result = db.prepare(`DELETE FROM session_links WHERE token IN (${idList})`).run(...ids);
      return Number(result.changes ?? 0);
    },
    "token",
  );
}

/**
 * Deletes `session_deliveries` rows whose session no longer exists in `sessions`. A
 * session is hard-deleted by sweepSessions() 7 days after it ends (lib/sessions.ts), and
 * nothing else ever cleans up session_deliveries by session_id — without this sweep,
 * every session that ever had a message announced to it leaves that bookkeeping behind
 * forever. Keyed on `rowid`, not `session_id`/`message_id`: the table's primary key is
 * the pair (a person with two open sessions gets the same message_id recorded once per
 * session, by design), so batching on message_id alone could delete a still-live
 * session's delivery row along with a dead session's that happens to share it.
 */
function sweepOrphanedDeliveries(db: Db): number {
  return sweepBatch(
    db,
    "session_deliveries",
    "NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_deliveries.session_id)",
    [],
    (idList, ids) => {
      const result = db.prepare(`DELETE FROM session_deliveries WHERE rowid IN (${idList})`).run(...ids);
      return Number(result.changes ?? 0);
    },
    "rowid",
  );
}

/**
 * Same cleanup as sweepOrphanedDeliveries, for session_learning_deliveries (migration
 * v15, the retired-memory notice's dedup table): a session hard-deleted 7 days
 * after it ends (sweepSessions) would otherwise leave its nudge bookkeeping behind
 * forever, since nothing else ever purges this table by session_id.
 */
function sweepOrphanedLearningDeliveries(db: Db): number {
  return sweepBatch(
    db,
    "session_learning_deliveries",
    "NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_learning_deliveries.session_id)",
    [],
    (idList, ids) => {
      const result = db.prepare(`DELETE FROM session_learning_deliveries WHERE rowid IN (${idList})`).run(...ids);
      return Number(result.changes ?? 0);
    },
    "rowid",
  );
}

/**
 * Deletes `session_nudges` rows (migration v21) that no longer guard anything. POST /api/hook is
 * unauthenticated and writes 'rules' and 'project' rows for any session id on its first prompt,
 * including ids that never link, and nothing else ever purged this table. Two rules:
 *   - no `sessions` row and older than NUDGE_ORPHAN_RETENTION_DAYS: a session that never linked,
 *     or one sweepSessions() hard-deleted 7 days after it ended;
 *   - older than NUDGE_RETENTION_DAYS, whatever the session.
 * Safe for "once per session": a row only stops a repeat. If a session id ever comes back after
 * its row is gone, the worst case is one repeat of the first-prompt block (house rules and project
 * titles) or the maintainer's flagged count, once a month in a session that runs that long. The
 * capture nudge's cooldown is 60 minutes, far inside both windows.
 */
function sweepStaleNudges(db: Db): number {
  return sweepBatch(
    db,
    "session_nudges",
    `at < datetime('now', ?)
     OR (at < datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = session_nudges.session_id))`,
    [`-${NUDGE_RETENTION_DAYS} days`, `-${NUDGE_ORPHAN_RETENTION_DAYS} days`],
    (idList, ids) => {
      const result = db.prepare(`DELETE FROM session_nudges WHERE rowid IN (${idList})`).run(...ids);
      return Number(result.changes ?? 0);
    },
    "rowid",
  );
}

/**
 * Deletes `reminder_deliveries` rows (migration v17, the due-reminder notice's
 * per-owner dedup table) that can no longer matter: the todo they were recorded
 * against is gone, or snooze() (lib/todos.ts) has since moved it to a new
 * due_at, so the row no longer matches the due-reminder query's SELECT and can
 * never again suppress or double up on an announcement. Nothing else ever
 * purges this table. Unlike sweepOrphanedDeliveries/sweepOrphanedLearningDeliveries
 * above, this isn't keyed off session lifecycle at all — it's keyed off the
 * todo's own current due_at, since reminder_deliveries dedups per owner, not
 * per session.
 */
function sweepStaleReminderDeliveries(db: Db): number {
  return sweepBatch(
    db,
    "reminder_deliveries",
    `NOT EXISTS (
       SELECT 1 FROM todos t
       WHERE t.id = reminder_deliveries.todo_id AND t.due_at = reminder_deliveries.due_at
     )`,
    [],
    (idList, ids) => {
      const result = db.prepare(`DELETE FROM reminder_deliveries WHERE rowid IN (${idList})`).run(...ids);
      return Number(result.changes ?? 0);
    },
    "rowid",
  );
}

/**
 * Deletes `threads` with no messages. `send()` (lib/messages.ts) now creates
 * a new thread and its first message inside one transaction, so this
 * shouldn't happen going forward — but it cleans up anything left behind by
 * data from before that fix, or any other future edge case that manages to
 * insert a thread without a message.
 */
function sweepEmptyThreads(db: Db): number {
  return sweepBatch(
    db,
    "threads",
    "NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id)",
    [],
    (idList, ids) => {
      const result = db.prepare(`DELETE FROM threads WHERE id IN (${idList})`).run(...ids);
      return Number(result.changes ?? 0);
    },
  );
}

/**
 * Retention sweep: deletes expired idempotency rows and old audit_log rows,
 * runs the garbage-collection state machine on learnings (expiry + purge)
 * and cleans up empty threads, then runs PRAGMA optimize so SQLite's query
 * planner keeps fresh stats as the tables grow. Guarded to at most once per
 * hour per process (module-level timestamp) and never throws — a maintenance
 * failure must not break the request that opportunistically triggered it.
 */
export function runMaintenance(force = false): MaintenanceResult | null {
  const now = Date.now();
  if (!force && now - lastRunAt < MAINTENANCE_INTERVAL_MS) return null;
  lastRunAt = now;

  try {
    const db = getDb();

    const idempotencyResult = db
      .prepare(`DELETE FROM idempotency WHERE created_at < datetime('now', ?)`)
      .run(`-${IDEMPOTENCY_RETENTION_HOURS} hours`);

    const auditResult = db
      .prepare(`DELETE FROM audit_log WHERE at < datetime('now', ?)`)
      .run(`-${config().retention.auditDays} days`);

    // Each sweep on its own: one step failing for good (a bad row, a schema surprise) must
    // not skip every later step on every run.
    const rowsRedacted = step("redactStoredRows", () => redactStoredRows(db), 0);
    const sessionSweep = step("sweepSessions", () => sweepSessions(db), { ended: 0, deleted: 0 });
    const learningsExpired = step("sweepExpiry", () => sweepExpiry(db), 0);
    const unread = step("sweepUnread", () => sweepUnread(db), { inactive: 0, downvoted: 0 });
    const learningsPurged = step("sweepDeletedLearnings", () => sweepDeletedLearnings(db), 0);
    const threadsPurged = step("sweepEmptyThreads", () => sweepEmptyThreads(db), 0);
    const sessionLinksPurged = step("sweepExpiredLinks", () => sweepExpiredLinks(db), 0);
    const sessionDeliveriesPurged = step("sweepOrphanedDeliveries", () => sweepOrphanedDeliveries(db), 0);
    const learningDeliveriesPurged = step("sweepOrphanedLearningDeliveries", () => sweepOrphanedLearningDeliveries(db), 0);
    const reminderDeliveriesPurged = step("sweepStaleReminderDeliveries", () => sweepStaleReminderDeliveries(db), 0);
    const sessionNudgesPurged = step("sweepStaleNudges", () => sweepStaleNudges(db), 0);
    const devicesExpired = step("revokeStaleDevices", () => revokeStaleDevices(), 0);
    const connectionsExpired = step("expireStaleConnections", () => expireStaleConnections(), 0);

    db.exec("PRAGMA optimize;");

    return {
      idempotencyDeleted: Number(idempotencyResult.changes ?? 0),
      auditDeleted: Number(auditResult.changes ?? 0),
      rowsRedacted,
      sessionsEnded: sessionSweep.ended,
      sessionsDeleted: sessionSweep.deleted,
      learningsExpired,
      learningsInactive: unread.inactive,
      learningsDownvoted: unread.downvoted,
      learningsPurged,
      threadsPurged,
      sessionLinksPurged,
      sessionDeliveriesPurged,
      learningDeliveriesPurged,
      reminderDeliveriesPurged,
      sessionNudgesPurged,
      devicesExpired,
      connectionsExpired,
    };
  } catch (err) {
    console.error("runMaintenance failed", err);
    return null;
  }
}

function step<T>(name: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.error(`runMaintenance step ${name} failed`, err);
    return fallback;
  }
}

/**
 * Fire-and-forget trigger for request handlers: schedules runMaintenance()
 * on the microtask/macrotask queue so no request waits on it, and the
 * hourly guard above means most calls are a no-op timestamp check.
 */
export function scheduleMaintenance(): void {
  // Under vitest, each test tears its own temp DATA_DIR down synchronously
  // in afterEach (rmSync right after _resetDbForTests()); a setImmediate
  // fired from a still-running request would race that teardown and reopen
  // a DB handle in a directory that's mid-delete. Tests exercise the sweep
  // directly via runMaintenance() instead (see tests/maintenance.test.ts).
  if (process.env.VITEST) return;

  setImmediate(() => {
    try {
      runMaintenance();
    } catch (err) {
      console.error("scheduleMaintenance failed", err);
    }
    // Backups (lib/backup.ts): keep a VACUUM INTO snapshot fresh next to bab.db. Rides
    // this same opportunistic trigger rather than a
    // separate timer; its own ~20h freshness check makes most calls a no-op stat(), and
    // it's independent of runMaintenance() so one failing never blocks the other.
    // maybeSnapshotBackup() already never throws on its own; wrapped the same as
    // runMaintenance() above purely as a belt-and-suspenders match for this callback.
    try {
      maybeSnapshotBackup();
    } catch (err) {
      console.error("scheduleMaintenance (backup) failed", err);
    }
  });
}

/** Test-only: resets the hourly guard so a test can force a re-run. */
export function _resetMaintenanceGuardForTests(): void {
  lastRunAt = 0;
}
