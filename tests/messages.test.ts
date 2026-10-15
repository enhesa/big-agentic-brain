import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-messages-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice", email: "alice@example.com", name: "Alice", roles: [] });
  upsertUser({ id: "bob", email: "bob@example.com", name: "Bob", roles: [] });
}

describe("messages.send", () => {
  it("creates a thread and a message", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const { thread, message } = send({
      fromId: "alice",
      to: "bob",
      subject: "Re-enable alert filter",
      body: "Please re-enable after the migration.",
    });

    expect(thread.id).toBeTruthy();
    expect(message.thread_id).toBe(thread.id);
    expect(message.from_id).toBe("alice");
    expect(message.to_id).toBe("bob");
  });

  it("appends a reply to an existing thread", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const first = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });
    const reply = send({ fromId: "bob", to: "alice", threadId: first.thread.id, body: "Second" });

    expect(reply.thread.id).toBe(first.thread.id);
  });
});

describe("messages.inboxFor", () => {
  it("reports unread count for the recipient", async () => {
    await seedUsers();
    const { send, inboxFor } = await import("../lib/messages");
    send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });
    send({ fromId: "alice", to: "bob", subject: "Hi 2", body: "Second" });

    const inbox = inboxFor("bob");
    expect(inbox.length).toBe(2);
    expect(inbox.every((t) => t.unreadCount === 1)).toBe(true);
  });
});

describe("messages.thread participation", () => {
  it("returns undefined for an outsider", async () => {
    await seedUsers();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "carol", email: "carol@example.com", name: "Carol", roles: [] });
    const { send, thread } = await import("../lib/messages");
    const { thread: t } = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });

    expect(thread(t.id, "carol")).toBeUndefined();
  });

  it("returns the thread for a participant", async () => {
    await seedUsers();
    const { send, thread } = await import("../lib/messages");
    const { thread: t } = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });

    expect(thread(t.id, "alice")).toBeTruthy();
    expect(thread(t.id, "bob")).toBeTruthy();
  });

  it("rejects a reply from a non-participant", async () => {
    await seedUsers();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "carol", email: "carol@example.com", name: "Carol", roles: [] });
    const { send } = await import("../lib/messages");
    const { thread: t } = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });

    expect(() => send({ fromId: "carol", to: "alice", threadId: t.id, body: "Butting in" })).toThrow(
      /not a participant/i,
    );
  });
});

describe("messages.markRead", () => {
  it("marks messages in a thread as read for the recipient", async () => {
    await seedUsers();
    const { send, inboxFor, markRead } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice", to: "bob", subject: "Hi", body: "First" });

    markRead(thread.id, "bob");

    const inbox = inboxFor("bob");
    expect(inbox[0].unreadCount).toBe(0);
  });
});
