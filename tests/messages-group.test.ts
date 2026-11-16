import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Group messages: one send to several people, every reply reaches every participant, read state
 * is kept per recipient (message_recipients) and membership per thread (thread_participants).
 * A single recipient keeps today's behaviour exactly.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-messages-group-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const PEOPLE = ["alice", "bob", "carol", "dave"] as const;

async function seedUsers(extra: string[] = []) {
  const { upsertUser } = await import("../lib/users");
  for (const id of [...PEOPLE, ...extra]) {
    upsertUser({ id: `${id}@example.com`, email: `${id}@example.com`, name: id[0].toUpperCase() + id.slice(1), roles: [] });
  }
}

const A = "alice@example.com";
const B = "bob@example.com";
const C = "carol@example.com";
const D = "dave@example.com";

describe("single recipient (unchanged)", () => {
  it("a string `to` makes one message with that to_id and two participants", async () => {
    await seedUsers();
    const { send, participantsOf } = await import("../lib/messages");
    const sent = send({ fromId: A, to: B, subject: "Hi", body: "One" });
    expect(sent.message.to_id).toBe(B);
    expect(sent.recipients.map((r) => r.id)).toEqual([B]);
    expect(participantsOf(sent.thread.id).map((p) => p.id).sort()).toEqual([A, B]);
  });

  it("a list of one behaves like the string", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const sent = send({ fromId: A, to: [B], subject: "Hi", body: "One" });
    expect(sent.message.to_id).toBe(B);
    expect(sent.recipients.map((r) => r.id)).toEqual([B]);
  });

  it("keeps the exact unknown-recipient error for a string", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    expect(() => send({ fromId: A, to: "nobody@example.com", subject: "Hi", body: "x" })).toThrow(/^Unknown recipient$/);
  });

  it("a 1:1 reply with an explicit `to` goes only there, as today", async () => {
    await seedUsers();
    const { send, unreadCountFor } = await import("../lib/messages");
    const first = send({ fromId: A, to: B, subject: "Hi", body: "One" });
    const reply = send({ fromId: B, to: A, threadId: first.thread.id, body: "Two" });
    expect(reply.message.to_id).toBe(A);
    expect(reply.recipients.map((r) => r.id)).toEqual([A]);
    expect(unreadCountFor(A)).toBe(1);
  });

  it("a note to self still works, and a reply in it goes to yourself", async () => {
    await seedUsers();
    const { send, unreadCountFor } = await import("../lib/messages");
    const note = send({ fromId: A, to: A, subject: "Note", body: "remember" });
    expect(note.message.to_id).toBe(A);
    const again = send({ fromId: A, threadId: note.thread.id, body: "and this" });
    expect(again.message.to_id).toBe(A);
    expect(unreadCountFor(A)).toBe(2);
  });
});

describe("group send", () => {
  it("one message, one recipient row per person, everyone a participant", async () => {
    await seedUsers();
    const { send, participantsOf, unreadCountFor } = await import("../lib/messages");
    const { getDb } = await import("../lib/db");
    const sent = send({ fromId: A, to: [B, C, D], subject: "Release", body: "Ship it?" });

    expect(sent.message.to_id).toBe(B);
    expect(sent.recipients.map((r) => r.id)).toEqual([B, C, D]);
    expect(sent.recipients.map((r) => r.name)).toEqual(["Bob", "Carol", "Dave"]);
    const rows = getDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?").get(sent.thread.id) as { n: number };
    expect(rows.n).toBe(1);
    expect(participantsOf(sent.thread.id).map((p) => p.id)).toEqual([A, B, C, D]);
    expect(unreadCountFor(B)).toBe(1);
    expect(unreadCountFor(C)).toBe(1);
    expect(unreadCountFor(D)).toBe(1);
    expect(unreadCountFor(A)).toBe(0);
  });

  it("collapses duplicates, ignoring case and spaces", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const sent = send({ fromId: A, to: [B, " BOB@example.com ", C], subject: "x", body: "y" });
    expect(sent.recipients.map((r) => r.id)).toEqual([B, C]);
  });

  it("drops the sender from a list with others, keeps a list of only yourself as a note", async () => {
    await seedUsers();
    const { send, participantsOf } = await import("../lib/messages");
    const sent = send({ fromId: A, to: [A, B, C], subject: "x", body: "y" });
    expect(sent.recipients.map((r) => r.id)).toEqual([B, C]);
    expect(participantsOf(sent.thread.id).map((p) => p.id)).toEqual([A, B, C]);
    const note = send({ fromId: A, to: [A], subject: "x", body: "y" });
    expect(note.recipients.map((r) => r.id)).toEqual([A]);
  });

  it("returns a delivery for every recipient and a summary delivery", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const sent = send({ fromId: A, to: [B, C], subject: "x", body: "y" });
    expect(sent.delivery.page).toBe("none");
    expect(sent.delivery.note).toMatch(/inboxes/);
    expect(sent.recipients.every((r) => r.delivery.page === "none")).toBe(true);
  });

  it("a request reaches every recipient on the one message", async () => {
    await seedUsers();
    const { send, requireThreadForActor } = await import("../lib/messages");
    const sent = send({ fromId: A, to: [B, C], subject: "PR", body: "please", request: { kind: "review-pr", goal: "Review it" } });
    for (const who of [B, C]) {
      const t = requireThreadForActor(sent.thread.id, who);
      expect(t.messages[0].request?.kind).toBe("review-pr");
    }
  });
});

describe("limits and validation", () => {
  it("refuses an empty list", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    expect(() => send({ fromId: A, to: [], subject: "x", body: "y" })).toThrow(/at least one recipient/);
  });

  it("refuses a non-string or blank entry", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    expect(() => send({ fromId: A, to: [B, 7 as unknown as string], subject: "x", body: "y" })).toThrow(/non-empty email/);
    expect(() => send({ fromId: A, to: [B, "  "], subject: "x", body: "y" })).toThrow(/non-empty email/);
  });

  it("refuses more than MAX_RECIPIENTS people, not counting yourself", async () => {
    const extra = Array.from({ length: 10 }, (_, i) => `p${i}`);
    await seedUsers(extra);
    const { send, MAX_RECIPIENTS } = await import("../lib/messages");
    expect(MAX_RECIPIENTS).toBe(10);
    const ten = extra.map((p) => `${p}@example.com`);
    expect(send({ fromId: A, to: [A, ...ten], subject: "x", body: "y" }).recipients).toHaveLength(10);
    expect(() => send({ fromId: A, to: [...ten, B], subject: "x", body: "y" })).toThrow(/at most 10 recipients/);
  });

  it("fails the whole send on unknown addresses, names them, and writes nothing", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const { getDb } = await import("../lib/db");
    expect(() => send({ fromId: A, to: [B, "x@example.com", "y@example.com"], subject: "x", body: "y" })).toThrow(
      "Unknown recipients: x@example.com, y@example.com. Nothing was sent.",
    );
    expect(() => send({ fromId: A, to: [B, "x@example.com"], subject: "x", body: "y" })).toThrow(
      "Unknown recipient: x@example.com. Nothing was sent.",
    );
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(0);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number }).n).toBe(0);
  });

  it("refuses an over-long address", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    expect(() => send({ fromId: A, to: [B, `${"a".repeat(330)}@example.com`], subject: "x", body: "y" })).toThrow(/320 characters/);
  });
});

describe("replies in a group", () => {
  it("fan out to every participant but the sender, with no `to`", async () => {
    await seedUsers();
    const { send, unreadCountFor } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    const reply = send({ fromId: B, threadId: first.thread.id, body: "reply" });
    expect(reply.recipients.map((r) => r.id).sort()).toEqual([A, C]);
    expect(unreadCountFor(A)).toBe(1);
    expect(unreadCountFor(C)).toBe(2);
    expect(unreadCountFor(B)).toBe(1);
  });

  it("still reach everyone when `to` names one participant", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    const reply = send({ fromId: B, to: A, threadId: first.thread.id, body: "reply" });
    expect(reply.recipients.map((r) => r.id).sort()).toEqual([A, C]);
  });

  it("refuse a `to` that is not a participant, and add nobody", async () => {
    await seedUsers();
    const { send, participantsOf } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    expect(() => send({ fromId: B, to: [A, D], threadId: first.thread.id, body: "r" })).toThrow(/not a participant/);
    expect(participantsOf(first.thread.id).map((p) => p.id)).toEqual([A, B, C]);
  });

  it("refuse a non-participant sender", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    expect(() => send({ fromId: D, threadId: first.thread.id, body: "r" })).toThrow(/Not a participant/);
  });
});

describe("read state per recipient", () => {
  it("marking read clears only the reader's count", async () => {
    await seedUsers();
    const { send, markRead, unreadCountFor, inboxFor, inboxCounts } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    markRead(first.thread.id, B);
    expect(unreadCountFor(B)).toBe(0);
    expect(unreadCountFor(C)).toBe(1);
    expect(inboxFor(B)[0].unreadCount).toBe(0);
    expect(inboxFor(C)[0].unreadCount).toBe(1);
    expect(inboxCounts(C)).toEqual({ threads: 1, unreadThreads: 1 });
    expect(inboxCounts(B)).toEqual({ threads: 1, unreadThreads: 0 });
  });

  it("each reader sees their own read_at; the sender sees per-recipient read times", async () => {
    await seedUsers();
    const { send, markRead, requireThreadForActor } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    markRead(first.thread.id, C);
    const asB = requireThreadForActor(first.thread.id, B).messages[0];
    const asC = requireThreadForActor(first.thread.id, C).messages[0];
    const asA = requireThreadForActor(first.thread.id, A).messages[0];
    expect(asB.read_at).toBeNull();
    expect(asC.read_at).not.toBeNull();
    expect(asA.recipients.find((r) => r.id === C)?.readAt).not.toBeNull();
    expect(asA.recipients.find((r) => r.id === B)?.readAt).toBeNull();
    // Another recipient sees who it went to, not when each person read it.
    expect(asB.recipients.map((r) => r.id)).toEqual([B, C]);
    expect(asB.recipients.every((r) => r.readAt === null)).toBe(true);
  });

  it("mirrors the first recipient's read into messages.read_at for older readers", async () => {
    await seedUsers();
    const { send, markRead } = await import("../lib/messages");
    const { getDb } = await import("../lib/db");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    markRead(first.thread.id, C);
    const stored = () => (getDb().prepare("SELECT read_at FROM messages WHERE id = ?").get(first.message.id) as { read_at: string | null }).read_at;
    expect(stored()).toBeNull();
    markRead(first.thread.id, B);
    expect(stored()).not.toBeNull();
  });
});

describe("privacy", () => {
  it("a non-participant cannot read the thread, everyone in it sees the participant list", async () => {
    await seedUsers();
    const { send, requireThreadForActor, thread, participantsOf } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    expect(() => requireThreadForActor(first.thread.id, D)).toThrow(/Not a participant/);
    expect(thread(first.thread.id, D)).toBeUndefined();
    for (const who of [A, B, C]) expect(thread(first.thread.id, who)).toBeDefined();
    expect(participantsOf(first.thread.id).map((p) => p.email)).toEqual([A, B, C]);
  });

  it("the inbox lists the thread for every participant, with all participants", async () => {
    await seedUsers();
    const { send, inboxFor } = await import("../lib/messages");
    send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    for (const who of [A, B, C]) {
      const rows = inboxFor(who, { participants: true });
      expect(rows).toHaveLength(1);
      expect(rows[0].participants?.map((p) => p.id)).toEqual([A, B, C]);
      expect(inboxFor(who)[0].participants).toBeUndefined();
    }
    expect(inboxFor(D)).toHaveLength(0);
  });

  it("a lease is per person in a group thread", async () => {
    await seedUsers();
    const { send, recordLease, getLeaseForActor } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    recordLease(first.thread.id, C, 2, 10);
    send({ fromId: C, threadId: first.thread.id, body: "r", useLease: true });
    expect(getLeaseForActor(first.thread.id, C)?.turnsLeft).toBe(1);
    expect(getLeaseForActor(first.thread.id, B)).toBeUndefined();
    expect(() => recordLease(first.thread.id, D, 1, 1)).toThrow(/Not a participant/);
  });
});

describe("review follow-ups", () => {
  it("a group sender's inbox row says read only once every recipient has read", async () => {
    await seedUsers();
    const { send, markRead, inboxFor } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    markRead(first.thread.id, B);
    expect(inboxFor(A)[0].lastMessage.read_at).toBeNull();
    markRead(first.thread.id, C);
    expect(inboxFor(A)[0].lastMessage.read_at).not.toBeNull();
  });

  it("a maintainer who is not in a group thread sees no one's read time", async () => {
    process.env.BAB_MAINTAINERS = D;
    try {
      const { _resetConfigForTests } = await import("../lib/config");
      _resetConfigForTests();
      await seedUsers();
      const { send, markRead, threadForViewer } = await import("../lib/messages");
      const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
      markRead(first.thread.id, B);
      const m = threadForViewer(first.thread.id, D)?.messages[0];
      expect(m?.read_at).toBeNull();
      expect(m?.recipients.every((r) => r.readAt === null)).toBe(true);
    } finally {
      delete process.env.BAB_MAINTAINERS;
      const { _resetConfigForTests } = await import("../lib/config");
      _resetConfigForTests();
    }
  });

  it("an empty list on a reply is refused, not read as no `to`", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const first = send({ fromId: A, to: [B, C], subject: "x", body: "start" });
    expect(() => send({ fromId: B, to: [], threadId: first.thread.id, body: "r" })).toThrow(/at least one recipient/);
  });
});
