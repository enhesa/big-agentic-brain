import { getDb } from "./db";
import { audit } from "./audit";
import { derivedNameFromEmail, namesMatchLoosely, isValidIdentityEmail } from "./identity";
import { redact } from "./redact";
import type { AuditVia, PublicUser, UserRow } from "./types";
import type { ForgeUser } from "./user";

/**
 * Upsert the user row on each request that has an id. Identity is the email
 * (well, the id): the display name is fixed at first use and never silently
 * overwritten by a later request that shows up with a different name for the
 * same known id. A mismatch is recorded (`name_mismatch`, both names in
 * `audit_log.details`) but the stored name wins; the request's name is used
 * nowhere. To actually rename, call `renameUser` (POST /api/me), which is
 * the one deliberate, audited path.
 */
export function upsertUser(user: ForgeUser, via: AuditVia = "mcp"): UserRow {
  const db = getDb();
  const existing = getUser(user.id);

  // On first sight of a user, prefer the header-supplied name only when it's
  // recognizably the same name as the one derived from the email (loosely,
  // ignoring case/accents/punctuation/order) — otherwise the derived name
  // wins and the override is audited. Existing rows are never touched here.
  let nameToStore = user.name ? redact(user.name) : user.name;
  if (!existing && user.email && isValidIdentityEmail(user.email) && user.email.split("@")[0].includes(".")) {
    const derived = derivedNameFromEmail(user.email);
    if (!user.name || !namesMatchLoosely(user.name, derived)) {
      nameToStore = derived;
      audit(db, user.id, "name_from_email", "user", user.id, via, {
        details: { headerName: user.name, derivedName: derived },
      });
    }
  }

  db.prepare(
    `INSERT INTO users (id, email, name, roles, last_seen_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       roles = excluded.roles,
       last_seen_at = datetime('now')`,
  ).run(user.id, user.email, nameToStore, user.roles.join(" "));

  if (existing?.name && user.name && existing.name !== user.name) {
    audit(db, user.id, "name_mismatch", "user", user.id, via, {
      details: { storedName: existing.name, incomingName: user.name },
    });
  }

  return db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as unknown as UserRow;
}

/** The one deliberate, audited way to change a user's display name. */
export function renameUser(id: string, newName: string, via: AuditVia = "mcp"): UserRow {
  const db = getDb();
  const existing = getUser(id);
  const oldName = existing?.name ?? null;

  newName = redact(newName);
  db.prepare("UPDATE users SET name = ? WHERE id = ?").run(newName, id);
  audit(db, id, "rename", "user", id, via, { details: { oldName, newName } });

  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow;
}

/**
 * The user as an agent or an API caller may see them: id, email, name, roles, created_at,
 * last_seen_at and trust, copied one by one. NEVER spread a users row into a response: the table
 * holds internal columns (require_confirm_until, and whatever is added next) that must stay on
 * the server.
 */
export function publicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    roles: u.roles,
    created_at: u.created_at,
    last_seen_at: u.last_seen_at,
    trust: u.trust,
  };
}

export function listUsers(): UserRow[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM users ORDER BY last_seen_at DESC")
    .all() as unknown as UserRow[];
}

export const USERS_PAGE_SIZE = 10;

/** One page of the directory, most recently seen first. `page` is 1-based and clamped to the last page. */
export function listUsersPage(
  page: number,
  pageSize = USERS_PAGE_SIZE,
): { users: UserRow[]; page: number; pages: number; total: number } {
  const db = getDb();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as unknown as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const users = db
    .prepare("SELECT * FROM users ORDER BY last_seen_at DESC, id LIMIT ? OFFSET ?")
    .all(pageSize, (current - 1) * pageSize) as unknown as UserRow[];
  return { users, page: current, pages, total };
}

export function getUser(id: string): UserRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as | UserRow
    | undefined;
}

/**
 * Batched lookup: one query for many ids instead of N getUser() round-trips
 * in a loop (used by listAllThreads/threadForViewer to resolve participant
 * names/emails). Missing ids are simply absent from the returned map.
 */
export function getUsersByIds(ids: string[]): Map<string, UserRow> {
  const map = new Map<string, UserRow>();
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return map;

  const db = getDb();
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM users WHERE id IN (${placeholders})`)
    .all(...unique) as unknown as UserRow[];
  for (const row of rows) map.set(row.id, row);
  return map;
}

/** Count of active learnings authored by each user, keyed by author_id. */
export function learningCountsByAuthor(): Record<string, number> {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT author_id AS authorId, COUNT(*) AS n FROM learnings WHERE status != 'deleted' GROUP BY author_id",
    )
    .all() as unknown as { authorId: string; n: number }[];
  const map: Record<string, number> = {};
  for (const r of rows) map[r.authorId] = r.n;
  return map;
}
