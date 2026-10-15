import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * Honest delivery state for the sender: what BAB actually knows about whether the other side
 * can see a message right now. It never says "delivered to a person"; it says, only to someone
 * they have already written to, whether their Inbox page is open (a stranger must not learn when
 * a colleague is at their desk). Otherwise the message waits in their inbox.
 */

let dataDir: string;
const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const CARL = "carl.c@example.com";

let current: Record<string, string> = {};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-delivery-test-"));
  process.env.DATA_DIR = dataDir;
  current = {};
  vi.resetModules();
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  const { _resetPagePresenceForTests } = await import("../lib/page-presence");
  _resetPagePresenceForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

async function seed() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ALICE, email: ALICE, name: "Alice A", roles: [] });
  upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
  upsertUser({ id: CARL, email: CARL, name: "Carl C", roles: [] });
}
function asAgent(email: string, name: string) {
  current = { "x-bab-actor-email": email, "x-bab-actor-name": name };
}

/** Bob has written to Alice before: the condition for Alice to be told his Inbox page is open. */
async function bobRepliedToAlice() {
  const { send } = await import("../lib/messages");
  const first = send({ fromId: ALICE, to: BOB, subject: "Earlier", body: "first" });
  send({ fromId: BOB, to: ALICE, threadId: first.thread.id, body: "reply" });
}

describe("deliveryFor", () => {
  it("is none and none when nothing says the recipient is there, and tells the sender not to wait", async () => {
    await seed();
    const { getUser } = await import("../lib/users");
    const { deliveryFor } = await import("../lib/delivery");
    const d = deliveryFor(getUser(BOB), ALICE);
    expect(d).toMatchObject({ page: "none" });
    expect(d.note).toBe(
      "Sent to their BAB inbox. Messages are async: they see it the next time they use Claude, or within seconds if Claude is already open.",
    );
  });

  it("is connected while their Inbox page has a stream open, to a sender they have written to", async () => {
    await seed();
    await bobRepliedToAlice();
    const { getUser } = await import("../lib/users");
    const { openPageStream } = await import("../lib/page-presence");
    const { deliveryFor } = await import("../lib/delivery");
    const close = openPageStream(BOB)!;
    const d = deliveryFor(getUser(BOB), ALICE);
    expect(d).toMatchObject({ page: "connected" });
    expect(d.note).toMatch(/Inbox page is open/);
    close();
    expect(deliveryFor(getUser(BOB), ALICE).page).toBe("none");
  });

  it("never reveals the open page to a sender the recipient has not written to", async () => {
    await seed();
    const { getUser } = await import("../lib/users");
    const { openPageStream } = await import("../lib/page-presence");
    const { send } = await import("../lib/messages");
    const { deliveryFor } = await import("../lib/delivery");
    const close = openPageStream(BOB)!;

    // No shared history at all.
    expect(deliveryFor(getUser(BOB), ALICE).page).toBe("none");
    // Alice has written to Bob, but Bob has never answered her.
    send({ fromId: ALICE, to: BOB, subject: "Hello", body: "anyone there?" });
    expect(deliveryFor(getUser(BOB), ALICE).page).toBe("none");
    // Bob writing to Carl does not make Alice any wiser, and the note says nothing about the page.
    send({ fromId: BOB, to: CARL, subject: "Hi Carl", body: "x" });
    const d = deliveryFor(getUser(BOB), ALICE);
    expect(d.page).toBe("none");
    expect(d.note).not.toMatch(/Inbox/);
    // Carl, whom Bob did write to, may see it.
    expect(deliveryFor(getUser(BOB), CARL).page).toBe("connected");
    close();
  });

  it("counts a message from the recipient to this sender, whoever started the thread", async () => {
    await seed();
    const { getUser } = await import("../lib/users");
    const { openPageStream } = await import("../lib/page-presence");
    const { send } = await import("../lib/messages");
    const { deliveryFor } = await import("../lib/delivery");
    const close = openPageStream(BOB)!;
    send({ fromId: BOB, to: ALICE, subject: "From Bob", body: "hi" });
    expect(deliveryFor(getUser(BOB), ALICE).page).toBe("connected");
    close();
  });

  it("handles a recipient that does not exist", async () => {
    await seed();
    const { deliveryFor } = await import("../lib/delivery");
    expect(deliveryFor(undefined, ALICE)).toMatchObject({ page: "none" });
  });

});

describe("outgoingStatus", () => {
  it("says read or not read yet, then whether their Inbox is open, and nothing about a page it may not reveal", async () => {
    const { outgoingStatus } = await import("../lib/delivery");
    expect(outgoingStatus({ toName: "Bob B", readAt: null, page: "none" })).toBe(
      "Bob B has not read your last message yet.",
    );
    expect(outgoingStatus({ toName: "Bob B", readAt: "2026-10-02 10:00:00", page: "connected" })).toMatch(
      /^Bob B read your last message .*Their Inbox is open\.$/,
    );
    expect(outgoingStatus({ toName: "Bob B", readAt: "2026-10-02 10:00:00", page: "none" })).toMatch(
      /^Bob B read your last message [^.]*\.$/,
    );
    expect(outgoingStatus({ toName: "Bob B", readAt: null, page: "connected" })).toBe(
      "Bob B has not read your last message yet. Their Inbox is open.",
    );
  });
});

describe("send() and the agent surfaces report it", () => {
  it("send() returns delivery next to thread and message", async () => {
    await seed();
    await bobRepliedToAlice();
    const { send } = await import("../lib/messages");
    const { openPageStream } = await import("../lib/page-presence");
    const quiet = send({ fromId: ALICE, to: BOB, subject: "One", body: "x" });
    expect(quiet.delivery).toMatchObject({ page: "none" });
    const close = openPageStream(BOB)!;
    const live = send({ fromId: ALICE, to: BOB, threadId: quiet.thread.id, body: "y" });
    expect(live.delivery).toMatchObject({ page: "connected" });
    close();
  });

  it("send() keeps the page closed to a sender who was never answered", async () => {
    await seed();
    const { send } = await import("../lib/messages");
    const { openPageStream } = await import("../lib/page-presence");
    const close = openPageStream(BOB)!;
    expect(send({ fromId: ALICE, to: BOB, subject: "Cold", body: "x" }).delivery.page).toBe("none");
    close();
  });

  it("bab_send's result carries delivery", async () => {
    await seed();
    await bobRepliedToAlice();
    asAgent(ALICE, "Alice A");
    const { openPageStream } = await import("../lib/page-presence");
    const close = openPageStream(BOB)!;
    const { POST } = await import("../app/mcp/route");
    const res = await POST(
      new Request("https://bab.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "bab_send", arguments: { to: BOB, subject: "Ping", body: "hello" } },
        }),
      }),
    );
    const out = await res.json();
    const parsed = JSON.parse(out.result.content[0].text);
    expect(parsed.delivery).toMatchObject({ page: "connected" });
    expect(parsed.delivery.note).toMatch(/Inbox page is open/);
    close();
  });

  it("describes delivery in the bab_send tool description so agents relay it", async () => {
    const { TOOLS } = await import("../lib/mcp");
    const tool = TOOLS.find((t) => t.name === "bab_send")!;
    expect(tool.description).toMatch(/delivery/);
  });

  it("POST /api/messages returns delivery with the 201", async () => {
    await seed();
    asAgent(ALICE, "Alice A");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(
      new Request("http://x/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: BOB, subject: "Hi", body: "First" }),
      }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.delivery).toMatchObject({ page: "none" });
  });
});
