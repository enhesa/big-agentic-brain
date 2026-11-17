import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Migration v59 adds thread_participants and message_recipients for group messages and fills them
 * from the one-recipient columns (threads.created_by, messages.from_id, to_id and read_at). The old
 * columns stay, so threads written before it read the same afterwards, and the backfill can run twice.
 */

let dataDir: string;
const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-db-v59-test-"));
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

async function reopen(): Promise<Db> {
  const { _resetDbForTests, getDb } = await import("../lib/db");
  _resetDbForTests();
  return getDb();
}

/** A database as v58 left it: no participant or recipient tables, one recipient per message. */
async function legacyDatabase(): Promise<Db> {
  const db = await open();
  db.exec("DROP TABLE IF EXISTS message_recipients; DROP TABLE IF EXISTS thread_participants;");
  db.prepare("DELETE FROM migrations WHERE version >= 59").run();
  for (const id of [A, B, C]) db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(id, id, id.split("@")[0]);
  db.prepare("INSERT INTO threads (id, subject, created_by) VALUES ('t1', 'Old', ?)").run(A);
  db.prepare(
    "INSERT INTO messages (id, thread_id, from_id, to_id, body, read_at, created_at) VALUES ('m1', 't1', ?, ?, 'hi', datetime('now', '-1 hour'), datetime('now', '-2 hours'))",
  ).run(A, B);
  db.prepare("INSERT INTO messages (id, thread_id, from_id, to_id, body, created_at) VALUES ('m2', 't1', ?, ?, 'back', datetime('now', '-1 hour'))").run(B, A);
  // A note to self, and a thread with no message (the empty-thread sweep removes those).
  db.prepare("INSERT INTO threads (id, subject, created_by) VALUES ('t2', 'Note', ?)").run(C);
  db.prepare("INSERT INTO messages (id, thread_id, from_id, to_id, body) VALUES ('m3', 't2', ?, ?, 'self')").run(C, C);
  db.prepare("INSERT INTO threads (id, subject, created_by) VALUES ('t3', 'Empty', ?)").run(C);
  return db;
}

const all = (db: Db, sql: string, ...args: string[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];

describe("migration v59: participants and recipients", () => {
  it("backfills participants from creator, senders and recipients", async () => {
    await legacyDatabase();
    const db = await reopen();
    expect(all(db, "SELECT user_id FROM thread_participants WHERE thread_id = 't1' ORDER BY user_id").map((r) => r.user_id)).toEqual([A, B]);
    expect(all(db, "SELECT user_id FROM thread_participants WHERE thread_id = 't2'").map((r) => r.user_id)).toEqual([C]);
    expect(all(db, "SELECT user_id FROM thread_participants WHERE thread_id = 't3'").map((r) => r.user_id)).toEqual([C]);
  });

  it("copies each message's recipient and read time", async () => {
    await legacyDatabase();
    const db = await reopen();
    const rows = all(db, "SELECT message_id, user_id, read_at FROM message_recipients ORDER BY message_id");
    expect(rows.map((r) => [r.message_id, r.user_id, r.read_at !== null])).toEqual([
      ["m1", B, true],
      ["m2", A, false],
      ["m3", C, false],
    ]);
  });

  it("keeps old threads readable with the same unread counts", async () => {
    await legacyDatabase();
    await reopen();
    const { inboxFor, unreadCountFor, requireThreadForActor, send } = await import("../lib/messages");
    expect(unreadCountFor(A)).toBe(1);
    expect(unreadCountFor(B)).toBe(0);
    expect(inboxFor(A).map((t) => [t.thread.id, t.unreadCount])).toEqual([["t1", 1]]);
    expect(requireThreadForActor("t1", B).messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(() => requireThreadForActor("t1", C)).toThrow(/Not a participant/);
    // A reply with no `to` still finds the other side.
    expect(send({ fromId: B, threadId: "t1", body: "again" }).message.to_id).toBe(A);
  });

  it("runs twice without duplicates or errors", async () => {
    const db = await legacyDatabase();
    void db;
    const once = await reopen();
    const count = (d: Db, table: string) => (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = [count(once, "thread_participants"), count(once, "message_recipients")];
    once.prepare("DELETE FROM migrations WHERE version >= 59").run();
    const twice = await reopen();
    expect([count(twice, "thread_participants"), count(twice, "message_recipients")]).toEqual(before);
    expect(twice.prepare("SELECT 1 FROM migrations WHERE version = 59").get()).toBeTruthy();
  });

  it("repairs what an older release wrote after v59 (a rollback), at the next open", async () => {
    await legacyDatabase();
    const db = await reopen();
    // An older release knows only the one-recipient columns: a new thread, a reply, a read.
    db.prepare("INSERT INTO threads (id, subject, created_by) VALUES ('t9', 'During rollback', ?)").run(B);
    db.prepare("INSERT INTO messages (id, thread_id, from_id, to_id, body) VALUES ('m9', 't9', ?, ?, 'new')").run(B, C);
    db.prepare("INSERT INTO messages (id, thread_id, from_id, to_id, body) VALUES ('m10', 't1', ?, ?, 'old reply')").run(A, B);
    db.prepare("UPDATE messages SET read_at = datetime('now') WHERE id = 'm2'").run();

    await reopen();
    const { thread, unreadCountFor, inboxFor } = await import("../lib/messages");
    expect(thread("t9", C)?.messages.map((m) => m.id)).toEqual(["m9"]);
    expect(thread("t9", B)).toBeDefined();
    expect(unreadCountFor(C)).toBe(2);
    expect(unreadCountFor(B)).toBe(1);
    // m2 (to A) was read by the older release: it stays read.
    expect(unreadCountFor(A)).toBe(0);
    expect(inboxFor(B).map((t) => t.thread.id).sort()).toEqual(["t1", "t9"]);
  });

  it("lets the maintenance sweep delete an empty thread that has a participant row", async () => {
    await legacyDatabase();
    await reopen();
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();
    runMaintenance(true);
    const db = await open();
    expect(db.prepare("SELECT 1 FROM threads WHERE id = 't3'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM thread_participants WHERE thread_id = 't3'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM threads WHERE id = 't1'").get()).toBeTruthy();
  });
});
