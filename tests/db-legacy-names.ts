import type { DatabaseSync } from "node:sqlite";

/**
 * Puts a current database's browser-link table, key column, device link column and their indexes
 * back to the names they had before migration v44. Tests that rewind the migrations table to re-run
 * an old migration call this first: the old blocks still say the old names, as they did when they
 * ran on real databases.
 */
export function useLegacyProxyNames(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_proxy_links_user;
    DROP INDEX IF EXISTS idx_devices_proxy;
    ALTER TABLE proxy_links RENAME COLUMN proxy_user_id TO forge_user_id;
    ALTER TABLE proxy_links RENAME TO forge_links;
    ALTER TABLE devices RENAME COLUMN bound_via_proxy_id TO bound_via_forge_id;
    CREATE UNIQUE INDEX idx_forge_links_user ON forge_links(user_id);
    CREATE INDEX idx_devices_forge ON devices(bound_via_forge_id);
  `);
}
