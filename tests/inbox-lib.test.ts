import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _resetConfigForTests } from "@/lib/config";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-inbox-lib-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_INBOX_PAGE;
  delete process.env.BAB_MAINTAINERS;
  _resetConfigForTests();
});

const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const CARL = "carl.c@example.com";

async function seed() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ALICE, email: ALICE, name: "Alice A", roles: [] });
  upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
  upsertUser({ id: CARL, email: CARL, name: "Carl C", roles: [] });
}

describe("inboxEnabled", () => {
  it("is on unless BAB_INBOX_PAGE is 0, false, no or off", async () => {
    const { inboxEnabled } = await import("../lib/inbox-page");
    expect(inboxEnabled()).toBe(true);
    process.env.BAB_INBOX_PAGE = "1";
    _resetConfigForTests();
    expect(inboxEnabled()).toBe(true);
    process.env.BAB_INBOX_PAGE = "0";
    _resetConfigForTests();
    expect(inboxEnabled()).toBe(false);
  });
});

describe("inboxSummary", () => {
  it("lists only the viewer's threads, with unread counts, names and a one-line snippet", async () => {
    await seed();
    const { send } = await import("../lib/messages");
    const { inboxSummary } = await import("../lib/inbox-page");
    const first = send({ fromId: ALICE, to: BOB, subject: "Review", body: "Line one\n\n  line   two" });
    send({ fromId: ALICE, to: BOB, threadId: first.thread.id, body: "Second" });
    send({ fromId: ALICE, to: CARL, subject: "Not for Bob", body: "Secret" });

    const bob = inboxSummary(BOB);
    expect(bob.unread).toBe(2);
    expect(bob.threads).toHaveLength(1);
    expect(bob.threads[0]).toMatchObject({
      id: first.thread.id,
      subject: "Review",
      unread: 2,
      otherName: "Alice A",
      lastFromViewer: false,
      snippet: "Second",
    });

    const alice = inboxSummary(ALICE);
    expect(alice.unread).toBe(0);
    expect(alice.threads).toHaveLength(2);
    expect(alice.threads.every((t) => t.lastFromViewer)).toBe(true);
    expect(inboxSummary("nobody@example.com")).toEqual({ unread: 0, threads: [] });
  });

  it("collapses whitespace and cuts long snippets", async () => {
    await seed();
    const { send } = await import("../lib/messages");
    const { inboxSummary } = await import("../lib/inbox-page");
    send({ fromId: ALICE, to: BOB, subject: "S", body: `a\n\n b ${"x".repeat(400)}` });
    const snippet = inboxSummary(BOB).threads[0].snippet;
    expect(snippet.startsWith("a b xxx")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(120);
  });

  it("falls back to (no subject) and caps the list but not the unread total", async () => {
    await seed();
    const { getDb } = await import("../lib/db");
    const { send } = await import("../lib/messages");
    const { inboxSummary, INBOX_LIST_MAX } = await import("../lib/inbox-page");
    for (let i = 0; i < INBOX_LIST_MAX + 3; i++) send({ fromId: ALICE, to: BOB, subject: `T${i}`, body: "x" });
    getDb().prepare("UPDATE threads SET subject = NULL").run();
    const s = inboxSummary(BOB);
    expect(s.threads).toHaveLength(INBOX_LIST_MAX);
    expect(s.threads[0].subject).toBe("(no subject)");
    expect(s.unread).toBe(INBOX_LIST_MAX + 3);
  });
});

describe("threadForParticipant", () => {
  it("returns the enriched thread to a participant only", async () => {
    await seed();
    const { send } = await import("../lib/messages");
    const { threadForParticipant } = await import("../lib/inbox-page");
    const { thread } = send({ fromId: ALICE, to: BOB, subject: "Hi", body: "Hello" });

    const asBob = threadForParticipant(thread.id, BOB);
    expect(asBob?.messages[0]).toMatchObject({ body: "Hello", fromName: "Alice A", toName: "Bob B" });
    expect(threadForParticipant(thread.id, ALICE)).toBeDefined();
    expect(threadForParticipant(thread.id, CARL)).toBeUndefined();
  });

  it("does not let a maintainer in: the Inbox is the viewer's own threads, unlike the thread page", async () => {
    await seed();
    process.env.BAB_MAINTAINERS = CARL;
    const { send, threadForViewer } = await import("../lib/messages");
    const { threadForParticipant } = await import("../lib/inbox-page");
    const { thread } = send({ fromId: ALICE, to: BOB, subject: "Hi", body: "Hello" });

    expect(threadForViewer(thread.id, CARL)).toBeDefined();
    expect(threadForParticipant(thread.id, CARL)).toBeUndefined();
  });

  it("is undefined for a malformed or unknown id", async () => {
    await seed();
    const { threadForParticipant } = await import("../lib/inbox-page");
    expect(threadForParticipant("nope", BOB)).toBeUndefined();
    expect(threadForParticipant("../../etc/passwd", BOB)).toBeUndefined();
    expect(threadForParticipant("", BOB)).toBeUndefined();
  });
});

describe("eventConcernsViewer", () => {
  it("forwards a message to or from the viewer, as thread id and kind only", async () => {
    await seed();
    const { send } = await import("../lib/messages");
    const { eventConcernsViewer } = await import("../lib/inbox-page");
    const { message, thread } = send({ fromId: ALICE, to: BOB, subject: "Hi", body: "Hello" });
    const event = { seq: 1, type: "message.created" as const, id: thread.id, at: "", payload: { id: message.id, kind: "human" } };

    expect(eventConcernsViewer(event, BOB)).toEqual({ threadId: thread.id, kind: "message" });
    expect(eventConcernsViewer(event, ALICE)).toEqual({ threadId: thread.id, kind: "message" });
    expect(eventConcernsViewer(event, CARL)).toBeNull();
  });

  it("forwards a read only to a participant of that thread", async () => {
    await seed();
    const { send } = await import("../lib/messages");
    const { eventConcernsViewer } = await import("../lib/inbox-page");
    const { thread } = send({ fromId: ALICE, to: BOB, subject: "Hi", body: "Hello" });
    const event = { seq: 2, type: "message.created" as const, id: thread.id, at: "", payload: { id: thread.id, kind: "read" } };

    expect(eventConcernsViewer(event, ALICE)).toEqual({ threadId: thread.id, kind: "read" });
    expect(eventConcernsViewer(event, BOB)).toEqual({ threadId: thread.id, kind: "read" });
    expect(eventConcernsViewer(event, CARL)).toBeNull();
  });

  it("ignores other event types and events with no usable id", async () => {
    await seed();
    const { eventConcernsViewer } = await import("../lib/inbox-page");
    expect(eventConcernsViewer({ seq: 3, type: "vote", id: "x", at: "", payload: {} }, BOB)).toBeNull();
    expect(eventConcernsViewer({ seq: 4, type: "message.created", id: "x", at: "", payload: {} }, BOB)).toBeNull();
    expect(
      eventConcernsViewer({ seq: 5, type: "message.created", id: "x", at: "", payload: { id: "no-such-message", kind: "human" } }, BOB),
    ).toBeNull();
    expect(
      eventConcernsViewer({ seq: 6, type: "message.created", id: "t", at: "", payload: { id: "no-such-thread", kind: "read" } }, BOB),
    ).toBeNull();
  });
});
