import { DatabaseSync } from "node:sqlite";
import { deriveProjectFromRepo, normalizeProjectKey } from "./project-key";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { _resetAuditStatementCache } from "./audit";

let db: DatabaseSync | null = null;
let closedForShutdown = false;

// Keep in step with the last `if (appliedVersion < N)` block in runMigrations: while this lagged at 26
// beside a v27 block, a database already at 26 returned early and never got v27. tests/db.test.ts
// guards it.
export const CURRENT_VERSION = 50;

/** The data directory (DATA_DIR, default /data). The one env read allowed in this file. */
export function resolveDataDir(): string {
  return process.env.DATA_DIR || "/data";
}

function resolveDbPath(): string {
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return path.join(dataDir, "bab.db");
}

function runMigrations(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const row = database
    .prepare("SELECT MAX(version) AS version FROM migrations")
    .get() as { version: number | null } | undefined;
  let appliedVersion = row?.version ?? 0;

  if (appliedVersion >= CURRENT_VERSION) return;

  if (appliedVersion < 1) {
    runMigrationV1(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(1);
    appliedVersion = 1;
  }

  if (appliedVersion < 2) {
    runMigrationV2(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(2);
    appliedVersion = 2;
  }

  if (appliedVersion < 3) {
    runMigrationV3(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(3);
    appliedVersion = 3;
  }

  if (appliedVersion < 4) {
    runMigrationV4(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(4);
    appliedVersion = 4;
  }

  if (appliedVersion < 5) {
    runMigrationV5(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(5);
    appliedVersion = 5;
  }

  if (appliedVersion < 6) {
    runMigrationV6(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(6);
    appliedVersion = 6;
  }

  if (appliedVersion < 7) {
    runMigrationV7(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(7);
    appliedVersion = 7;
  }

  if (appliedVersion < 8) {
    runMigrationV8(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(8);
    appliedVersion = 8;
  }

  if (appliedVersion < 9) {
    runMigrationV9(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(9);
    appliedVersion = 9;
  }

  if (appliedVersion < 10) {
    runMigrationV10(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(10);
    appliedVersion = 10;
  }

  if (appliedVersion < 11) {
    runMigrationV11(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(11);
    appliedVersion = 11;
  }

  if (appliedVersion < 12) {
    runMigrationV12(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(12);
    appliedVersion = 12;
  }

  if (appliedVersion < 13) {
    runMigrationV13(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(13);
    appliedVersion = 13;
  }

  if (appliedVersion < 14) {
    runMigrationV14(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(14);
    appliedVersion = 14;
  }

  if (appliedVersion < 15) {
    runMigrationV15(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(15);
    appliedVersion = 15;
  }

  if (appliedVersion < 16) {
    runMigrationV16(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(16);
    appliedVersion = 16;
  }

  if (appliedVersion < 17) {
    runMigrationV17(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(17);
    appliedVersion = 17;
  }

  if (appliedVersion < 18) {
    runMigrationV18(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(18);
    appliedVersion = 18;
  }

  if (appliedVersion < 19) {
    runMigrationV19(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(19);
    appliedVersion = 19;
  }

  if (appliedVersion < 20) {
    wipeChats(database, resolveDataDir());
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(20);
    appliedVersion = 20;
  }

  if (appliedVersion < 21) {
    runMigrationV21(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(21);
    appliedVersion = 21;
  }

  if (appliedVersion < 22) {
    runMigrationV22(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(22);
    appliedVersion = 22;
  }

  if (appliedVersion < 23) {
    runMigrationV23(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(23);
    appliedVersion = 23;
  }

  if (appliedVersion < 24) {
    runMigrationV24(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(24);
    appliedVersion = 24;
  }

  if (appliedVersion < 25) {
    runMigrationV25(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(25);
    appliedVersion = 25;
  }

  if (appliedVersion < 26) {
    runMigrationV26(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(26);
    appliedVersion = 26;
  }

  if (appliedVersion < 27) {
    runMigrationV27(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(27);
    appliedVersion = 27;
  }

  if (appliedVersion < 28) {
    runMigrationV28(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(28);
    appliedVersion = 28;
  }

  if (appliedVersion < 29) {
    runMigrationV29(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(29);
    appliedVersion = 29;
  }

  if (appliedVersion < 30) {
    runMigrationV30(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(30);
    appliedVersion = 30;
  }

  if (appliedVersion < 31) {
    runMigrationV31(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(31);
    appliedVersion = 31;
  }

  if (appliedVersion < 32) {
    runMigrationV32(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(32);
    appliedVersion = 32;
  }

  if (appliedVersion < 33) {
    runMigrationV33(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(33);
    appliedVersion = 33;
  }

  if (appliedVersion < 34) {
    runMigrationV34(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(34);
    appliedVersion = 34;
  }

  if (appliedVersion < 35) {
    runMigrationV35(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(35);
    appliedVersion = 35;
  }

  if (appliedVersion < 36) {
    runMigrationV36(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(36);
    appliedVersion = 36;
  }

  if (appliedVersion < 37) {
    runMigrationV37(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(37);
    appliedVersion = 37;
  }
  if (appliedVersion < 38) {
    runMigrationV38(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(38);
    appliedVersion = 38;
  }
  if (appliedVersion < 39) {
    runMigrationV39(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(39);
    appliedVersion = 39;
  }
  if (appliedVersion < 40) {
    runMigrationV40(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(40);
    appliedVersion = 40;
  }
  if (appliedVersion < 41) {
    runMigrationV41(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(41);
    appliedVersion = 41;
  }
  if (appliedVersion < 42) {
    runMigrationV42(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(42);
    appliedVersion = 42;
  }
  if (appliedVersion < 43) {
    runMigrationV43(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(43);
    appliedVersion = 43;
  }
  if (appliedVersion < 44) {
    runMigrationV44(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(44);
    appliedVersion = 44;
  }
  if (appliedVersion < 45) {
    runMigrationV45(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(45);
    appliedVersion = 45;
  }
  if (appliedVersion < 46) {
    runMigrationV46(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(46);
    appliedVersion = 46;
  }
  if (appliedVersion < 47) {
    runMigrationV47(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(47);
    appliedVersion = 47;
  }

  if (appliedVersion < 48) {
    runMigrationV48(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(48);
    appliedVersion = 48;
  }

  if (appliedVersion < 49) {
    runMigrationV49(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(49);
    appliedVersion = 49;
  }

  if (appliedVersion < 50) {
    runMigrationV50(database);
    database.prepare("INSERT INTO migrations (version) VALUES (?)").run(50);
    appliedVersion = 50;
  }
}

function runMigrationV50(database: DatabaseSync) {
  // Comments on memories (lib/memory-comments.ts): colleagues add context to a memory from its page
  // or with bab_react comment. A delete is soft: deleted_at is set and the body is blanked, so the
  // page can say "comment removed" in its place. Foreign keys like votes: the purge of a deleted
  // learning removes its comments first (lib/maintenance.ts). Not in learnings_fts on purpose.
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_comments (
      id TEXT PRIMARY KEY,
      learning_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      edited_at TEXT,
      deleted_at TEXT,
      FOREIGN KEY (learning_id) REFERENCES learnings(id),
      FOREIGN KEY (author_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_comments_learning ON memory_comments(learning_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_memory_comments_author ON memory_comments(author_id, created_at);
  `);
}

function runMigrationV49(database: DatabaseSync) {
  // Measured agent effort (docs/savings.md, "Measured savings"): what the plugin measured before a
  // save (discovery cost) and between a search and a helpful or kudos reaction (reuse cost). Numbers
  // only. Own tables, not columns: learnings and votes are read with SELECT *, and these numbers must
  // not ride along in every search answer. No foreign keys: rows go with their learning's purge
  // (lib/maintenance.ts) and with the vote they belong to (lib/learnings.ts vote()).
  database.exec(`
    CREATE TABLE IF NOT EXISTS learning_costs (
      learning_id TEXT PRIMARY KEY,
      active_ms INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reuse_costs (
      learning_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      active_ms INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      usd REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (learning_id, voter_id, kind)
    );
  `);
}

/** Columns that held people's first prompts, folders and computer names for the removed session list. */
export const CLEARED_SESSION_COLUMNS: Record<string, string[]> = {
  sessions: ["title", "cwd", "name", "host", "pid"],
  session_links: ["title", "cwd"],
};

function runMigrationV48(database: DatabaseSync) {
  // A time of day on reminders: todos.due_has_time is 1 when due_at is a UTC instant
  // ("YYYY-MM-DDTHH:MM:SSZ"), 0 for a date-only day. Existing rows stay date-only. The column add is
  // guarded (ALTER TABLE has no IF NOT EXISTS), so a run that died before the version row can repeat.
  const cols = database.prepare("PRAGMA table_info(todos)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "due_has_time")) {
    database.exec("ALTER TABLE todos ADD COLUMN due_has_time INTEGER NOT NULL DEFAULT 0");
  }
}

function runMigrationV47(database: DatabaseSync) {
  // Search recall: an author can list other wordings, symptoms and error strings a colleague
  // would search for (bab_learn aliases). They live in learnings.aliases (JSON text, like tags)
  // and in a fourth FTS column, so a memory is found by its alias alone. The column add is
  // guarded (ALTER TABLE has no IF NOT EXISTS). The FTS table is rebuilt as in v46, and the three
  // triggers are recreated because they name the columns. Everything is idempotent and runs in ONE
  // transaction: a failure rolls the DROPs back instead of leaving search without an index.
  inTransaction(database, () => {
    const cols = database.prepare("PRAGMA table_info(learnings)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "aliases")) database.exec("ALTER TABLE learnings ADD COLUMN aliases TEXT NOT NULL DEFAULT '[]'");
    database.exec(`
      DROP TRIGGER IF EXISTS learnings_ai;
      DROP TRIGGER IF EXISTS learnings_ad;
      DROP TRIGGER IF EXISTS learnings_au;
      DROP TABLE IF EXISTS learnings_fts;
      CREATE VIRTUAL TABLE learnings_fts USING fts5(
        title, body, tags, aliases, content='learnings', content_rowid='rowid', tokenize='porter unicode61'
      );
      CREATE TRIGGER learnings_ai AFTER INSERT ON learnings BEGIN
        INSERT INTO learnings_fts(rowid, title, body, tags, aliases)
        VALUES (new.rowid, new.title, new.body, new.tags, new.aliases);
      END;
      CREATE TRIGGER learnings_ad AFTER DELETE ON learnings BEGIN
        INSERT INTO learnings_fts(learnings_fts, rowid, title, body, tags, aliases)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags, old.aliases);
      END;
      CREATE TRIGGER learnings_au AFTER UPDATE ON learnings
      WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.tags IS NOT new.tags OR old.aliases IS NOT new.aliases
      BEGIN
        INSERT INTO learnings_fts(learnings_fts, rowid, title, body, tags, aliases)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags, old.aliases);
        INSERT INTO learnings_fts(rowid, title, body, tags, aliases)
        VALUES (new.rowid, new.title, new.body, new.tags, new.aliases);
      END;
      INSERT INTO learnings_fts(learnings_fts) VALUES ('rebuild');
    `);
  });
}

function runMigrationV46(database: DatabaseSync) {
  // Search recall: index with the porter stemmer so "restarts" finds "restart" and "rounding"
  // finds "rounded". Only the tokenizer changes; the columns, content table and triggers stay.
  // DROP IF EXISTS plus CREATE plus rebuild can run twice, so a process that died half way
  // boots again. The triggers keep working because they name the table, not its definition.
  // One transaction: a failure in the rebuild rolls the DROP back instead of leaving search
  // without an index.
  inTransaction(database, () => {
    database.exec(`
      DROP TABLE IF EXISTS learnings_fts;
      CREATE VIRTUAL TABLE learnings_fts USING fts5(
        title, body, tags, content='learnings', content_rowid='rowid', tokenize='porter unicode61'
      );
      INSERT INTO learnings_fts(learnings_fts) VALUES ('rebuild');
    `);
  });
}

function runMigrationV45(database: DatabaseSync) {
  // A person's home team (one of the team tags, kept apart from post tags) and the knowledge
  // areas they volunteered to be a contact for. Both are the person's own opt-in. The column add
  // is guarded (ALTER TABLE has no IF NOT EXISTS) so a process that died before the migrations
  // row boots again; the table is IF NOT EXISTS for the same reason.
  const cols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "home_team")) database.exec("ALTER TABLE users ADD COLUMN home_team TEXT");
  database.exec(`
    CREATE TABLE IF NOT EXISTS area_contacts (
      area TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (area, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_area_contacts_user ON area_contacts(user_id);
  `);
}

function runMigrationV44(database: DatabaseSync) {
  // The first deployment's sign-in proxy had its own product name in the schema. Everything is
  // renamed to "proxy": the browser-link table, its key column, the device's link column and
  // their indexes. Each step is guarded on what exists (ALTER TABLE has no IF NOT EXISTS), so a
  // process that died half way, or a database that never had the old names, boots again.
  // One way: an older release cannot read the renamed schema (rollback note in docs/spec.md).
  // The audit log is left alone, so old claim rows keep their old keys (lib/proxy-links.ts reads both).
  const hasTable = (name: string) =>
    !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const columnsOf = (table: string) =>
    new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));

  if (hasTable("forge_links") && !hasTable("proxy_links")) {
    database.exec("ALTER TABLE forge_links RENAME TO proxy_links");
  }
  if (hasTable("proxy_links")) {
    const cols = columnsOf("proxy_links");
    if (cols.has("forge_user_id") && !cols.has("proxy_user_id")) {
      database.exec("ALTER TABLE proxy_links RENAME COLUMN forge_user_id TO proxy_user_id");
    }
  }
  if (hasTable("devices")) {
    const cols = columnsOf("devices");
    if (cols.has("bound_via_forge_id") && !cols.has("bound_via_proxy_id")) {
      database.exec("ALTER TABLE devices RENAME COLUMN bound_via_forge_id TO bound_via_proxy_id");
    }
  }
  // A table rename keeps index names, so the old-named ones are dropped and made again under the new names.
  if (hasTable("proxy_links")) {
    database.exec(`
      DROP INDEX IF EXISTS idx_forge_links_user;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_links_user ON proxy_links(user_id);
    `);
  }
  if (hasTable("devices") && columnsOf("devices").has("bound_via_proxy_id")) {
    database.exec(`
      DROP INDEX IF EXISTS idx_devices_forge;
      CREATE INDEX IF NOT EXISTS idx_devices_proxy ON devices(bound_via_proxy_id);
    `);
  }
  // learnings.applies_to is left alone on purpose: a stored label the app no longer lists still reads
  // (lib/applies-to.ts readAppliesTo never validates); only writes and filters are checked.
}

function runMigrationV43(database: DatabaseSync) {
  // Who pinned a house rule and when (lib/learnings.ts setPinned): pinned rules go into every
  // session's first prompt, so the pin is attributable. NULL for rules pinned before this and
  // for every unpinned row. Same PRAGMA guard as v39: ALTER TABLE has no IF NOT EXISTS, so a
  // process that died between the column add and the migrations row must still be able to boot.
  const columns = new Set(
    (database.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("pinned_by")) database.exec("ALTER TABLE learnings ADD COLUMN pinned_by TEXT");
  if (!columns.has("pinned_at")) database.exec("ALTER TABLE learnings ADD COLUMN pinned_at TEXT");
}

function runMigrationV42(database: DatabaseSync) {
  // The session list is gone (2026-10-07: messaging is async and inbox driven), so BAB no longer
  // keeps session titles (people's first prompts), folders, session names, host names or pids
  // (clearing them was approved). Nothing writes these columns any more (lib/sessions.ts,
  // lib/session-links.ts); the columns stay, unused. Guarded on each table and column existing,
  // and idempotent: a NULL stays NULL.
  for (const [table, wanted] of Object.entries(CLEARED_SESSION_COLUMNS)) {
    const present = new Set(
      (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    const cols = wanted.filter((c) => present.has(c));
    if (cols.length === 0) continue;
    database.exec(
      `UPDATE ${table} SET ${cols.map((c) => `${c} = NULL`).join(", ")} WHERE ${cols.map((c) => `${c} IS NOT NULL`).join(" OR ")}`,
    );
  }
}

function runMigrationV41(database: DatabaseSync) {
  // Applies-to labels (lib/applies-to.ts): a JSON array of stack or platform labels a memory holds
  // for, '[]' (applies everywhere) for every existing row. Same PRAGMA guard as v39: ALTER TABLE has
  // no IF NOT EXISTS, so a process that died between the column add and the migrations row must
  // still be able to boot.
  const columns = new Set(
    (database.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("applies_to")) {
    database.exec("ALTER TABLE learnings ADD COLUMN applies_to TEXT NOT NULL DEFAULT '[]'");
  }
}

function runMigrationV40(database: DatabaseSync) {
  // Reads replace expiry. Memories no longer expire after 180 days: an AGENT read
  // is recorded per memory (last_accessed_at, access_days; lib/learnings.ts touchRead) and the hourly
  // sweep archives a memory that no agent has read for a year (lib/maintenance.ts sweepInactive).
  // Same PRAGMA guard as v36/v37/v39: ALTER TABLE has no IF NOT EXISTS, so a process that died
  // between the column add and the migrations row must still be able to boot.
  const columns = new Set(
    (database.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("last_accessed_at")) database.exec("ALTER TABLE learnings ADD COLUMN last_accessed_at TEXT");
  if (!columns.has("access_days")) database.exec("ALTER TABLE learnings ADD COLUMN access_days INTEGER NOT NULL DEFAULT 0");
  // The default expiry is gone: a memory whose date the author did not choose has none now, archived
  // ones included (a restore must not be blocked by, or archived again for, a date nobody chose).
  // An expiry the author passed (expires_explicit = 1) stays as their valid-until date.
  database.exec(`
    UPDATE learnings SET expires_at = NULL
    WHERE expires_explicit = 0 AND expires_at IS NOT NULL
  `);
  // The `expiring` status is gone too (it only ever meant "inside the 14-day window before expires_at").
  database.exec("UPDATE learnings SET status = 'active' WHERE status = 'expiring'");
  // No backfill of reads: there is no history. lib/learnings.ts INACTIVITY_CLOCK_START keeps every
  // inactivity clock from starting before the day this shipped, so nothing is archived for a year.
}

function runMigrationV39(database: DatabaseSync) {
  // House rules (2026-10-07): a pinned standard or practice is put in front of every session on its
  // first prompt (app/api/hook/route.ts, houseRulesFor in lib/learnings.ts). An explicit opt-in so
  // the digest stays small and curated; bab_react pin and unpin set it. With BAB_MAINTAINERS set
  // only maintainers may (setPinned in lib/learnings.ts); with none configured it is an honour
  // system. v43 adds pinned_by and pinned_at.
  // Same PRAGMA guard as v36/v37: ALTER TABLE has no IF NOT EXISTS, so a process that died between
  // the column add and the migrations row must still be able to boot.
  const columns = new Set(
    (database.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("pinned")) database.exec("ALTER TABLE learnings ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
}

function runMigrationV37(database: DatabaseSync) {
  // Which model wrote a memory, so memories from one model can be
  // traced and re-checked. Optional and self-declared: NULL for every existing row and for any
  // caller that does not pass one. It does not feed standing or confidence.
  // Same PRAGMA guard as v21/v35/v36: ALTER TABLE has no IF NOT EXISTS, so a process that died
  // between the column add and the migrations row must still be able to boot.
  const columns = new Set(
    (database.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("model")) database.exec("ALTER TABLE learnings ADD COLUMN model TEXT");
}

function runMigrationV38(database: DatabaseSync) {
  // Admin usage page (/admin/usage, lib/usage.ts): weekly numbers over the last 52 weeks must not
  // scan the whole audit log at 50k rows. (path, at) serves the bab_learn call counts and the
  // nudge-to-learn lookup; (action, at) serves the identify, duplicate-rate and stop_nudge counts.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_path_at ON audit_log(path, at);
    CREATE INDEX IF NOT EXISTS idx_audit_action_at ON audit_log(action, at);
  `);
}

function runMigrationV36(database: DatabaseSync) {
  // Expiry resets respect the author. At the time, a memory that people
  // used got its expiry pushed out (a reset by use), but an author who chose a SHORTER expiry on
  // purpose (a campaign, a freeze) must not have it extended by other people's use. The reset and
  // the default expiry were both removed by v40.
  // expires_explicit records at creation whether the author passed an expiry.
  // Same PRAGMA guard as v21/v35: ALTER TABLE has no IF NOT EXISTS, so a process that died between
  // the column add and the migrations row must still be able to boot.
  const columns = new Set(
    (database.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!columns.has("expires_explicit")) {
    database.exec("ALTER TABLE learnings ADD COLUMN expires_explicit INTEGER NOT NULL DEFAULT 0");
  }
  // Backfill what can be known. The then-default expiry was created_at + 180 days and a reset only
  // ever moved it to today + 180 days or later, so an expiry BEFORE created_at + 180 days can only be
  // a short one the author chose (and nobody has extended since). 180 is written out because a
  // migration must not change when the app's settings do.
  // Idempotent, so a process that died before the migrations row can run it again.
  database.exec(`
    UPDATE learnings SET expires_explicit = 1
    WHERE expires_explicit = 0 AND expires_at IS NOT NULL
      AND substr(expires_at, 1, 10) < date(substr(created_at, 1, 10), '+180 days')
  `);
}

function runMigrationV35(database: DatabaseSync) {
  // Standards, practices and decisions (the standards design).
  // learnings gains kind (learning, practice, standard, decision) and the provenance of a
  // Confluence mirror (source, source_url, source_version). Existing rows read back as
  // learning/native through the column defaults.
  // Same PRAGMA guard as v21: ALTER TABLE has no IF NOT EXISTS, so a process that died between
  // a column add and the migrations row must still be able to boot.
  // No CHECK constraints: the allowed values are validated in lib/learnings.ts, so a fourth
  // kind later does not need a table rebuild.
  const columns = new Set(
    (database.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const additions: Array<[string, string]> = [
    ["kind", "TEXT NOT NULL DEFAULT 'learning'"],
    ["source", "TEXT NOT NULL DEFAULT 'native'"],
    ["source_url", "TEXT"],
    ["source_version", "INTEGER"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE learnings ADD COLUMN ${name} ${definition}`);
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_learnings_kind_status ON learnings(kind, status)");
}

function runMigrationV34(database: DatabaseSync) {
  // Honour-system identity: a client says who it is with bab_identify and BAB
  // remembers it on the device secret, else on the MCP connection. mcp_connections holds the
  // Mcp-Session-Id BAB issues on initialize (user_id NULL until the client identified). Times are
  // epoch milliseconds; the maintenance sweep deletes rows unseen for 7 days.
  // The SSO connect flow is retired with its table: device_connects (and its indexes) go.
  // users.require_confirm_until stays as an unused column.
  database.exec(`
    CREATE TABLE IF NOT EXISTS mcp_connections (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_connections_user ON mcp_connections(user_id);
    CREATE INDEX IF NOT EXISTS idx_mcp_connections_seen ON mcp_connections(last_seen_at);
    DROP TABLE IF EXISTS device_connects;
  `);
}

function runMigrationV33(database: DatabaseSync) {
  // A security test on live (2026-10-01 10:50) sent a made-up X-Bab-Actor identity and left a
  // users row behind: someone.else@example.com, "Someone Else". Deleting it was approved
  // (2026-10-01). Only that exact row (id AND name), and only when nothing refers to it, so a
  // real person who one day gets that address and has data is never touched. No-op where the row
  // does not exist (fresh databases, tests) and when run again. audit_log is left alone on purpose.
  const id = "someone.else@example.com";
  const name = "Someone Else";
  if (!database.prepare("SELECT 1 FROM users WHERE id = ? AND name = ?").get(id, name)) return;

  // "Anything that refers to it" is found by looking at every column of every table for the id,
  // not by a list of the columns I know of: a table added later, or one I forgot, still counts.
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'")
    .all() as { name: string }[];
  const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
  for (const { name: table } of tables) {
    if (table === "users" || table === "audit_log" || table === "migrations") continue;
    const columns = database.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[];
    for (const { name: column } of columns) {
      if (database.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${quote(column)} = ? LIMIT 1`).get(id)) {
        console.warn(`bab: migration v33 kept ${id}: it is referenced by ${table}.${column}`);
        return;
      }
    }
  }
  database.prepare("DELETE FROM users WHERE id = ? AND name = ?").run(id, name);
}

function runMigrationV32(database: DatabaseSync) {
  // After any revoke of a person's device, connecting a device as them needs a click for 30
  // days (lib/devices.ts canAutoBind). Epoch milliseconds, NULL when never revoked.
  const cols = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  // A process that died between the ALTER and the migrations row must boot again.
  if (!cols.some((c) => c.name === "require_confirm_until")) {
    database.exec("ALTER TABLE users ADD COLUMN require_confirm_until INTEGER");
  }
}

function runMigrationV31(database: DatabaseSync) {
  // Security review of devices (2026-10-01). A connect link now remembers where it was asked
  // for: requester_ip is the address the connect page compares with the viewer's, and the two
  // raw forwarding headers are kept only so the proxy topology can be checked after a deploy.
  // A device keeps that address as connected_ip, and owner_seen_at drives the "new device"
  // notice on /me/devices (NULL until the owner has looked at the list).
  const addColumn = (table: string, column: string, type: string) => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    // A process that died between the ALTER and the migrations row must boot again.
    if (!cols.some((c) => c.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn("device_connects", "requester_ip", "TEXT");
  addColumn("device_connects", "raw_xff", "TEXT");
  addColumn("device_connects", "raw_real_ip", "TEXT");
  addColumn("devices", "connected_ip", "TEXT");
  addColumn("devices", "owner_seen_at", "INTEGER");

  // The per-address link limit and the "is this address shared" check both look links and
  // audit rows up by address.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_connects_ip ON device_connects(requester_ip, expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_ip_at ON audit_log(ip, at);
  `);
}

function runMigrationV30(database: DatabaseSync) {
  // Devices (the device linking design). A device is one plugin install,
  // proved by a 256-bit secret of which only the sha256 is stored. Times are epoch
  // milliseconds. The link column (renamed by v44) names the browser link the device was connected through,
  // so unlinking that browser can revoke it. A revoked row is kept (and rebound in place if the
  // same secret connects again) because secret_hash is unique.
  database.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      revoked_at INTEGER,
      bound_via_forge_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    CREATE INDEX IF NOT EXISTS idx_devices_forge ON devices(bound_via_forge_id);

    -- One-time connect links. The nonce is random and bound to the device hash, never derived
    -- from the secret. label is what the page shows so a phished link names the device.
    CREATE TABLE IF NOT EXISTS device_connects (
      nonce TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_device_connects_hash ON device_connects(secret_hash);
  `);

  // Personal tokens are gone (decided: nobody used them; devices replace them).
  // Dropping the table drops its indexes too.
  database.exec("DROP TABLE IF EXISTS api_tokens");
}

function runMigrationV29(database: DatabaseSync) {
  // The agent-mediated browser link code is gone: the browser links
  // itself on /me/devices. Its wrong-code limiters were in memory, so this table is the only
  // leftover. The browser-link table, the durable link, stays.
  database.exec("DROP TABLE IF EXISTS forge_link_codes");
}

function runMigrationV28(database: DatabaseSync) {
  // Personal API tokens (P1.1; v30 dropped the table again). Only the sha256 of a token is stored; the token itself is
  // shown once at issue. Times are epoch milliseconds. scope is 'full' or 'watch:<threadId>'.
  // The partial unique index is the "one active full token per label per user" rule, so
  // rotation (revoke the old, insert the new) cannot be raced into two live tokens.
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'full',
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      last_used_at INTEGER,
      issued_via_forge_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_tokens_forge ON api_tokens(issued_via_forge_id);
    CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_label
      ON api_tokens(user_id, label) WHERE scope = 'full' AND revoked_at IS NULL;
  `);

  // One browser per address is the rule the code enforces, but nothing in the schema did, so
  // live data may hold duplicates. Keep the most recent link per user (ties by rowid) and drop
  // the rest before the unique index, or the index creation would fail the whole migration.
  database.exec(`
    DELETE FROM forge_links WHERE rowid NOT IN (
      SELECT rowid FROM (
        SELECT rowid, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY linked_at DESC, rowid DESC) AS rn
        FROM forge_links
      ) WHERE rn = 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_forge_links_user ON forge_links(user_id);
  `);
}

function runMigrationV27(database: DatabaseSync) {
  // The browser-link code now remembers who the sign-in proxy session said the minter was, so
  // the redeem can check the claimed email against that name. Nullable because a
  // code minted before this migration has no name; such a code fails the check, expires
  // within minutes and is simply minted again. Guarded so a re-run after a crash between
  // the ALTERs and the migrations insert is harmless.
  const cols = (database.prepare("PRAGMA table_info(forge_link_codes)").all() as { name: string }[]).map((c) => c.name);
  // No table means v29 already dropped it (a re-run of old blocks), so there is nothing to alter.
  if (cols.length === 0) return;
  if (!cols.includes("forge_email")) database.exec("ALTER TABLE forge_link_codes ADD COLUMN forge_email TEXT");
  if (!cols.includes("forge_name")) database.exec("ALTER TABLE forge_link_codes ADD COLUMN forge_name TEXT");
}

function runMigrationV26(database: DatabaseSync) {
  // Browser notifications were removed, so their Web Push subscription
  // table goes too. IF EXISTS keeps a re-run after a crash between the DROP and the
  // migrations insert harmless. The index is dropped with the table.
  database.exec(`
    DROP TABLE IF EXISTS push_subscriptions;
  `);
}

function runMigrationV25(database: DatabaseSync) {
  // Feedback about BAB itself (lib/feedback.ts, docs/spec.md "Feedback"). The enums are
  // CHECK constraints so a bad value can never be stored, whatever path wrote it. The FTS
  // table follows the learnings_fts pattern (external content, kept in step by triggers).
  // feedback_comments.kind separates a maintainer's status-change record from a comment.
  // maintainer_feedback_seen remembers when each maintainer was last told about new items.
  database.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL REFERENCES users(id),
      source TEXT NOT NULL CHECK(source IN ('agent','human')),
      kind TEXT NOT NULL CHECK(kind IN ('bug','idea','improvement','question')),
      area TEXT NOT NULL CHECK(area IN ('memory','messages','reminders','notifications','hooks','plugin','mcp','web','other')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','planned','done','wontfix','duplicate')),
      duplicate_of TEXT REFERENCES feedback(id),
      client_version TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_status_created ON feedback(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_author ON feedback(author_id);

    CREATE TABLE IF NOT EXISTS feedback_votes (
      feedback_id TEXT NOT NULL REFERENCES feedback(id),
      voter_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (feedback_id, voter_id)
    );

    CREATE TABLE IF NOT EXISTS feedback_comments (
      id TEXT PRIMARY KEY,
      feedback_id TEXT NOT NULL REFERENCES feedback(id),
      author_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'comment' CHECK(kind IN ('comment','status')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_comments_item ON feedback_comments(feedback_id, created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS feedback_fts USING fts5(
      title, body, content='feedback', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS feedback_ai AFTER INSERT ON feedback BEGIN
      INSERT INTO feedback_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;

    CREATE TRIGGER IF NOT EXISTS feedback_ad AFTER DELETE ON feedback BEGIN
      INSERT INTO feedback_fts(feedback_fts, rowid, title, body)
      VALUES ('delete', old.rowid, old.title, old.body);
    END;

    CREATE TRIGGER IF NOT EXISTS feedback_au AFTER UPDATE ON feedback
    WHEN old.title IS NOT new.title OR old.body IS NOT new.body BEGIN
      INSERT INTO feedback_fts(feedback_fts, rowid, title, body)
      VALUES ('delete', old.rowid, old.title, old.body);
      INSERT INTO feedback_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;

    CREATE TABLE IF NOT EXISTS maintainer_feedback_seen (
      owner_id TEXT PRIMARY KEY,
      seen_at TEXT NOT NULL
    );
  `);
}

function runMigrationV24(database: DatabaseSync) {
  // Web Push subscriptions for browser notifications (lib/push.ts, removed again in v26). The endpoint is the
  // primary key so a browser that re-subscribes, or a shared machine that changes hands,
  // moves the row to its new owner instead of leaving two owners for one device.
  database.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_ok_at TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_owner ON push_subscriptions(owner_id);
  `);
}

function runMigrationV1(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      roles TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      trust REAL NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS learnings (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      repo TEXT,
      confidence TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TEXT,
      supersedes_id TEXT,
      score REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (author_id) REFERENCES users(id),
      FOREIGN KEY (supersedes_id) REFERENCES learnings(id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
      title, body, tags, content='learnings', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
      INSERT INTO learnings_fts(rowid, title, body, tags)
      VALUES (new.rowid, new.title, new.body, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
      INSERT INTO learnings_fts(learnings_fts, rowid, title, body, tags)
      VALUES ('delete', old.rowid, old.title, old.body, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE ON learnings BEGIN
      INSERT INTO learnings_fts(learnings_fts, rowid, title, body, tags)
      VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      INSERT INTO learnings_fts(rowid, title, body, tags)
      VALUES (new.rowid, new.title, new.body, new.tags);
    END;

    CREATE TABLE IF NOT EXISTS votes (
      learning_id TEXT NOT NULL,
      voter_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (learning_id, voter_id, kind),
      FOREIGN KEY (learning_id) REFERENCES learnings(id),
      FOREIGN KEY (voter_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      due_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      related_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      subject TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (thread_id) REFERENCES threads(id),
      FOREIGN KEY (from_id) REFERENCES users(id),
      FOREIGN KEY (to_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      via TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function runMigrationV2(database: DatabaseSync) {
  // Request-level audit fields: who (name/email, in addition to actor_id),
  // where from (ip), and which path/entry point the request hit.
  database.exec(`
    ALTER TABLE audit_log ADD COLUMN actor_name TEXT;
    ALTER TABLE audit_log ADD COLUMN actor_email TEXT;
    ALTER TABLE audit_log ADD COLUMN ip TEXT;
    ALTER TABLE audit_log ADD COLUMN path TEXT;
  `);
}

function runMigrationV3(database: DatabaseSync) {
  // Agent API: idempotency keys for POST replay, and a free-text note on
  // kudos votes (phase 3 groundwork).
  database.exec(`
    CREATE TABLE IF NOT EXISTS idempotency (
      actor_id TEXT NOT NULL,
      key TEXT NOT NULL,
      status INTEGER NOT NULL,
      body_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (actor_id, key)
    );

    ALTER TABLE votes ADD COLUMN note TEXT;
  `);
}

function runMigrationV4(database: DatabaseSync) {
  // Structured audit detail (e.g. duplicate-guard candidate ids, name mismatches)
  // belongs in its own JSON column, not crammed into `path`.
  database.exec(`
    ALTER TABLE audit_log ADD COLUMN details TEXT;
  `);
}

function runMigrationV5(database: DatabaseSync) {
  // Indexes for every hot WHERE/ORDER BY shape used by lib/**, app/api/** and
  // the people/conversations pages (see docs/spec.md "Indexes and performance").
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_learnings_status_created_at ON learnings(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learnings_author_id ON learnings(author_id);
    CREATE INDEX IF NOT EXISTS idx_learnings_supersedes_id ON learnings(supersedes_id);
    CREATE INDEX IF NOT EXISTS idx_learnings_expires_at ON learnings(expires_at);
    CREATE INDEX IF NOT EXISTS idx_learnings_repo ON learnings(repo);

    CREATE INDEX IF NOT EXISTS idx_votes_learning_kind ON votes(learning_id, kind);
    CREATE INDEX IF NOT EXISTS idx_votes_voter_id ON votes(voter_id);

    CREATE INDEX IF NOT EXISTS idx_todos_owner_status_due ON todos(owner_id, status, due_at);

    CREATE INDEX IF NOT EXISTS idx_threads_created_by ON threads(created_by);

    CREATE INDEX IF NOT EXISTS idx_messages_thread_created_at ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_to_read_at ON messages(to_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_messages_from_id ON messages(from_id);

    CREATE INDEX IF NOT EXISTS idx_audit_actor_at ON audit_log(actor_id, at);
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

    CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency(created_at);

    CREATE INDEX IF NOT EXISTS idx_users_last_seen_at ON users(last_seen_at);
  `);

  // The original learnings_au trigger fired (and rebuilt the FTS row) on
  // *every* UPDATE, including score-only (recomputeScore) or status-only
  // (supersede/flag/expiry sweep) writes that never touch title/body/tags.
  // Scope it with WHEN so those no-op FTS rebuilds stop happening.
  database.exec(`
    DROP TRIGGER IF EXISTS learnings_au;
    CREATE TRIGGER learnings_au AFTER UPDATE ON learnings
    WHEN old.title IS NOT new.title OR old.body IS NOT new.body OR old.tags IS NOT new.tags
    BEGIN
      INSERT INTO learnings_fts(learnings_fts, rowid, title, body, tags)
      VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      INSERT INTO learnings_fts(rowid, title, body, tags)
      VALUES (new.rowid, new.title, new.body, new.tags);
    END;
  `);
}

function runMigrationV6(database: DatabaseSync) {
  // Live agent-to-agent chat: presence (a colleague's agent listening for
  // replies), auto-reply labelling on messages, and a per-thread chat lease
  // recording how many auto turns the human pre-approved.
  database.exec(`
    ALTER TABLE users ADD COLUMN listening_until TEXT;
    ALTER TABLE users ADD COLUMN listen_mode TEXT;

    ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';

    ALTER TABLE threads ADD COLUMN lease_json TEXT;

    CREATE INDEX IF NOT EXISTS idx_users_listening_until ON users(listening_until);
    CREATE INDEX IF NOT EXISTS idx_messages_to_created_at ON messages(to_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_from_kind_created_at ON messages(from_id, kind, created_at);
  `);
}

function runMigrationV7(database: DatabaseSync) {
  // Active session registry: every Claude Code session heartbeats itself so
  // colleagues' agents can discover and target it (lib/sessions.ts).
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT,
      title TEXT,
      cwd TEXT,
      host TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_owner_updated_at ON sessions(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);

    ALTER TABLE messages ADD COLUMN to_session TEXT;
  `);
}

function runMigrationV8(database: DatabaseSync) {
  // Collaborative request contract (kind/goal/repo/ref/cwd/links) attached to a message,
  // stored as JSON. See lib/types.ts's MessageRequest.
  database.exec(`
    ALTER TABLE messages ADD COLUMN request TEXT;
  `);
}

function runMigrationV9(database: DatabaseSync) {
  // General-purpose scope for a learning: a repo, client, campaign, product
  // or system, for every team, not just engineering (see the pre-existing
  // `repo` column, engineering-only). Stored pre-normalized by
  // normalizeProjectKey() in lib/learnings.ts so equality filtering
  // (GET /api/learnings?project=) is a plain indexed exact match.
  // ALTER TABLE has no IF NOT EXISTS: check first, so a process that died between the
  // column add and the migrations row can boot again instead of crashing forever on
  // "duplicate column name".
  const columns = database.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "project")) {
    database.exec("ALTER TABLE learnings ADD COLUMN project TEXT");
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project)");

  // Backfill from `repo`, so the memories that already exist do not all show up as
  // scopeless on the day this ships: every engineering learning already names its repo,
  // which is exactly the project it belongs to. Uses the same helper the write path uses.
  const rows = database
    .prepare("SELECT id, repo FROM learnings WHERE project IS NULL AND repo IS NOT NULL AND trim(repo) <> ''")
    .all() as Array<{ id: string; repo: string }>;
  const update = database.prepare("UPDATE learnings SET project = ? WHERE id = ?");
  for (const row of rows) {
    const project = deriveProjectFromRepo(row.repo);
    if (project) update.run(project, row.id);
  }
}

/** Throws unless SQLite really is in WAL mode (network filesystems refuse it and fall back silently). */
export function assertWalMode(mode: unknown, dataDir: string): void {
  if (String(mode).toLowerCase() !== "wal") {
    throw new Error(
      `bab: SQLite could not enable WAL in ${dataDir}; use a local block volume (NFS, SMB and Azure Files are unsupported)`,
    );
  }
}

export function getDb(): DatabaseSync {
  if (db) return db;
  if (closedForShutdown) throw new Error("bab: database closed for shutdown");

  const dbPath = resolveDbPath();
  db = new DatabaseSync(dbPath);
  // Best effort: only when this process owns the file (a volume from an earlier deployment may belong to another UID).
  try {
    if (typeof process.getuid === "function" && statSync(dbPath).uid === process.getuid()) chmodSync(dbPath, 0o600);
  } catch (err) {
    console.warn(`bab: could not set mode 0600 on the database file: ${(err as NodeJS.ErrnoException).code ?? "unknown"}`);
  }
  // journal_mode/synchronous: WAL + NORMAL is the standard "durable enough,
  // much faster than FULL" combo for a single-writer single-replica app.
  // busy_timeout: let concurrent readers/writers block briefly instead of
  // throwing SQLITE_BUSY. temp_store/cache_size: keep temp b-trees and more
  // of the working set in memory rather than round-tripping to disk.
  const walRow = db.prepare("PRAGMA journal_mode = WAL;").get() as { journal_mode?: string } | undefined;
  try {
    assertWalMode(walRow?.journal_mode, resolveDataDir());
  } catch (err) {
    db.close();
    db = null;
    throw err;
  }
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec("PRAGMA cache_size = -20000;"); // ~20MB page cache
  runMigrations(db);
  // Cheap on a freshly-opened connection (SQLite bails out quickly when there's
  // no stale query-plan statistics to refresh); the hourly sweep in
  // lib/maintenance.ts re-runs it periodically for a long-lived process.
  db.exec("PRAGMA optimize;");

  return db;
}

function runMigrationV10(database: DatabaseSync) {
  // Drop `sensitivity` (nothing
  // that gets stored in memory should ever be confidential or super sensitive).
  //
  // It was a label with nothing behind it: no read path ever filtered on it, so an entry
  // marked "sensitive" was exactly as world-readable as one marked "public". A control
  // that does not control is worse than none, because people trust it. The rule that
  // replaces it lives in the hosted guardrails: confidential material does not belong in
  // the brain at all.
  //
  // Same PRAGMA guard as v9: ALTER TABLE has no IF NOT EXISTS, so a process that died
  // between the drop and the migrations row must still be able to boot.
  const columns = database.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "sensitivity")) {
    database.exec("ALTER TABLE learnings DROP COLUMN sensitivity");
  }
}

function runMigrationV11(database: DatabaseSync) {
  // One-time tokens that bind a Claude Code session_id to a user. The http hook
  // (the plugin delivery design) knows the session but not who
  // owns it; the agent redeems the token over the authenticated MCP connection.
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_links (
      token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_session_links_session_id ON session_links(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_links_expires_at ON session_links(expires_at);
  `);
}

function runMigrationV12(database: DatabaseSync) {
  // Which message a given session has already been told about. Keyed on the SESSION,
  // not the user: a colleague with four sessions open should hear once in each, and
  // announcing is not the same as reading (a message can still show up unread in
  // GET /api/inbox after POST /api/hook has already mentioned it once).
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_deliveries (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, message_id)
    );
  `);
}

function runMigrationV13(database: DatabaseSync) {
  // The hook (POST /api/hook) receives `cwd` in its payload but had nowhere to put it:
  // redeemLinkToken() only carried session_id across to heartbeatSession, so the folder
  // the design doc promises would be stored was silently dropped. Recorded on the link
  // row at mint time, then passed to heartbeatSession() at redeem (lib/session-links.ts).
  // Same PRAGMA guard as v9/v10: ALTER TABLE has no IF NOT EXISTS, so a process that died
  // between the column add and the migrations row must still be able to boot.
  const columns = database.prepare("PRAGMA table_info(session_links)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "cwd")) {
    database.exec("ALTER TABLE session_links ADD COLUMN cwd TEXT");
  }
}

function runMigrationV14(database: DatabaseSync) {
  // The hook's first UserPromptSubmit for an unlinked session is the only human-written
  // context anyone has for it before it links (session ids and cwds are not memorable).
  // Recorded on the link row at mint time alongside cwd, then carried to
  // heartbeatSession() at redeem the same way (lib/session-links.ts), so a linked
  // session gets a title without the agent ever setting one itself.
  // Same PRAGMA guard as v9/v10/v13: ALTER TABLE has no IF NOT EXISTS, so a process that
  // died between the column add and the migrations row must still be able to boot.
  const columns = database.prepare("PRAGMA table_info(session_links)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "title")) {
    database.exec("ALTER TABLE session_links ADD COLUMN title TEXT");
  }
}

function runMigrationV15(database: DatabaseSync) {
  // Sibling to session_deliveries (v12), same shape and reasoning: which memory a given
  // session has already been told about, via the hook's author nudges (retired, voted down)
  // (docs/spec.md "Garbage collection", app/api/hook/route.ts). Keyed on the session,
  // not the user, so a colleague with several open sessions hears the nudge once in
  // each — announcing is not the same as reading. A separate table rather than a
  // `kind` column on session_deliveries: that table's primary key is
  // (session_id, message_id), and node:sqlite/SQLite ALTER TABLE cannot change a
  // primary key in place, so widening it to (session_id, message_id, kind) would need
  // a full table rebuild; a sibling table is the same migration-v9/v10-style
  // ALTER-TABLE-avoidance trade in a different shape.
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_learning_deliveries (
      session_id TEXT NOT NULL,
      learning_id TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, learning_id)
    );
  `);
}

function runMigrationV16(database: DatabaseSync) {
  // Production has (at least) one learning whose project is the literal string "null":
  // an agent sent the text instead of omitting the field. normalizeProjectKey() now
  // treats "null"/"undefined"/"none" (case-insensitive) as no project going forward
  // (lib/project-key.ts); this cleans up whatever was already written before that
  // guard existed. Idempotent: a second run matches zero rows.
  database.exec(`
    UPDATE learnings SET project = NULL
    WHERE lower(trim(project)) IN ('null', 'undefined', 'none');
  `);
}

function runMigrationV17(database: DatabaseSync) {
  // Due-reminder notice (POST /api/hook): once a colleague's own open reminder
  // (`todos`) reaches its due_at, the hook says so. Deliberately keyed on
  // (owner_id, todo_id, due_at) rather than mirroring session_deliveries/
  // session_learning_deliveries (session_id, message_id / learning_id, v12/v15):
  // a reminder isn't tied to how many sessions are open, so this dedups per
  // OWNER from the start, not per session — a brand-new session_id (a fresh
  // `claude -p`, a subagent) must not re-announce a reminder the owner already
  // heard about in another session. `due_at` is part of the key, not just
  // (owner_id, todo_id): snooze() (lib/todos.ts) writes a new due_at on the same
  // row, and a re-snoozed reminder must be announced again once ITS new due
  // date arrives, not permanently suppressed by the earlier delivery.
  database.exec(`
    CREATE TABLE IF NOT EXISTS reminder_deliveries (
      owner_id TEXT NOT NULL,
      todo_id TEXT NOT NULL,
      due_at TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_id, todo_id, due_at)
    );
  `);
}

function runMigrationV18(database: DatabaseSync) {
  // One-time browser link: maps a sign-in proxy user id (opaque, the user-id header)
  // to the long-form email an agent already declared for that person via
  // X-Bab-Actor-Email. A proxy may send only a SHORT alias in the email header
  // (the configured identity pattern never matches it), so fromProxy()
  // (lib/session.ts) alone can't key a signed-in viewer on their real identity — this
  // table is the durable side of that link, written by the browser's own claim
  // (lib/proxy-links.ts) and read on every request after. v19 added a short-lived link
  // code table that v29 dropped again.
  database.exec(`
    CREATE TABLE IF NOT EXISTS forge_links (
      forge_user_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Flushes the WAL into the main file and closes the connection. Idempotent; getDb()
 * then throws until _resetDbForTests(). Called on shutdown so the volume holds one self-contained file.
 */
export function closeDb(): void {
  closedForShutdown = true;
  if (!db) return;
  const open = db;
  db = null;
  _resetAuditStatementCache();
  try {
    open.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    open.close();
  }
}

/** One line at startup: where the data lives and how much is in it. */
export function logStartupSummary(log: (s: string) => void = console.log): void {
  const database = getDb();
  const count = (table: string) => Number((database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  log(
    `[db] path=${path.join(resolveDataDir(), "bab.db")} users=${count("users")} learnings=${count("learnings")} messages=${count("messages")}`,
  );
}

/** Test-only: forces a fresh DatabaseSync on the next getDb() call. */
export function _resetDbForTests() {
  closedForShutdown = false;
  if (db) {
    db.close();
    db = null;
  }
  _resetAuditStatementCache();
}

// `DatabaseSync` autocommits every individual statement — there is no
// implicit transaction spanning a multi-statement write. A process crash (or
// a thrown error) between two related writes leaves the database in a
// half-applied state (e.g. lib/learnings.ts's supersede() archiving the old
// row but never linking supersedes_id on the new one). Wrap any such
// sequence in inTransaction() so it's all-or-nothing.
const activeTransactions = new WeakSet<DatabaseSync>();

/**
 * Runs `fn` inside a `BEGIN IMMEDIATE` / `COMMIT` transaction on `db`,
 * rolling back on any thrown error and rethrowing it. `BEGIN IMMEDIATE`
 * (rather than the default deferred `BEGIN`) takes the write lock up front,
 * so a writer never discovers a conflict mid-transaction after other
 * statements have already run.
 *
 * Nested calls on the same connection are rejected rather than silently
 * flattened: `node:sqlite` has no savepoint support here, and a naive nested
 * BEGIN would either error at the driver level or (worse) commit/rollback
 * the outer transaction early depending on call order.
 *
 * Callers must not emit() a realtime event (lib/events.ts) from inside `fn`
 * — a rollback must not have already notified subscribers of a write that
 * never happened. Emit after inTransaction() returns.
 */
export function inTransaction<T>(database: DatabaseSync, fn: () => T): T {
  if (activeTransactions.has(database)) {
    throw new Error("inTransaction: a transaction is already active on this connection");
  }
  activeTransactions.add(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may already be aborted (e.g. the failure was a
      // SQLite-level error that auto-rolled-back); nothing more to undo.
    }
    throw err;
  } finally {
    activeTransactions.delete(database);
  }
}

function runMigrationV23(database: DatabaseSync) {
  // A consolidation supersedes several learnings with one new one, but learnings.supersedes_id
  // holds a single id. This table records every (old, new) pair so each archived original can
  // say which entry replaced it; supersedes_id stays as the "first" link for existing readers.
  // Backfill is idempotent (INSERT OR IGNORE), so a process that died before the migrations
  // row can run it again.
  database.exec(`
    CREATE TABLE IF NOT EXISTS supersession_links (
      old_id TEXT PRIMARY KEY,
      new_id TEXT NOT NULL,
      FOREIGN KEY (old_id) REFERENCES learnings(id),
      FOREIGN KEY (new_id) REFERENCES learnings(id)
    );
    CREATE INDEX IF NOT EXISTS idx_supersession_links_new ON supersession_links(new_id);
    INSERT OR IGNORE INTO supersession_links (old_id, new_id)
      SELECT supersedes_id, id FROM learnings WHERE supersedes_id IS NOT NULL;
  `);
}

function runMigrationV22(database: DatabaseSync) {
  // Canonical project keys: `acme.bab` (repo slug) and `bab` (checkout folder) were two
  // projects. normalizeProjectKey() now strips a leading company prefix (BAB_PROJECT_KEY_PREFIXES) and a trailing
  // .git, so re-run every stored key through it. Only rows whose key changes are written;
  // repo text stays as it was, and a NULL project (company-wide on purpose) stays NULL.
  // Idempotent, so a process that died before the migrations row can simply run it again.
  const rows = database
    .prepare("SELECT id, project FROM learnings WHERE project IS NOT NULL")
    .all() as Array<{ id: string; project: string }>;
  const update = database.prepare("UPDATE learnings SET project = ? WHERE id = ?");
  for (const row of rows) {
    let next: string | null;
    try {
      next = normalizeProjectKey(row.project);
    } catch {
      continue;
    }
    if (next && next !== row.project) update.run(next, row.id);
  }
}

function runMigrationV21(database: DatabaseSync) {
  // Plugin capture nudges (the capture-nudge evaluation, P1 and P4).
  // prompts_since_learn is bumped by each linked UserPromptSubmit and zeroed by bab_learn,
  // so the Stop hook can tell a long working session from a quick question. session_nudges
  // records which nudge (kind 'capture' or 'project') a session was sent and when, for the
  // cooldown and for later metrics.
  // Same PRAGMA guard as v9/v13/v14: ALTER TABLE has no IF NOT EXISTS, so a process that
  // died between the column add and the migrations row must still be able to boot.
  const columns = database.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "prompts_since_learn")) {
    database.exec("ALTER TABLE sessions ADD COLUMN prompts_since_learn INTEGER NOT NULL DEFAULT 0");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_nudges (
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, kind, at)
    );
    CREATE INDEX IF NOT EXISTS idx_session_nudges_recent ON session_nudges(session_id, kind, at DESC);
  `);
}

function runMigrationV19(database: DatabaseSync) {
  // Browser-link codes. They were in process memory first, but Next.js bundles the
  // /reminders page and the /mcp route separately, each with its own copy of module
  // state, so a code minted by the page was unknown to bab_link_browser (seen on test,
  // 2026-09-25). SQLite is the one thing both share. expires_at is epoch milliseconds.
  database.exec(`
    CREATE TABLE IF NOT EXISTS forge_link_codes (
      code TEXT PRIMARY KEY,
      forge_user_id TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      minted_at INTEGER NOT NULL
    );
  `);
}

/**
 * v20, one-off: the migration cleared message history once. A
 * JSON copy of the threads and messages is written next to the database first, so a
 * backup of the data directory keeps it; nothing serves that file. Also clears the "already
 * announced" rows that pointed at the deleted messages. Memories, reminders and users
 * are untouched.
 */
export function wipeChats(database: DatabaseSync, dataDir: string) {
  const threads = database.prepare("SELECT * FROM threads").all();
  const messages = database.prepare("SELECT * FROM messages").all();
  if (threads.length === 0 && messages.length === 0) return;

  writeFileSync(
    path.join(dataDir, "chats-deleted-2026-09-25.json"),
    JSON.stringify({ deletedAt: new Date().toISOString(), threads, messages }),
  );
  database.exec("BEGIN");
  try {
    database.exec("DELETE FROM session_deliveries");
    database.exec("DELETE FROM messages");
    database.exec("DELETE FROM threads");
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}
