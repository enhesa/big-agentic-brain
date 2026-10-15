import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Migration v33 removes the one test user a security test left on live: someone.else@example.com
 * ("Someone Else", made by sending a made-up X-Bab-Actor identity). Deleting it was approved.
 * It deletes the row ONLY when nothing in the database refers to it, and never touches audit_log.
 */

let dataDir: string;
const FAKE = "someone.else@example.com";
const REAL = "alice.example@example.com";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-db-v33-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

type Db = ReturnType<typeof import("../lib/db").getDb>;

async function open(): Promise<Db> {
  const { getDb } = await import("../lib/db");
  return getDb();
}

/** Put the database back to how v32 left it, so reopening runs v33 for real. */
async function rewindAndReopen(db: Db): Promise<Db> {
  db.prepare("DELETE FROM migrations WHERE version >= 33").run();
  const { _resetDbForTests, getDb } = await import("../lib/db");
  _resetDbForTests();
  return getDb();
}

function addUser(db: Db, id: string, name: string) {
  db.prepare("INSERT OR REPLACE INTO users (id, email, name) VALUES (?, ?, ?)").run(id, id, name);
}

const exists = (db: Db, id: string) => db.prepare("SELECT 1 FROM users WHERE id = ?").get(id) !== undefined;

describe("migration v33: the fake test user", () => {
  it("deletes the row when nothing refers to it, and leaves every other user alone", async () => {
    const db = await open();
    addUser(db, FAKE, "Someone Else");
    addUser(db, REAL, "Alice Example");
    const after = await rewindAndReopen(db);
    expect(exists(after, FAKE)).toBe(false);
    expect(exists(after, REAL)).toBe(true);
    expect(after.prepare("SELECT 1 FROM migrations WHERE version = 33").get()).toBeTruthy();
  });

  it("never touches audit_log, even rows that name the fake user", async () => {
    const db = await open();
    addUser(db, FAKE, "Someone Else");
    db.prepare("INSERT INTO audit_log (actor_id, action, entity, entity_id, via) VALUES (?, 'GET', 'request', '/api/me', 'mcp')").run(FAKE);
    db.prepare("INSERT INTO audit_log (actor_id, action, entity, entity_id, via) VALUES ('x', 'rename', 'user', ?, 'mcp')").run(FAKE);
    const after = await rewindAndReopen(db);
    expect(exists(after, FAKE)).toBe(false);
    expect((after.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? OR entity_id = ?").get(FAKE, FAKE) as { n: number }).n).toBe(2);
  });

  // One case per table that holds a user id (and a few that only could): any single reference keeps the row.
  const references: [string, (db: Db) => void][] = [
    ["a learning it wrote", (db) => db.prepare("INSERT INTO learnings (id, author_id, title, body) VALUES ('l1', ?, 't', 'b')").run(FAKE)],
    [
      "a vote on a learning",
      (db) => {
        addUser(db, REAL, "Alice Example");
        db.prepare("INSERT INTO learnings (id, author_id, title, body) VALUES ('l1', ?, 't', 'b')").run(REAL);
        db.prepare("INSERT INTO votes (learning_id, voter_id, kind) VALUES ('l1', ?, 'helpful')").run(FAKE);
      },
    ],
    [
      "a message it sent",
      (db) => {
        addUser(db, REAL, "Alice Example");
        db.prepare("INSERT INTO threads (id, subject, created_by) VALUES ('t1', 's', ?)").run(REAL);
        db.prepare("INSERT INTO messages (id, thread_id, from_id, to_id, body) VALUES ('m1', 't1', ?, ?, 'hi')").run(FAKE, REAL);
      },
    ],
    [
      "a message sent to it",
      (db) => {
        addUser(db, REAL, "Alice Example");
        db.prepare("INSERT INTO threads (id, subject, created_by) VALUES ('t1', 's', ?)").run(REAL);
        db.prepare("INSERT INTO messages (id, thread_id, from_id, to_id, body) VALUES ('m1', 't1', ?, ?, 'hi')").run(REAL, FAKE);
      },
    ],
    ["a thread it started", (db) => db.prepare("INSERT INTO threads (id, subject, created_by) VALUES ('t1', 's', ?)").run(FAKE)],
    ["a reminder it owns", (db) => db.prepare("INSERT INTO todos (id, owner_id, title) VALUES ('d1', ?, 't')").run(FAKE)],
    ["a session", (db) => db.prepare("INSERT INTO sessions (id, owner_id) VALUES ('s1', ?)").run(FAKE)],
    ["a device", (db) => db.prepare("INSERT INTO devices (id, user_id, secret_hash, label, created_at) VALUES ('d1', ?, 'h', 'L', 1)").run(FAKE)],
    ["a browser link", (db) => db.prepare("INSERT INTO proxy_links (proxy_user_id, user_id) VALUES ('f1', ?)").run(FAKE)],
    ["feedback it wrote", (db) => db.prepare("INSERT INTO feedback (id, author_id, source, kind, area, title, body) VALUES ('f1', ?, 'agent', 'bug', 'web', 't', 'b')").run(FAKE)],
    [
      "a feedback vote",
      (db) => {
        addUser(db, REAL, "Alice Example");
        db.prepare("INSERT INTO feedback (id, author_id, source, kind, area, title, body) VALUES ('f1', ?, 'agent', 'bug', 'web', 't', 'b')").run(REAL);
        db.prepare("INSERT INTO feedback_votes (feedback_id, voter_id) VALUES ('f1', ?)").run(FAKE);
      },
    ],
    [
      "a feedback comment",
      (db) => {
        addUser(db, REAL, "Alice Example");
        db.prepare("INSERT INTO feedback (id, author_id, source, kind, area, title, body) VALUES ('f1', ?, 'agent', 'bug', 'web', 't', 'b')").run(REAL);
        db.prepare("INSERT INTO feedback_comments (id, feedback_id, author_id, body) VALUES ('c1', 'f1', ?, 'b')").run(FAKE);
      },
    ],
    ["a maintainer feedback marker", (db) => db.prepare("INSERT INTO maintainer_feedback_seen (owner_id, seen_at) VALUES (?, 'now')").run(FAKE)],
    ["a reminder delivery record", (db) => db.prepare("INSERT INTO reminder_deliveries (owner_id, todo_id, due_at) VALUES (?, 'd1', '2030-01-01')").run(FAKE)],
    ["an idempotency record", (db) => db.prepare("INSERT INTO idempotency (actor_id, key, status, body_json) VALUES (?, 'k', 200, '{}')").run(FAKE)],
    ["a session link it redeemed", (db) => db.prepare("INSERT INTO session_links (token, session_id, expires_at, used_by) VALUES ('tok', 's1', '2030-01-01', ?)").run(FAKE)],
  ];

  it.each(references)("keeps the row when %s refers to it", async (_label, reference) => {
    const db = await open();
    addUser(db, FAKE, "Someone Else");
    reference(db);
    const after = await rewindAndReopen(db);
    expect(exists(after, FAKE)).toBe(true);
    // The migration is recorded either way: it will not retry on every boot.
    expect(after.prepare("SELECT 1 FROM migrations WHERE version = 33").get()).toBeTruthy();
  });

  it("only deletes the exact row: another name on that id, or a similar id, is kept", async () => {
    const db = await open();
    addUser(db, FAKE, "A Real Colleague");
    addUser(db, "someone.else2@example.com", "Someone Else");
    addUser(db, "someone.else@example.com.example", "Someone Else");
    const after = await rewindAndReopen(db);
    expect(exists(after, FAKE)).toBe(true);
    expect(exists(after, "someone.else2@example.com")).toBe(true);
    expect(exists(after, "someone.else@example.com.example")).toBe(true);
  });

  it("is a no-op on an empty database (a fresh install, a test environment)", async () => {
    const db = await open();
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT 1 FROM migrations WHERE version = 33").get()).toBeTruthy();
    const after = await rewindAndReopen(db);
    expect(after.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  it("is idempotent: running it again changes nothing", async () => {
    const db = await open();
    addUser(db, FAKE, "Someone Else");
    addUser(db, REAL, "Alice Example");
    const once = await rewindAndReopen(db);
    const twice = await rewindAndReopen(once);
    expect(exists(twice, FAKE)).toBe(false);
    expect(exists(twice, REAL)).toBe(true);
  });

  it("does not delete a user who connected later with the same id and now has data", async () => {
    const db = await open();
    addUser(db, FAKE, "Someone Else");
    db.prepare("INSERT INTO todos (id, owner_id, title) VALUES ('d1', ?, 'real work')").run(FAKE);
    const after = await rewindAndReopen(db);
    expect(exists(after, FAKE)).toBe(true);
    expect(after.prepare("SELECT title FROM todos WHERE id = 'd1'").get()).toEqual({ title: "real work" });
  });
});
