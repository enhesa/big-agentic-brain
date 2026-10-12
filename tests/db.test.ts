import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-db-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

// v10 drops a column, and SQLite implements DROP COLUMN as a table rewrite. learnings_fts
// is an EXTERNAL-CONTENT fts5 index keyed on learnings.rowid, so if the rewrite moved
// rowids the index would silently point at the wrong rows: search would return nonsense
// or nothing, with no error anywhere. TEST deployed onto an empty database and so proved
// none of this. This runs the migration against a populated one.
describe("migration v10 (drop sensitivity) on a populated database", () => {
  it("keeps every row and leaves FTS search intact", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();

    // Rows written the way a real one is, so the FTS triggers populate the index.
    const { create } = await import("../lib/learnings");
    create({ authorId: "u1", title: "Kafka message size limit is 200KB", body: "Offload to Blob." });
    create({ authorId: "u1", title: "Use runTest.sh not dotnet test", body: "CI wires up loggers." });

    const before = db.prepare("SELECT COUNT(*) AS n FROM learnings").get() as { n: number };
    expect(before.n).toBe(2);

    // Put the schema back to v9: re-add the column and rewind the migrations row, so
    // opening the database again runs v10 for real against these rows.
    db.exec("ALTER TABLE learnings ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'internal'");
    db.prepare("DELETE FROM migrations WHERE version >= 10").run();

    _resetDbForTests();
    const after = (await import("../lib/db")).getDb();

    const columns = after.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === "sensitivity")).toBe(false);

    const count = after.prepare("SELECT COUNT(*) AS n FROM learnings").get() as { n: number };
    expect(count.n).toBe(2);

    // The real question: does the external-content index still line up with the table?
    const { search } = await import("../lib/learnings");
    const hits = search("kafka");
    expect(hits.length).toBe(1);
    expect(hits[0].title).toContain("Kafka message size");

    const other = search("runTest");
    expect(other.length).toBe(1);
    expect(other[0].title).toContain("runTest.sh");
  });
});

describe("getDb", () => {
  it("opens the db, migrates, and supports inserts + FTS search", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();

    db.prepare(
      "INSERT INTO users (id, email, name, roles) VALUES (?, ?, ?, ?)",
    ).run("user-1", "a@example.com", "Ada", "member");

    db.prepare(
      `INSERT INTO learnings (id, author_id, title, body, tags, repo, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "learning-1",
      "user-1",
      "Use runTest.sh not dotnet test",
      "CI wires up loggers and containers via runTest.sh; calling dotnet test directly skips that.",
      JSON.stringify(["ci", "dotnet"]),
      "acme.api",
      "high",
    );

    const user = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get("user-1") as { id: string; email: string };
    expect(user.id).toBe("user-1");
    expect(user.email).toBe("a@example.com");

    const found = db
      .prepare(
        "SELECT learnings.id AS id FROM learnings_fts JOIN learnings ON learnings.rowid = learnings_fts.rowid WHERE learnings_fts MATCH ?",
      )
      .all("runTest") as { id: string }[];
    expect(found.map((r) => r.id)).toContain("learning-1");

    const migrations = db
      .prepare("SELECT COUNT(*) AS n FROM migrations")
      .get() as { n: number };
    expect(migrations.n).toBeGreaterThan(0);
  });

  it("is idempotent to re-run migrations against the same db", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db1 = getDb();
    db1.prepare("INSERT INTO users (id) VALUES (?)").run("user-2");

    // Force re-opening the same underlying file and re-running migrations.
    _resetDbForTests();
    const db2 = getDb();

    const user = db2
      .prepare("SELECT * FROM users WHERE id = ?")
      .get("user-2") as { id: string } | undefined;
    expect(user?.id).toBe("user-2");

    const migrations = db2
      .prepare("SELECT COUNT(*) AS n FROM migrations")
      .get() as { n: number };
    // One row per migration version (currently 1: base schema, 2: audit_log
    // actor_name/actor_email/ip/path columns, 3: idempotency table + votes.note,
    // 4: audit_log.details, 5: perf indexes + learnings_au WHEN clause,
    // 6: presence + message kind + thread lease for live chat,
    // 7: sessions table + messages.to_session for the active session registry,
    // 8: messages.request for the collaborative request contract,
    // 9: learnings.project + its index,
    // 10: drops learnings.sensitivity,
    // 11: session_links for the session-to-user link token,
    // 12: session_deliveries for per-session hook digest dedup,
    // 13: session_links.cwd so the hook's folder survives to the linked session,
    // 14: session_links.title so the hook's first prompt survives to the linked session,
    // 15: session_learning_deliveries for per-session memory nudge dedup,
    // 16: nulls out learnings.project rows literally 'null'/'undefined'/'none',
    // 17: reminder_deliveries for per-owner due-reminder dedup,
    // 18: forge_links for the one-time Forge-id-to-user browser link, and on up to
    // 36: learnings.expires_explicit for expiries the author chose on purpose,
    // 37: learnings.model for the model id an author declares,
    // 38: audit_log indexes for /admin/usage,
    // 39: learnings.pinned for house rules,
    // 40: learnings.last_accessed_at + access_days for agent reads, the default expiry cleared and
    //     the `expiring` status turned into `active`,
    // 41: learnings.applies_to for the stack or platform labels, and
    // 42: clears the old session titles, folders and host names).
    expect(migrations.n).toBe(42);
  });
});

describe("inTransaction", () => {
  it("commits every statement when fn returns normally", async () => {
    const { getDb, inTransaction } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id) VALUES (?)").run("tx-user-1");

    const returned = inTransaction(db, () => {
      db.prepare(
        "INSERT INTO learnings (id, author_id, title, body) VALUES (?, ?, ?, ?)",
      ).run("tx-l-1", "tx-user-1", "T", "B");
      db.prepare("UPDATE learnings SET score = ? WHERE id = ?").run(5, "tx-l-1");
      return "ok";
    });

    expect(returned).toBe("ok");
    const row = db.prepare("SELECT score FROM learnings WHERE id = ?").get("tx-l-1") as { score: number };
    expect(row.score).toBe(5);
  });

  it("rolls back every statement, and rethrows, when fn throws partway through", async () => {
    const { getDb, inTransaction } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id) VALUES (?)").run("tx-user-2");

    expect(() =>
      inTransaction(db, () => {
        db.prepare(
          "INSERT INTO learnings (id, author_id, title, body) VALUES (?, ?, ?, ?)",
        ).run("tx-l-2", "tx-user-2", "T", "B");
        db.prepare("UPDATE learnings SET score = ? WHERE id = ?").run(9, "tx-l-2");
        throw new Error("simulated mid-transaction failure");
      }),
    ).toThrow("simulated mid-transaction failure");

    const row = db.prepare("SELECT * FROM learnings WHERE id = ?").get("tx-l-2");
    expect(row).toBeUndefined();
  });

  it("rejects a nested transaction on the same connection instead of flattening it", async () => {
    const { getDb, inTransaction } = await import("../lib/db");
    const db = getDb();

    expect(() =>
      inTransaction(db, () => {
        inTransaction(db, () => {});
      }),
    ).toThrow(/already active/i);
  });

  it("leaves the connection usable for a later transaction after a rollback", async () => {
    const { getDb, inTransaction } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id) VALUES (?)").run("tx-user-3");

    expect(() =>
      inTransaction(db, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // The connection must not be stuck "mid-transaction" after a rollback.
    inTransaction(db, () => {
      db.prepare(
        "INSERT INTO learnings (id, author_id, title, body) VALUES (?, ?, ?, ?)",
      ).run("tx-l-3", "tx-user-3", "T", "B");
    });
    const row = db.prepare("SELECT id FROM learnings WHERE id = ?").get("tx-l-3") as { id: string };
    expect(row.id).toBe("tx-l-3");
  });
});

it("migration v11 creates session_links with a unique token", async () => {
  const { getDb } = await import("../lib/db");
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(session_links)").all() as { name: string }[];
  expect(cols.map((c) => c.name).sort()).toEqual(
    ["created_at", "cwd", "expires_at", "session_id", "title", "token", "used_at", "used_by"].sort(),
  );
  db.prepare(
    "INSERT INTO session_links (token, session_id, created_at, expires_at) VALUES (?,?,datetime('now'),datetime('now','+10 minutes'))",
  ).run("tok-1", "sess-1");
  expect(() =>
    db
      .prepare(
        "INSERT INTO session_links (token, session_id, created_at, expires_at) VALUES (?,?,datetime('now'),datetime('now','+10 minutes'))",
      )
      .run("tok-1", "sess-2"),
  ).toThrow();
});

it("migration v13 adds a nullable session_links.cwd column", async () => {
  const { getDb } = await import("../lib/db");
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(session_links)").all() as { name: string; notnull: number }[];
  const cwdCol = cols.find((c) => c.name === "cwd");
  expect(cwdCol).toBeDefined();
  expect(cwdCol!.notnull).toBe(0);
});

it("migration v14 adds a nullable session_links.title column", async () => {
  const { getDb } = await import("../lib/db");
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(session_links)").all() as { name: string; notnull: number }[];
  const titleCol = cols.find((c) => c.name === "title");
  expect(titleCol).toBeDefined();
  expect(titleCol!.notnull).toBe(0);
});

it("migration v15 creates session_learning_deliveries keyed on (session_id, learning_id)", async () => {
  const { getDb } = await import("../lib/db");
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(session_learning_deliveries)").all() as { name: string }[];
  expect(cols.map((c) => c.name).sort()).toEqual(["at", "learning_id", "session_id"].sort());

  db.prepare("INSERT INTO session_learning_deliveries (session_id, learning_id) VALUES (?, ?)").run("s1", "l1");
  expect(() =>
    db.prepare("INSERT INTO session_learning_deliveries (session_id, learning_id) VALUES (?, ?)").run("s1", "l1"),
  ).toThrow();
});

it("migration v16 nulls out a literal 'null'/'undefined'/'none' project on a populated database", async () => {
  const { getDb, _resetDbForTests } = await import("../lib/db");
  const db = getDb();
  db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
  db.prepare(
    "INSERT INTO learnings (id, author_id, title, body, tags, project, status) VALUES ('l-null', 'u1', 'a', 'b', '[]', 'null', 'active')",
  ).run();
  db.prepare(
    "INSERT INTO learnings (id, author_id, title, body, tags, project, status) VALUES ('l-undef', 'u1', 'a', 'b', '[]', 'Undefined', 'active')",
  ).run();
  db.prepare(
    "INSERT INTO learnings (id, author_id, title, body, tags, project, status) VALUES ('l-none', 'u1', 'a', 'b', '[]', ' none ', 'active')",
  ).run();
  db.prepare(
    "INSERT INTO learnings (id, author_id, title, body, tags, project, status) VALUES ('l-real', 'u1', 'a', 'b', '[]', 'bab', 'active')",
  ).run();

  // Rewind past v16 so re-opening runs it for real against these rows.
  db.prepare("DELETE FROM migrations WHERE version >= 16").run();
  _resetDbForTests();
  const after = (await import("../lib/db")).getDb();

  const rows = after.prepare("SELECT id, project FROM learnings ORDER BY id").all() as Array<{
    id: string;
    project: string | null;
  }>;
  expect(rows).toEqual([
    { id: "l-none", project: null },
    { id: "l-null", project: null },
    { id: "l-real", project: "bab" },
    { id: "l-undef", project: null },
  ]);

  // Idempotent: re-running (a fresh boot against the now-clean rows) touches nothing further.
  _resetDbForTests();
  const again = (await import("../lib/db")).getDb();
  const stillReal = again.prepare("SELECT project FROM learnings WHERE id = 'l-real'").get() as {
    project: string | null;
  };
  expect(stillReal.project).toBe("bab");
});

it("migration v18 creates forge_links keyed on forge_user_id", async () => {
  const { getDb } = await import("../lib/db");
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(forge_links)").all() as { name: string }[];
  expect(cols.map((c) => c.name).sort()).toEqual(["forge_user_id", "linked_at", "user_id"].sort());

  db.prepare("INSERT INTO forge_links (forge_user_id, user_id) VALUES (?, ?)").run(
    "forge-oid-1",
    "jean.dupont@example.com",
  );
  // forge_user_id is the primary key: a second row for the same Forge id is a conflict,
  // not a second, competing link (relinking replaces the row instead, see lib/forge-links.ts).
  expect(() =>
    db.prepare("INSERT INTO forge_links (forge_user_id, user_id) VALUES (?, ?)").run(
      "forge-oid-1",
      "marie.curie@example.com",
    ),
  ).toThrow();
});

it("migration v17 creates reminder_deliveries keyed on (owner_id, todo_id, due_at)", async () => {
  const { getDb } = await import("../lib/db");
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(reminder_deliveries)").all() as { name: string }[];
  expect(cols.map((c) => c.name).sort()).toEqual(["at", "due_at", "owner_id", "todo_id"].sort());

  db.prepare("INSERT INTO reminder_deliveries (owner_id, todo_id, due_at) VALUES (?, ?, ?)").run(
    "u1",
    "t1",
    "2026-09-25",
  );
  expect(() =>
    db
      .prepare("INSERT INTO reminder_deliveries (owner_id, todo_id, due_at) VALUES (?, ?, ?)")
      .run("u1", "t1", "2026-09-25"),
  ).toThrow();

  // A re-snoozed reminder (new due_at, same owner/todo) is a different key, not a conflict.
  expect(() =>
    db
      .prepare("INSERT INTO reminder_deliveries (owner_id, todo_id, due_at) VALUES (?, ?, ?)")
      .run("u1", "t1", "2026-10-02"),
  ).not.toThrow();
});

describe("v20: one-off chat wipe (owner, 2026-09-25)", () => {
  it("copies every thread and message to a JSON file, then deletes them and their delivery rows", async () => {
    const { getDb, wipeChats } = await import("../lib/db");
    const { upsertUser } = await import("../lib/users");
    const { send } = await import("../lib/messages");
    const { create } = await import("../lib/learnings");
    upsertUser({ id: "alice.a@example.com", email: "alice.a@example.com", name: "Alice", roles: [] });
    upsertUser({ id: "bob.b@example.com", email: "bob.b@example.com", name: "Bob", roles: [] });
    const { message } = send({ fromId: "alice.a@example.com", to: "bob.b@example.com", subject: "Hi", body: "hello" });
    create({ authorId: "alice.a@example.com", title: "A kept memory", body: "Stays." });
    const db = getDb();
    db.prepare("INSERT INTO session_deliveries (session_id, message_id) VALUES (?, ?)").run("s1", message.id);

    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const out = mkdtempSync(path.join(tmpdir(), "bab-wipe-"));
    wipeChats(db, out);

    const copy = JSON.parse(readFileSync(path.join(out, "chats-deleted-2026-09-25.json"), "utf8"));
    expect(copy.threads).toHaveLength(1);
    expect(copy.messages[0].body).toBe("hello");
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count("threads")).toBe(0);
    expect(count("messages")).toBe(0);
    expect(count("session_deliveries")).toBe(0);
    expect(count("learnings")).toBe(1);
  });
});

describe("v21: plugin capture nudges", () => {
  it("adds sessions.prompts_since_learn (default 0) and the session_nudges table", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string; dflt_value: string | null }>;
    const col = cols.find((c) => c.name === "prompts_since_learn");
    expect(col).toBeTruthy();
    expect(col!.dflt_value).toBe("0");
    const nudgeCols = (db.prepare("PRAGMA table_info(session_nudges)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(nudgeCols).toEqual(expect.arrayContaining(["session_id", "kind", "at"]));
  });

  it("boots again when the column exists but the migrations row is missing", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    getDb().prepare("DELETE FROM migrations WHERE version >= 21").run();
    _resetDbForTests();
    const { getDb: again } = await import("../lib/db");
    expect(again().prepare("SELECT 1 FROM migrations WHERE version = 21").get()).toBeTruthy();
  });
});

describe("v23: supersession_links", () => {
  it("backfills a link for every existing supersedes_id and boots again without its migrations row", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u','u@x.com','U')").run();
    db.prepare("INSERT INTO learnings (id, author_id, title, body, tags, status) VALUES ('old','u','t','b','[]','archived')").run();
    db.prepare("INSERT INTO learnings (id, author_id, title, body, tags, status, supersedes_id) VALUES ('new','u','t2','b2','[]','active','old')").run();
    db.prepare("DELETE FROM supersession_links").run();
    db.prepare("DELETE FROM migrations WHERE version >= 23").run();
    _resetDbForTests();
    const { getDb: again } = await import("../lib/db");
    expect(again().prepare("SELECT new_id FROM supersession_links WHERE old_id = 'old'").get()).toEqual({ new_id: "new" });
  });
});

describe("v29: browser link codes are gone", () => {
  it("drops forge_link_codes on an existing database and keeps forge_links", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    // Put the database back to how v28 left it: the codes table exists, v29 not yet applied.
    db.exec("CREATE TABLE forge_link_codes (code TEXT PRIMARY KEY, forge_user_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, minted_at INTEGER NOT NULL, forge_email TEXT, forge_name TEXT)");
    db.prepare("INSERT INTO forge_link_codes (code, forge_user_id, expires_at, minted_at) VALUES ('ABC234', 'f1', 1, 1)").run();
    db.prepare("DELETE FROM migrations WHERE version >= 29").run();
    _resetDbForTests();

    const { getDb: again } = await import("../lib/db");
    const tables = (again().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).not.toContain("forge_link_codes");
    expect(tables).toContain("forge_links");
    expect(again().prepare("SELECT 1 FROM migrations WHERE version = 29").get()).toBeTruthy();
  });
});

describe("v30: devices replace personal tokens", () => {
  it("creates devices, drops api_tokens, and keeps other data", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    // Put the database back to how v29 left it: the tokens table exists with a row, v30 not applied.
    db.exec("DROP TABLE devices; DROP TABLE mcp_connections");
    db.exec("CREATE TABLE api_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'full', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, last_used_at INTEGER, issued_via_forge_id TEXT)");
    db.prepare("INSERT INTO api_tokens (id, user_id, token_hash, label, created_at, expires_at) VALUES ('t1', 'u', 'h', 'default', 1, 2)").run();
    db.prepare("INSERT INTO forge_links (forge_user_id, user_id) VALUES ('f1', 'a.b@example.com')").run();
    db.prepare("DELETE FROM migrations WHERE version >= 30").run();
    _resetDbForTests();

    const { getDb: again } = await import("../lib/db");
    const tables = (again().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).not.toContain("api_tokens");
    expect(tables).toContain("devices");
    // v30 made device_connects; v34 (below) drops it again with the SSO connect flow.
    expect(tables).not.toContain("device_connects");
    expect(again().prepare("SELECT user_id FROM forge_links WHERE forge_user_id = 'f1'").get()).toEqual({ user_id: "a.b@example.com" });
    expect(again().prepare("SELECT 1 FROM migrations WHERE version = 30").get()).toBeTruthy();
  });

  it("makes secret_hash unique", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const ins = () =>
      db.prepare("INSERT INTO devices (id, user_id, secret_hash, label, created_at) VALUES (?, 'u', 'same', 'L', 1)");
    ins().run("d1");
    expect(() => ins().run("d2")).toThrow();
  });
});

// Regression guard (2026-10-01): Phase 0 added the v27 block but left CURRENT_VERSION at 26, so
// a database already at v26 returned early and never got v27. Fresh databases ran every block, so
// no other test noticed. The constant must always equal the highest migration block.
it("CURRENT_VERSION equals the highest migration block", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
  const current = Number(/const CURRENT_VERSION = (\d+);/.exec(src)?.[1]);
  const blocks = [...src.matchAll(/appliedVersion < (\d+)\)/g)].map((m) => Number(m[1]));
  expect(blocks.length).toBeGreaterThan(0);
  expect(current).toBe(Math.max(...blocks));
});

describe("v32: a revoke holds the owner to confirm", () => {
  it("adds users.require_confirm_until, NULL for everyone, and boots again if the column already exists", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    expect(db.prepare("SELECT require_confirm_until AS t FROM users WHERE id = 'u1'").get()).toEqual({ t: null });

    // A process that died between the ALTER and the migrations row must boot again.
    db.prepare("DELETE FROM migrations WHERE version >= 32").run();
    _resetDbForTests();
    const { getDb: again } = await import("../lib/db");
    expect(again().prepare("SELECT 1 FROM migrations WHERE version = 32").get()).toBeTruthy();
    expect(again().prepare("SELECT require_confirm_until AS t FROM users WHERE id = 'u1'").get()).toEqual({ t: null });
  });
});

describe("v35: kind and source columns", () => {
  it("v35 upgrades a populated v34 database: old rows become learning/native", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    db.prepare("INSERT INTO learnings (id, author_id, title, body, tags) VALUES ('l1', 'u1', 'Old', 'Old body', '[]')").run();
    // Rebuild a v34 shape: drop the index first (SQLite refuses to drop an indexed column).
    db.exec("DROP INDEX IF EXISTS idx_learnings_kind_status");
    for (const c of ["kind", "source", "source_url", "source_version"]) db.exec(`ALTER TABLE learnings DROP COLUMN ${c}`);
    db.prepare("DELETE FROM migrations WHERE version >= 35").run();
    _resetDbForTests();
    const { getDb: again } = await import("../lib/db");
    expect(again().prepare("SELECT kind, source, source_url, source_version FROM learnings WHERE id = 'l1'").get())
      .toEqual({ kind: "learning", source: "native", source_url: null, source_version: null });
    const idx = again().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_learnings_kind_status'").get();
    expect(idx).toBeTruthy();
  });

  it("v35 boots again when the columns exist but the migrations row is missing", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    getDb().prepare("DELETE FROM migrations WHERE version >= 35").run();
    _resetDbForTests();
    const { getDb: again } = await import("../lib/db");
    expect(again().prepare("SELECT 1 FROM migrations WHERE version = 35").get()).toBeTruthy();
  });
});

describe("v36: expires_explicit", () => {
  const insert = (db: Awaited<ReturnType<typeof open>>, id: string, createdAt: string, expiresAt: string | null) =>
    db
      .prepare("INSERT INTO learnings (id, author_id, title, body, tags, created_at, expires_at) VALUES (?, 'u1', ?, 'b', '[]', ?, ?)")
      .run(id, id, createdAt, expiresAt);
  async function open() {
    const { getDb } = await import("../lib/db");
    return getDb();
  }

  it("a new row starts at 0 and a fresh database has the column", async () => {
    const db = await open();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    insert(db, "l1", "2026-06-01 12:00:00", "2026-11-28");
    expect(db.prepare("SELECT expires_explicit AS e FROM learnings WHERE id = 'l1'").get()).toEqual({ e: 0 });
  });

  it("upgrades a populated v35 database: only an expiry shorter than created + 180 days is marked explicit", async () => {
    const { _resetDbForTests } = await import("../lib/db");
    const { addDaysUtc } = await import("../lib/dates");
    const db = await open();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    const created = "2026-06-01 12:00:00";
    // A short expiry nobody has extended can only have been chosen by the author.
    insert(db, "short", created, addDaysUtc("2026-06-01", 30));
    insert(db, "one-day-short", created, addDaysUtc("2026-06-01", 179));
    // The default expiry (created + 180), an extended one (reset to today + 180, later) and a never.
    insert(db, "default", created, addDaysUtc("2026-06-01", 180));
    insert(db, "extended", created, addDaysUtc("2026-06-01", 300));
    insert(db, "never", created, null);
    // A legacy full ISO datetime is read by its calendar day.
    insert(db, "legacy", created, `${addDaysUtc("2026-06-01", 30)}T00:00:00.000Z`);
    db.exec("ALTER TABLE learnings DROP COLUMN expires_explicit");
    db.prepare("DELETE FROM migrations WHERE version >= 36").run();
    _resetDbForTests();
    const again = await open();
    const flags = Object.fromEntries(
      (again.prepare("SELECT id, expires_explicit AS e FROM learnings").all() as Array<{ id: string; e: number }>).map((r) => [r.id, r.e]),
    );
    expect(flags).toEqual({ short: 1, "one-day-short": 1, default: 0, extended: 0, never: 0, legacy: 1 });
    expect(again.prepare("SELECT 1 FROM migrations WHERE version = 36").get()).toBeTruthy();
  });

  it("boots again when the column exists but the migrations row is missing, and keeps what was marked", async () => {
    const { _resetDbForTests } = await import("../lib/db");
    const db = await open();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    insert(db, "short", "2026-06-01 12:00:00", "2026-06-20");
    db.prepare("DELETE FROM migrations WHERE version >= 36").run();
    _resetDbForTests();
    const again = await open();
    expect(again.prepare("SELECT 1 FROM migrations WHERE version = 36").get()).toBeTruthy();
    expect(again.prepare("SELECT expires_explicit AS e FROM learnings WHERE id = 'short'").get()).toEqual({ e: 1 });
  });
});

describe("v42: old session titles and folders are cleared", () => {
  async function seedOldRows() {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    db.prepare(
      "INSERT INTO sessions (id, owner_id, name, title, cwd, host, pid) VALUES ('s1', 'u1', 'bab-3f', 'Fix the flaky Kafka test', 'C:\Users\ab\bab', 'AB-LAPTOP', 42)",
    ).run();
    db.prepare(
      "INSERT INTO session_links (token, session_id, expires_at, cwd, title) VALUES ('t1', 's1', datetime('now', '+10 minutes'), 'C:\Users\ab\bab', 'Fix the flaky Kafka test')",
    ).run();
    db.prepare("DELETE FROM migrations WHERE version >= 42").run();
    return db;
  }

  it("sets every stored title, folder, name, host and pid to NULL and keeps the rows", async () => {
    await seedOldRows();
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    const db = (await import("../lib/db")).getDb();

    expect({ ...db.prepare("SELECT owner_id, name, title, cwd, host, pid FROM sessions WHERE id = 's1'").get() }).toEqual({
      owner_id: "u1",
      name: null,
      title: null,
      cwd: null,
      host: null,
      pid: null,
    });
    expect({ ...db.prepare("SELECT session_id, cwd, title FROM session_links WHERE token = 't1'").get() }).toEqual({
      session_id: "s1",
      cwd: null,
      title: null,
    });
    expect(db.prepare("SELECT 1 AS ok FROM migrations WHERE version = 42").get()).toBeTruthy();
  });

  it("boots when a column is missing, and running it again changes nothing", async () => {
    const db = await seedOldRows();
    db.exec("ALTER TABLE session_links DROP COLUMN title");
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    const again = (await import("../lib/db")).getDb();
    expect({ ...again.prepare("SELECT cwd FROM session_links WHERE token = 't1'").get() }).toEqual({ cwd: null });

    again.prepare("DELETE FROM migrations WHERE version >= 42").run();
    _resetDbForTests();
    const third = (await import("../lib/db")).getDb();
    expect({ ...third.prepare("SELECT title FROM sessions WHERE id = 's1'").get() }).toEqual({ title: null });
  });
});

describe("migration order: v40, then v41, then v42", () => {
  it("a fresh database gets all three, in order", async () => {
    const db = (await import("../lib/db")).getDb();
    const versions = (db.prepare("SELECT version FROM migrations WHERE version >= 40 ORDER BY rowid").all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toEqual([40, 41, 42]);
    const cols = new Set((db.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const c of ["last_accessed_at", "access_days", "applies_to"]) expect(cols.has(c)).toBe(true);
  });

  it("a database at v40 gets v41 and v42 on the next boot", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    db.prepare("INSERT INTO sessions (id, owner_id, title) VALUES ('s1', 'u1', 'A first prompt')").run();
    db.prepare("DELETE FROM migrations WHERE version > 40").run();
    db.exec("ALTER TABLE learnings DROP COLUMN applies_to");
    _resetDbForTests();

    const again = (await import("../lib/db")).getDb();
    const versions = (again.prepare("SELECT version FROM migrations WHERE version >= 40 ORDER BY version").all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toEqual([40, 41, 42]);
    const cols = new Set((again.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name));
    expect(cols.has("applies_to")).toBe(true);
    expect({ ...again.prepare("SELECT title FROM sessions WHERE id = 's1'").get() }).toEqual({ title: null });
  });
});

describe("closeDb and startup summary", () => {
  it("closeDb is idempotent and data persists after a reset", async () => {
    const { getDb, closeDb, _resetDbForTests } = await import("../lib/db");
    getDb().prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    closeDb();
    expect(() => closeDb()).not.toThrow();
    _resetDbForTests();
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("startup summary names the db path and counts", async () => {
    const { getDb, logStartupSummary } = await import("../lib/db");
    getDb().prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    const lines: string[] = [];
    logStartupSummary((s) => lines.push(s));
    const text = lines.join("\n");
    expect(text).toContain(path.join(dataDir, "bab.db"));
    expect(text).toContain("users=1");
    expect(text).toContain("learnings=0");
    expect(text).toContain("messages=0");
  });

  it.skipIf(process.platform === "win32")("creates the data dir 0700 and the db file 0600", async () => {
    const { statSync, rmSync: rm } = await import("node:fs");
    const sub = path.join(dataDir, "nested");
    process.env.DATA_DIR = sub;
    const { getDb } = await import("../lib/db");
    getDb();
    expect(statSync(sub).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(sub, "bab.db")).mode & 0o777).toBe(0o600);
    rm(sub, { recursive: true, force: true });
  });
});

describe("database file mode", () => {
  it.skipIf(process.platform === "win32")("does not throw when the file is owned by another uid (chmod is skipped)", async () => {
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const real = process.getuid!;
    process.getuid = () => real.call(process) + 1;
    try {
      const { getDb } = await import("../lib/db");
      expect(() => getDb()).not.toThrow();
    } finally {
      process.getuid = real;
      warn.mockRestore();
    }
  });
});

describe("WAL self-test and shutdown guard", () => {
  it("assertWalMode accepts wal and rejects other modes naming the dir", async () => {
    const { assertWalMode } = await import("../lib/db");
    expect(() => assertWalMode("wal", "/x")).not.toThrow();
    expect(() => assertWalMode("delete", "/mnt/share")).toThrow(/could not enable WAL in \/mnt\/share/);
  });

  it("getDb throws after closeDb until _resetDbForTests", async () => {
    const { getDb, closeDb, _resetDbForTests } = await import("../lib/db");
    getDb();
    closeDb();
    expect(() => getDb()).toThrow("bab: database closed for shutdown");
    _resetDbForTests();
    expect(() => getDb()).not.toThrow();
  });
});

describe("resolveDataDir", () => {
  it("defaults to /data when DATA_DIR is unset (the default is for containers; tests get a temp dir from setup-env)", async () => {
    const { resolveDataDir } = await import("../lib/db");
    delete process.env.DATA_DIR;
    expect(resolveDataDir()).toBe("/data");
  });
});
