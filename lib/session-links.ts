import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { linkSession } from "./sessions";
import { NotFoundError, ConflictError } from "./errors";

/**
 * The plugin's hook (a bare curl) carries the session id but not who owns it:
 * ${user_config} does not expand in hook headers and CLAUDE_PLUGIN_OPTION_* is not in
 * the interpolator's environment (docs/specs/2026-09-22-plugin-delivery-design.md).
 * So the hook gets a short-lived token and the agent redeems it over the MCP
 * connection, which knows who the user is. After that, POST /api/hook knows whose unread
 * count, reminders and nudges to show in that session. It never addresses messages: those
 * go to the person's inbox. Single use, on purpose: a replayable token would
 * let a second caller re-point someone else's session id at itself.
 */
export const LINK_TOKEN_TTL_MINUTES = 10;

interface LinkRow {
  token: string;
  session_id: string;
  expires_at: string;
  used_at: string | null;
}

export function mintLinkToken(sessionId: string): string {
  const token = randomUUID().replace(/-/g, "");
  getDb()
    .prepare(
      `INSERT INTO session_links (token, session_id, created_at, expires_at)
       VALUES (?, ?, datetime('now'), datetime('now', '+' || ? || ' minutes'))`,
    )
    .run(token, sessionId, String(LINK_TOKEN_TTL_MINUTES));
  return token;
}

/**
 * mintLinkToken(), but reuses a still-live (unused, unexpired) token for the same
 * session_id instead of minting a new row. POST /api/hook (the only caller) is
 * unauthenticated and Claude Code re-POSTs on every prompt until a session links, so
 * without this an unlinked session, or an attacker naming an arbitrary session_id,
 * would leave one session_links row per hook call with no bound on how many. There is
 * an index on expires_at and a maintenance sweep (lib/maintenance.ts) for the rows that
 * do accumulate, but reuse means most callers never create one in the first place.
 */
export function mintOrReuseLinkToken(sessionId: string): string {
  const existing = getDb()
    .prepare(
      `SELECT token FROM session_links
       WHERE session_id = ? AND used_at IS NULL AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as { token: string } | undefined;
  if (existing) return existing.token;
  return mintLinkToken(sessionId);
}

export function redeemLinkToken(token: string, ownerId: string): { sessionId: string } {
  const db = getDb();
  const row = db
    .prepare("SELECT token, session_id, expires_at, used_at FROM session_links WHERE token = ?")
    .get(token) as LinkRow | undefined;

  if (!row) throw new NotFoundError("Unknown link token");
  if (row.used_at) throw new ConflictError("Link token already used");

  const fresh = db
    .prepare("SELECT 1 AS ok FROM session_links WHERE token = ? AND expires_at > datetime('now')")
    .get(token) as { ok: number } | undefined;
  if (!fresh) throw new NotFoundError("Link token expired");

  // Minting is unauthenticated (the hook only knows a session id, not a user), so
  // anyone who learns a colleague's session id could mint a token for it. Refuse to
  // hand that session to a different owner here rather than trusting the token alone,
  // and don't burn the token on refusal — the rightful owner may still redeem it.
  const existingOwner = sessionOwner(row.session_id);
  if (existingOwner && existingOwner !== ownerId) {
    throw new ConflictError("Session already belongs to another user");
  }

  // CAS guard: only flip used_at when it's still NULL. node:sqlite is synchronous and
  // this module never awaits between the read above and this write, so there's no
  // actual race today — this is defence in depth against a future change (e.g. an
  // async hook) reintroducing one, not a fix for a race that exists now.
  const result = db
    .prepare("UPDATE session_links SET used_at = datetime('now'), used_by = ? WHERE token = ? AND used_at IS NULL")
    .run(ownerId, token);
  if (Number(result.changes ?? 0) === 0) {
    throw new ConflictError("Link token already used");
  }

  linkSession(ownerId, row.session_id);

  return { sessionId: row.session_id };
}

export function sessionOwner(sessionId: string): string | null {
  const row = getDb()
    .prepare("SELECT owner_id FROM sessions WHERE id = ?")
    .get(sessionId) as { owner_id: string } | undefined;
  return row?.owner_id ?? null;
}
