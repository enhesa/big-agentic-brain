import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-messages-gaps-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.restoreAllMocks();
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice", email: "alice@example.com", name: "Alice", roles: [] });
  upsertUser({ id: "bob", email: "bob@example.com", name: "Bob", roles: [] });
}

describe("messages.send unknown recipient", () => {
  it("returns an error for an unknown recipient id", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    expect(() => send({ fromId: "alice", to: "ghost", body: "Hello" })).toThrow(/unknown recipient/i);
  });

  it("a note to yourself is a plain inbox message, with or without a request", async () => {
    await seedUsers();
    const { send, inboxFor, unreadCountFor } = await import("../lib/messages");
    const plain = send({ fromId: "alice", to: "alice", subject: "Note", body: "Hello me" });
    expect(plain.message.from_id).toBe("alice");
    expect(plain.message.to_id).toBe("alice");
    const withRequest = send({
      fromId: "alice",
      to: "alice",
      subject: "Later",
      body: "Pick this up",
      request: { kind: "question", goal: "Look at the flaky test" },
    });
    expect(withRequest.message.request).toMatchObject({ kind: "question" });

    const threads = inboxFor("alice").map((t) => t.thread.id);
    expect(threads).toEqual(expect.arrayContaining([plain.thread.id, withRequest.thread.id]));
    expect(unreadCountFor("alice")).toBe(2);
  });

  it("a reply in your own note thread stays with you", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const first = send({ fromId: "alice", to: "alice", body: "Note one" });
    const reply = send({ fromId: "alice", threadId: first.thread.id, body: "Note two" });
    expect(reply.message.to_id).toBe("alice");
  });

  it("sent messages carry no session field", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const { message } = send({ fromId: "alice", to: "bob", body: "hi" });
    expect(message).not.toHaveProperty("to_session");
    expect(message).not.toHaveProperty("toSession");
  });
});

describe("messages.thread ordering", () => {
  it("returns messages within a thread in chronological (ascending) order", async () => {
    await seedUsers();
    const { send, thread } = await import("../lib/messages");
    const first = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });
    send({ fromId: "bob", to: "alice", threadId: first.thread.id, body: "Second" });
    send({ fromId: "alice", to: "bob", threadId: first.thread.id, body: "Third" });

    const result = thread(first.thread.id, "alice")!;
    expect(result.messages.map((m) => m.body)).toEqual(["First", "Second", "Third"]);
  });
});

describe("messages.markRead recipient scoping", () => {
  it("marking read only affects the actual recipient's unread count, not the sender's", async () => {
    await seedUsers();
    const { send, markRead, unreadCountFor } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });
    send({ fromId: "bob", to: "alice", threadId: thread.id, body: "Reply" });

    markRead(thread.id, "bob");

    // bob's inbound message (from alice) is now read; alice's inbound message
    // (bob's reply) is unaffected.
    expect(unreadCountFor("bob")).toBe(0);
    expect(unreadCountFor("alice")).toBe(1);
  });

  it("markRead for a user who isn't the recipient of any message in the thread is a no-op", async () => {
    await seedUsers();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "carol", email: "carol@example.com", name: "Carol", roles: [] });
    const { send, markRead, unreadCountFor } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });

    markRead(thread.id, "carol");
    expect(unreadCountFor("bob")).toBe(1);
  });
});

describe("messages.unreadCountFor per thread", () => {
  it("computes unread count independently per thread", async () => {
    await seedUsers();
    const { send, inboxFor } = await import("../lib/messages");
    const t1 = send({ fromId: "alice", to: "bob", subject: "T1", body: "msg1" });
    send({ fromId: "alice", to: "bob", threadId: t1.thread.id, body: "msg2" });
    send({ fromId: "alice", to: "bob", subject: "T2", body: "msg3" });

    const inbox = inboxFor("bob");
    const byId = Object.fromEntries(inbox.map((i) => [i.thread.id, i.unreadCount]));
    expect(byId[t1.thread.id]).toBe(2);
    const otherThread = inbox.find((i) => i.thread.id !== t1.thread.id)!;
    expect(otherThread.unreadCount).toBe(1);
  });
});

describe("messages.thread participant check", () => {
  it("applies equally to the thread creator and the recipient", async () => {
    await seedUsers();
    const { send, thread } = await import("../lib/messages");
    const { thread: t } = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });

    // creator (alice) can read it
    expect(thread(t.id, "alice")).toBeTruthy();
    // recipient (bob) can read it
    expect(thread(t.id, "bob")).toBeTruthy();
  });

  it("a recipient can also reply into a thread they didn't create", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const { thread: t } = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });
    const reply = send({ fromId: "bob", to: "alice", threadId: t.id, body: "Reply" });
    expect(reply.thread.id).toBe(t.id);
  });
});

describe("messages.send is transactional", () => {
  it("rolls back a new thread's insert if the message insert fails, so no orphan thread is left behind", async () => {
    await seedUsers();
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const original = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO messages")) {
        throw new Error("simulated failure inserting the message");
      }
      return original(sql);
    });

    const { send } = await import("../lib/messages");
    expect(() => send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" })).toThrow(
      /simulated failure/,
    );
    spy.mockRestore();

    const threadCount = (getDb().prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n;
    const messageCount = (getDb().prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
    expect(threadCount).toBe(0);
    expect(messageCount).toBe(0);

    // A retry (no mock) now goes through cleanly.
    const result = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });
    expect(result.message.id).toBeTruthy();
  });

  it("never leaves an audit row for a reply message that didn't actually get inserted", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const first = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" }, "mcp");

    const { getDb } = await import("../lib/db");
    const db = getDb();
    const original = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO messages")) {
        throw new Error("simulated failure inserting the reply");
      }
      return original(sql);
    });

    expect(() =>
      send({ fromId: "bob", to: "alice", threadId: first.thread.id, body: "Reply" }, "mcp"),
    ).toThrow(/simulated failure/);
    spy.mockRestore();

    // Only the first (successful) send's audit row exists; the failed retry left none.
    const { n } = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'message' AND action = 'send'")
      .get() as { n: number };
    expect(n).toBe(1);
  });

  it("rolls back the message insert and lease decrement together if the lease update fails", async () => {
    await seedUsers();
    const { send, recordLease, getLeaseForActor } = await import("../lib/messages");
    const first = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });
    recordLease(first.thread.id, "bob", 3, 30);
    expect(getLeaseForActor(first.thread.id, "bob")!.turnsLeft).toBe(3);

    const { getDb } = await import("../lib/db");
    const db = getDb();
    const original = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("UPDATE threads SET lease_json")) {
        throw new Error("simulated failure decrementing the lease");
      }
      return original(sql);
    });

    expect(() =>
      send(
        { fromId: "bob", to: "alice", threadId: first.thread.id, body: "Reply", useLease: true },
        "mcp",
      ),
    ).toThrow(/simulated failure/);
    spy.mockRestore();

    // Neither the reply message nor the lease decrement should have landed.
    const messageCount = (
      getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE body = ?").get("Reply") as { n: number }
    ).n;
    expect(messageCount).toBe(0);
    expect(getLeaseForActor(first.thread.id, "bob")!.turnsLeft).toBe(3);
  });
});
