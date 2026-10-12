import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _resetConfigForTests } from "@/lib/config";

/**
 * GET /inbox/events: the viewer-scoped stream. The public /api/events carries every event to
 * anyone; this one forwards only what concerns the signed-in viewer, as a thread id and a kind.
 */

let dataDir: string;
const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const CARL = "carl.c@example.com";
const HOST = "localhost:4310";

let current: Record<string, string> = {};
function asViewer(email: string, name: string) {
  current = { "x-auth-request-user": `forge-${email}`, "x-auth-request-email": email, "x-auth-request-preferred-username": name };
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-inbox-events-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_FORGE_HEADERS = "1";
  current = {};
  vi.resetModules();
  vi.doMock("next/headers", () => ({ headers: async () => new Headers({ host: HOST, ...current }) }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  const { _resetShutdownForTests } = await import("../lib/shutdown");
  _resetShutdownForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_FORGE_HEADERS;
  delete process.env.BAB_INBOX_PAGE;
  _resetConfigForTests();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

async function seed() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ALICE, email: ALICE, name: "Alice A", roles: [] });
  upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
  upsertUser({ id: CARL, email: CARL, name: "Carl C", roles: [] });
}

function req(controller = new AbortController()) {
  return { req: new Request(`http://${HOST}/inbox/events`, { signal: controller.signal }), controller };
}

/** Reads until the predicate holds or the stream ends, with a time limit so a missing event fails fast. */
async function readUntil(res: Response, predicate: (text: string) => boolean, ms = 2000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  // One read stays pending across the loop: racing a fresh read() against a timer would let a
  // timed-out read swallow the next chunk.
  let pending: ReturnType<typeof reader.read> | null = null;
  while (Date.now() < deadline && !predicate(text)) {
    pending ??= reader.read();
    const next = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 100))]);
    if (next === null) continue;
    pending = null;
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return text;
}

describe("GET /inbox/events", () => {
  it("is 401 for an agent header and for no viewer, and 503 while switched off", async () => {
    await seed();
    const { GET } = await import("../app/inbox/events/route");
    current = { "x-bab-actor-email": BOB, "x-bab-actor-name": "Bob B" };
    expect((await GET(req().req)).status).toBe(401);
    current = {};
    expect((await GET(req().req)).status).toBe(401);

    asViewer(BOB, "Bob B");
    process.env.BAB_INBOX_PAGE = "0";
    (await import("@/lib/config"))._resetConfigForTests(); // same module registry as the routes
    expect((await GET(req().req)).status).toBe(503);
  });

  it("opens an SSE stream with a retry hint and no buffering, and marks the page connected", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const { pageConnected } = await import("../lib/page-presence");
    const { req: r, controller } = req();
    const res = await GET(r);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(pageConnected(BOB)).toBe(true);
    const text = await readUntil(res, (t) => t.includes("event: ping"));
    expect(text).toContain("retry: 2000");
    expect(text).toContain("event: ping");
    controller.abort();
    await res.body?.cancel().catch(() => {});
  });

  it("forwards a message to the viewer as thread id and kind only", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const { send } = await import("../lib/messages");
    const { req: r, controller } = req();
    const res = await GET(r);
    const { thread } = send({ fromId: ALICE, to: BOB, subject: "TOP-SECRET-SUBJECT", body: "TOP-SECRET-BODY" });

    const text = await readUntil(res, (t) => t.includes("event: inbox"));
    expect(text).toContain("event: inbox");
    const data = text.match(/event: inbox\ndata: (.*)\n/)?.[1];
    expect(JSON.parse(data!)).toEqual({ threadId: thread.id, kind: "message" });
    expect(text).not.toContain("TOP-SECRET");
    expect(text).not.toContain("Alice");
    controller.abort();
  });

  it("forwards a read on the viewer's thread, for example from another machine", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const { send, markRead } = await import("../lib/messages");
    const { thread } = send({ fromId: ALICE, to: BOB, subject: "Hi", body: "Hello" });
    const { req: r, controller } = req();
    const res = await GET(r);
    markRead(thread.id, BOB, "mcp");
    const text = await readUntil(res, (t) => t.includes('"kind":"read"'));
    expect(text).toContain(`event: inbox\ndata: {"threadId":"${thread.id}","kind":"read"}`);
    controller.abort();
  });

  it("sends nothing about a conversation between two other people", async () => {
    await seed();
    asViewer(CARL, "Carl C");
    const { GET } = await import("../app/inbox/events/route");
    const { send, markRead } = await import("../lib/messages");
    const { _setPingIntervalMsForTests } = await import("../app/inbox/events/route");
    _setPingIntervalMsForTests(50);
    const { req: r, controller } = req();
    const res = await GET(r);
    const { thread } = send({ fromId: ALICE, to: BOB, subject: "Private", body: "Between us" });
    markRead(thread.id, BOB, "mcp");
    // A later message to Carl proves the stream was live and still skipped the two before it.
    const mine = send({ fromId: ALICE, to: CARL, subject: "For Carl", body: "Hi Carl" });
    const text = await readUntil(res, (t) => t.includes(mine.thread.id));
    expect(text).toContain(mine.thread.id);
    expect(text).not.toContain(thread.id);
    expect(text.match(/event: inbox/g)).toHaveLength(1);
    controller.abort();
  });

  it("caps streams per viewer with a 429 and frees a slot when one closes", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const { MAX_STREAMS_PER_VIEWER, pageConnected } = await import("../lib/page-presence");
    const open = [];
    for (let i = 0; i < MAX_STREAMS_PER_VIEWER; i++) {
      const c = new AbortController();
      open.push({ c, res: await GET(req(c).req) });
    }
    const refused = await GET(req().req);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();

    open[0].c.abort();
    await open[0].res.body?.cancel().catch(() => {});
    const c = new AbortController();
    const replacement = await GET(req(c).req);
    expect(replacement.status).toBe(200);

    for (const o of [...open.slice(1), { c, res: replacement }]) {
      o.c.abort();
      await o.res.body?.cancel().catch(() => {});
    }
    expect(pageConnected(BOB)).toBe(false);
  });

  it("frees the viewer and stops forwarding once the client goes away", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const { pageConnected } = await import("../lib/page-presence");
    const events = await import("../lib/events");
    const { req: r, controller } = req();
    const res = await GET(r);
    expect(pageConnected(BOB)).toBe(true);
    controller.abort();
    await res.body?.cancel().catch(() => {});
    expect(pageConnected(BOB)).toBe(false);
    // No leaked subscriber: emitting after the close must not throw or enqueue anywhere.
    expect(() => events.emit("message.created", "t", { id: "m", kind: "human" })).not.toThrow();
  });

  it("ends the stream at once when the server begins shutting down", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const { beginShutdown } = await import("../lib/shutdown");
    const { pageConnected } = await import("../lib/page-presence");
    const { req: r } = req();
    const res = await GET(r);
    const reader = res.body!.getReader();
    await reader.read(); // the opening chunk
    beginShutdown();
    let done = false;
    for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect(pageConnected(BOB)).toBe(false);
  });

  it("sends a named ping on its interval so the client can tell silence from a quiet inbox", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET, _setPingIntervalMsForTests } = await import("../app/inbox/events/route");
    _setPingIntervalMsForTests(30);
    const { req: r, controller } = req();
    const res = await GET(r);
    const text = await readUntil(res, (t) => (t.match(/event: ping/g) ?? []).length >= 3);
    expect((text.match(/event: ping/g) ?? []).length).toBeGreaterThanOrEqual(3);
    controller.abort();
  });
});

describe("GET /inbox/events lifetime and cross-site guard", () => {
  const withHeaders = (headers: Record<string, string>, signal?: AbortSignal) =>
    new Request(`http://${HOST}/inbox/events`, { headers: { host: HOST, ...headers }, signal });

  it("refuses a cross-site request, whatever the viewer's cookie would say", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const { pageConnected } = await import("../lib/page-presence");
    const res = await GET(withHeaders({ "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(pageConnected(BOB)).toBe(false);
  });

  it("refuses an Origin that is not this app's, and one it cannot compare", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const { pageConnected } = await import("../lib/page-presence");
    expect((await GET(withHeaders({ origin: "https://evil.example" }))).status).toBe(403);
    // No Host to build the app origin from: refuse rather than guess.
    const hostless = new Request(`http://${HOST}/inbox/events`, { headers: { origin: `http://${HOST}` } });
    expect((await GET(hostless)).status).toBe(403);
    expect(pageConnected(BOB)).toBe(false);
  });

  it("serves a same-origin request, with or without an Origin header", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const a = new AbortController();
    const b = new AbortController();
    const same = await GET(withHeaders({ "sec-fetch-site": "same-origin", origin: `http://${HOST}` }, a.signal));
    const plain = await GET(withHeaders({}, b.signal));
    expect(same.status).toBe(200);
    expect(plain.status).toBe(200);
    a.abort();
    b.abort();
    await same.body?.cancel().catch(() => {});
    await plain.body?.cancel().catch(() => {});
  });

  it("checks cross-site before identity, so a refused request never reaches a lookup", async () => {
    await seed();
    current = {};
    const { GET } = await import("../app/inbox/events/route");
    expect((await GET(withHeaders({ "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });

  it("closes the stream after its maximum lifetime and frees the slot", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET, _setMaxLifetimeMsForTests } = await import("../app/inbox/events/route");
    const { pageConnected } = await import("../lib/page-presence");
    _setMaxLifetimeMsForTests(60);
    const res = await GET(withHeaders({}));
    expect(pageConnected(BOB)).toBe(true);
    const reader = res.body!.getReader();
    let done = false;
    const deadline = Date.now() + 2000;
    while (!done && Date.now() < deadline) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect(pageConnected(BOB)).toBe(false);
    // The client's EventSource reconnects on its own, and gets a fresh stream.
    _setMaxLifetimeMsForTests(20 * 60_000);
    const again = new AbortController();
    const next = await GET(withHeaders({}, again.signal));
    expect(next.status).toBe(200);
    again.abort();
    await next.body?.cancel().catch(() => {});
  });

  it("has a 20 minute default lifetime", async () => {
    const { MAX_STREAM_LIFETIME_MS } = await import("../app/inbox/events/route");
    expect(MAX_STREAM_LIFETIME_MS).toBe(20 * 60_000);
  });

  it("closes a stream whose peer stopped reading, on a ping, and frees the slot", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET, _setPingIntervalMsForTests } = await import("../app/inbox/events/route");
    const { pageConnected } = await import("../lib/page-presence");
    _setPingIntervalMsForTests(10);
    const res = await GET(withHeaders({}));
    expect(pageConnected(BOB)).toBe(true);
    // Nobody reads the body: the pings pile up in the queue like they would on a dead socket.
    const deadline = Date.now() + 3000;
    while (pageConnected(BOB) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(pageConnected(BOB)).toBe(false);
    await res.body?.cancel().catch(() => {});
  });

  it("does not close a stream whose peer keeps reading", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET, _setPingIntervalMsForTests } = await import("../app/inbox/events/route");
    const { pageConnected } = await import("../lib/page-presence");
    _setPingIntervalMsForTests(10);
    const controller = new AbortController();
    const res = await GET(withHeaders({}, controller.signal));
    const text = await readUntil(res, (t) => (t.match(/event: ping/g) ?? []).length >= 8, 3000);
    expect((text.match(/event: ping/g) ?? []).length).toBeGreaterThanOrEqual(8);
    controller.abort();
    expect(pageConnected(BOB)).toBe(false);
  });

  it("frees everything at once for a request that was already aborted when the stream started", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/events/route");
    const { pageConnected, openPageStream, MAX_STREAMS_PER_VIEWER } = await import("../lib/page-presence");
    const events = await import("../lib/events");
    const gone = new AbortController();
    gone.abort();
    const res = await GET(withHeaders({}, gone.signal));
    expect(pageConnected(BOB)).toBe(false);
    // No leaked slot: the viewer can still open the full number of streams.
    const open = Array.from({ length: MAX_STREAMS_PER_VIEWER }, () => openPageStream(BOB));
    expect(open.every(Boolean)).toBe(true);
    open.forEach((close) => close!());
    expect(() => events.emit("message.created", "t", { id: "m", kind: "human" })).not.toThrow();
    await res.body?.cancel().catch(() => {});
  });
});
