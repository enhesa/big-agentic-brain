import { randomBytes } from "node:crypto";
import { getDb } from "./db";

/**
 * MCP connections: the `Mcp-Session-Id` BAB issues on initialize (MCP streamable HTTP). A client
 * that keeps no device secret still sends the id back on its later requests, so bab_identify can
 * remember who it said it was for the life of that connection (lib/identify.ts, "connection").
 *
 * Deliberately more tolerant than the MCP spec, which says an unknown session id must be a 404:
 * here an unknown, expired or malformed id is just "no connection". A client that holds a stale
 * id (BAB restarted, the row expired) must still be able to connect, list tools and identify
 * again; a 404 would strand it. The id is not a secret worth defending beyond that: identity is an
 * honour system (the deployment must sit on a private network, behind an authenticating proxy,
 * or use bound tokens), and an id only ever names a person the connection
 * itself claimed to be.
 */

export const MCP_SESSION_HEADER = "mcp-session-id";
/** Connections not seen for this long are deleted by the maintenance sweep. */
export const CONNECTION_TTL_DAYS = 7;
/** last_seen_at is written at most this often per connection, so reads do not become writes. */
export const CONNECTION_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{43}$/;

let clock: () => number = () => Date.now();

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

/**
 * A new session id: 32 random bytes as base64url. It only MINTS the id and writes nothing, so
 * initialize (which any caller can make, unaudited) cannot fill the table. The row is written
 * when a client calls bab_identify with the id (bindConnection adopts a well-formed unseen id).
 */
export function createConnection(): string {
  return randomBytes(32).toString("base64url");
}

/** Test-only: a connection row that exists but never identified, the way an old initialize left one. */
export function _insertConnectionForTests(id: string = randomBytes(32).toString("base64url")): string {
  const now = clock();
  getDb().prepare("INSERT INTO mcp_connections (id, user_id, created_at, last_seen_at) VALUES (?, NULL, ?, ?)").run(id, now, now);
  return id;
}

export interface ConnectionRow {
  id: string;
  /** Null until the client called bab_identify. */
  userId: string | null;
}

/**
 * The connection behind a session id, or null for anything unknown or malformed. last_seen_at is
 * refreshed at most every CONNECTION_SEEN_WRITE_INTERVAL_MS.
 */
export function lookupConnection(id: unknown): ConnectionRow | null {
  if (!isSessionId(id)) return null;
  const db = getDb();
  const row = db.prepare("SELECT id, user_id, last_seen_at FROM mcp_connections WHERE id = ?").get(id) as
    | { id: string; user_id: string | null; last_seen_at: number }
    | undefined;
  if (!row) return null;
  const now = clock();
  // Past its life the row is as good as gone (the sweep deletes it hourly): not a connection, and
  // not refreshed, or a stale id could be kept alive by being presented.
  if (row.last_seen_at <= now - CONNECTION_TTL_DAYS * DAY_MS) return null;
  if (row.last_seen_at <= now - CONNECTION_SEEN_WRITE_INTERVAL_MS) {
    db.prepare("UPDATE mcp_connections SET last_seen_at = ? WHERE id = ?").run(now, id);
  }
  return { id: row.id, userId: row.user_id };
}

/**
 * Binds a connection to a person. A well-formed id BAB has not seen is adopted (inserted), so a
 * client holding a stale id is not stranded; a malformed one is refused.
 */
export function bindConnection(id: string, userId: string): void {
  if (!isSessionId(id)) throw new Error("not a session id");
  const now = clock();
  getDb()
    .prepare(
      `INSERT INTO mcp_connections (id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, last_seen_at = excluded.last_seen_at`,
    )
    .run(id, userId, now, now);
}

export interface ConnectionSummary {
  createdAt: number;
  lastSeenAt: number;
}

/**
 * The person's identified connections seen in the last CONNECTION_TTL_DAYS, newest first, for
 * /me/devices. The id itself is never listed.
 */
export function listRecentConnections(userId: string): ConnectionSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT created_at, last_seen_at FROM mcp_connections
       WHERE user_id = ? AND last_seen_at > ? ORDER BY last_seen_at DESC, rowid DESC`,
    )
    .all(userId, clock() - CONNECTION_TTL_DAYS * DAY_MS) as { created_at: number; last_seen_at: number }[];
  return rows.map((r) => ({ createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
}

/** Ends every connection that identified as this person ("Forget all", a maintainer unlink). Returns how many. */
export function deleteConnectionsForUser(userId: string): number {
  const res = getDb().prepare("DELETE FROM mcp_connections WHERE user_id = ?").run(userId);
  return Number(res.changes ?? 0);
}

/** Deletes connections not seen for CONNECTION_TTL_DAYS, identified or not. Run by the maintenance sweep. */
export function expireStaleConnections(): number {
  const res = getDb().prepare("DELETE FROM mcp_connections WHERE last_seen_at <= ?").run(clock() - CONNECTION_TTL_DAYS * DAY_MS);
  return Number(res.changes ?? 0);
}

/** Test-only: inject a fake clock. Reset by passing nothing. */
export function _setConnectionClockForTests(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}
