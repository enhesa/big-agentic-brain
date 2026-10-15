import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { AuditVia } from "./types";

/** Either a bare actor id (legacy call sites) or a full actor with name/email. */
export type AuditActor = string | { id: string; name?: string | null; email?: string | null };

// node:sqlite prepared statements are tied to the DatabaseSync instance that
// created them, so the cache is keyed on the instance itself (not a module
// singleton) and must be cleared whenever db.ts swaps in a fresh instance
// (see _resetDbForTests in lib/db.ts).
let cachedDb: DatabaseSync | null = null;
let cachedInsert: StatementSync | null = null;

function insertStatement(db: DatabaseSync): StatementSync {
  if (cachedDb !== db || !cachedInsert) {
    cachedDb = db;
    cachedInsert = db.prepare(
      `INSERT INTO audit_log (actor_id, actor_name, actor_email, action, entity, entity_id, via, ip, path, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }
  return cachedInsert;
}

/** Test-only / internal: drop the cached prepared statement (the DatabaseSync it's bound to is gone). */
export function _resetAuditStatementCache() {
  cachedDb = null;
  cachedInsert = null;
}

export function audit(
  db: DatabaseSync,
  actor: AuditActor,
  action: string,
  entity: string,
  entityId: string,
  via: AuditVia,
  extra?: { ip?: string | null; path?: string | null; details?: unknown },
) {
  const actorId = typeof actor === "string" ? actor : actor.id;
  const actorName = typeof actor === "string" ? null : (actor.name ?? null);
  const actorEmail = typeof actor === "string" ? null : (actor.email ?? null);
  const details = extra?.details !== undefined ? JSON.stringify(extra.details) : null;

  insertStatement(db).run(
    actorId,
    actorName,
    actorEmail,
    action,
    entity,
    entityId,
    via,
    extra?.ip ?? null,
    extra?.path ?? null,
    details,
  );
}
