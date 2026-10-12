/**
 * Linked Claude Code sessions: which person a hook's session_id belongs to. The plugin's hook
 * is a bare curl that carries the session id and nothing else, so this row (written when the
 * agent redeems a link token, lib/session-links.ts) is how POST /api/hook knows whose unread
 * count, reminders and nudges to show. It is not a directory: nothing lists sessions, and
 * messages go to a person's inbox, never to a session. Backed by migration v7 (lib/db.ts);
 * the table's older columns (name, title, cwd, host, pid) are no longer written.
 */
import { getDb } from "./db";
import { ForbiddenError, ValidationError } from "./errors";
import type { SessionRow } from "./types";

export const ID_MAX = 128;

export function getById(id: string): SessionRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as
    | SessionRow
    | undefined;
}

/**
 * Records that session `id` belongs to `ownerId` (1-128 chars). Bumps `updated_at` and clears
 * `ended_at`, so a session that links again after being swept comes back.
 *
 * Ownership is enforced here: `owner_id` only moves to `excluded.owner_id` when the existing row
 * already belongs to that same owner, so a second identity naming someone else's session id
 * updates nothing, and the check below turns that into ForbiddenError instead of a silent no-op.
 */
export function linkSession(ownerId: string, idRaw: string): SessionRow {
  const db = getDb();

  const id = String(idRaw ?? "").trim();
  if (!id || id.length > ID_MAX) {
    throw new ValidationError(`id is required and must be 1-${ID_MAX} characters`);
  }

  db.prepare(
    `INSERT INTO sessions (id, owner_id, status, updated_at, ended_at)
     VALUES (?, ?, 'active', datetime('now'), NULL)
     ON CONFLICT(id) DO UPDATE SET
       owner_id = excluded.owner_id,
       status = 'active',
       updated_at = datetime('now'),
       ended_at = NULL
     WHERE sessions.owner_id = excluded.owner_id`,
  ).run(id, ownerId);

  const row = getById(id)!;
  if (row.owner_id !== ownerId) {
    throw new ForbiddenError("Not your session");
  }
  return row;
}

/** A quiet refresh must not go stale-check less often than this or a mid-window prompt bumps nothing. */
const HOOK_REFRESH_STALE_MINUTES = 5;

/**
 * The hook's per-prompt keep-alive, so a session used for days is not swept (sweepSessions ends a
 * row after 24 hours without one) and asked to link again. Never creates a row (only an UPDATE)
 * and never revives an ended one. The staleness check is the point: without it this would write
 * on every prompt; with it, a busy session's hook calls are almost all no-op UPDATEs.
 */
export function refreshSessionIfStale(id: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET updated_at = datetime('now')
       WHERE id = ? AND ended_at IS NULL AND updated_at < datetime('now', '-${HOOK_REFRESH_STALE_MINUTES} minutes')`,
    )
    .run(id);
}

/**
 * Counts one prompt against a linked session, for the Stop hook's capture nudge
 * (app/api/hook/route.ts). Only an existing, not-ended row: like refreshSessionIfStale,
 * it never creates or revives a session.
 */
export function countPrompt(id: string): void {
  getDb()
    .prepare("UPDATE sessions SET prompts_since_learn = prompts_since_learn + 1 WHERE id = ? AND ended_at IS NULL")
    .run(id);
}

/**
 * Zeroes the prompt counter on every linked session of `ownerId`. bab_learn calls this:
 * an MCP call carries no Claude session id, so the reset cannot target the one session
 * that posted and is owner-wide on purpose. A learning posted anywhere quiets the capture
 * nudge everywhere, which is the safe direction.
 */
export function resetPromptsSinceLearn(ownerId: string): void {
  getDb()
    .prepare("UPDATE sessions SET prompts_since_learn = 0 WHERE owner_id = ? AND ended_at IS NULL")
    .run(ownerId);
}

export interface SweepResult {
  ended: number;
  deleted: number;
}

/**
 * Marks stale-but-not-yet-ended sessions ended (no hook refresh for >24h) and
 * permanently deletes ended sessions older than 7 days.
 */
export function sweepSessions(db: ReturnType<typeof getDb>): SweepResult {
  const endedResult = db
    .prepare(
      `UPDATE sessions SET status = 'ended', ended_at = datetime('now')
       WHERE ended_at IS NULL AND updated_at < datetime('now', '-24 hours')`,
    )
    .run();

  const deletedResult = db
    .prepare(
      `DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < datetime('now', '-7 days')`,
    )
    .run();

  return {
    ended: Number(endedResult.changes ?? 0),
    deleted: Number(deletedResult.changes ?? 0),
  };
}
