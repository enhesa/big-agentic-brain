import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function req(qs = "", headers: Record<string, string> = {}) {
  return new Request(`http://x/api/events${qs}`, { headers }) as never;
}

/** Reads chunks off the stream until `predicate(text)` is true, or gives up after a small number of reads. */
async function readUntil(
  res: Response,
  predicate: (text: string) => boolean,
  maxReads = 20,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < maxReads; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) break;
  }
  await reader.cancel();
  return text;
}

let dataDir: string;

describe("GET /api/events (SSE)", () => {
  // The message test below opens the database; give it its own data dir instead of the /data default.
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "bab-events-test-"));
    process.env.DATA_DIR = dataDir;
  });
  afterEach(async () => {
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    rmSync(dataDir, { recursive: true, force: true });
    const { _resetEventsForTests } = await import("../lib/events");
    const { _resetEventsRouteForTests } = await import("../app/api/events/route");
    _resetEventsForTests();
    _resetEventsRouteForTests();
  });

  it("sets SSE headers", async () => {
    const { GET } = await import("../app/api/events/route");
    const res = await GET(req());

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");

    await res.body?.cancel();
  });

  it("replays buffered events after Last-Event-ID", async () => {
    const { emit } = await import("../lib/events");
    emit("todo.changed", "todo-1", { title: "First" });
    const marker = emit("todo.changed", "todo-2", { title: "Second" });
    emit("todo.changed", "todo-3", { title: "Third" });

    const { GET } = await import("../app/api/events/route");
    const res = await GET(req("", { "last-event-id": String(marker.seq) }));
    const text = await readUntil(res, (t) => t.includes("todo-3"));

    expect(text).not.toContain('"id":"todo-1"');
    expect(text).not.toContain('"id":"todo-2"');
    expect(text).toContain('"id":"todo-3"');
  });

  it("replays buffered events after ?since= as a fallback to Last-Event-ID", async () => {
    const { emit } = await import("../lib/events");
    const marker = emit("vote", "learning-1");
    emit("vote", "learning-2");

    const { GET } = await import("../app/api/events/route");
    const res = await GET(req(`?since=${marker.seq}`));
    const text = await readUntil(res, (t) => t.includes("learning-2"));

    expect(text).not.toContain('"id":"learning-1"');
    expect(text).toContain('"id":"learning-2"');
  });

  it("filters replay to the requested topics", async () => {
    const { emit } = await import("../lib/events");
    emit("todo.changed", "todo-1");
    emit("learning.created", "learning-1", { title: "Filtered in" });

    const { GET } = await import("../app/api/events/route");
    const res = await GET(req("?topics=learning"));
    const text = await readUntil(res, (t) => t.includes("learning-1"));

    expect(text).not.toContain('"id":"todo-1"');
    expect(text).toContain('"id":"learning-1"');
  });

  it("the stream carries no person name for a message (P0.3)", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "alice.a@example.com", email: "alice.a@example.com", name: "Alice Anderson", roles: [] });
    upsertUser({ id: "bob.b@example.com", email: "bob.b@example.com", name: "Bob Builder", roles: [] });
    const { send } = await import("../lib/messages");
    send({ fromId: "alice.a@example.com", to: "bob.b@example.com", subject: "Hi", body: "Hello" });

    const { GET } = await import("../app/api/events/route");
    const res = await GET(req("?since=0"));
    const text = await readUntil(res, (t) => t.includes("message.created"));
    expect(text).toContain("message.created");
    expect(text).not.toMatch(/Alice Anderson|Bob Builder/);
    expect(text).not.toContain('"name"');
  });

  it("sends a ping comment on the configured interval", async () => {
    const { _setPingIntervalMsForTests, GET } = await import("../app/api/events/route");
    _setPingIntervalMsForTests(10);

    const res = await GET(req());
    const text = await readUntil(res, (t) => t.includes(": ping"), 50);
    expect(text).toContain(": ping");
  });

  it("returns 503 with Retry-After once at the concurrent-connection cap", async () => {
    const { _setOpenConnectionsForTests, MAX_CONCURRENT_CONNECTIONS, GET } = await import(
      "../app/api/events/route"
    );
    _setOpenConnectionsForTests(MAX_CONCURRENT_CONNECTIONS);

    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = await res.json();
    expect(body.error).toMatch(/concurrent/i);
  });
});

describe("MAX_CONCURRENT_CONNECTIONS", () => {
  it("is 1000: many open pages are fine on an internal app", async () => {
    const { MAX_CONCURRENT_CONNECTIONS } = await import("../app/api/events/route");
    expect(MAX_CONCURRENT_CONNECTIONS).toBe(1000);
  });
});

describe("GET /api/events per-IP cap", () => {
  beforeEach(async () => {
    // The cap needs an address the operator vouched for.
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    (await import("../lib/config"))._resetConfigForTests();
  });
  afterEach(async () => {
    delete process.env.BAB_CLIENT_IP_HEADER;
    (await import("../lib/config"))._resetConfigForTests();
    const { _resetEventsRouteForTests } = await import("../app/api/events/route");
    _resetEventsRouteForTests();
  });

  it("is skipped when BAB_CLIENT_IP_HEADER is unset (the address is unverified)", async () => {
    delete process.env.BAB_CLIENT_IP_HEADER;
    (await import("../lib/config"))._resetConfigForTests();
    const { GET, MAX_CONNECTIONS_PER_IP } = await import("../app/api/events/route");
    const open: Response[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP + 5; i++) open.push(await GET(req("", { "x-real-ip": "203.0.113.5" })));
    expect(open.every((r) => r.status === 200)).toBe(true);
    for (const r of open) await r.body?.cancel();
  });

  it("429s the 21st stream from one address and still serves another", async () => {
    const { GET, MAX_CONNECTIONS_PER_IP } = await import("../app/api/events/route");
    const open: Response[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) open.push(await GET(req("", { "x-real-ip": "203.0.113.5" })));
    expect(open.every((r) => r.status === 200)).toBe(true);

    expect((await GET(req("", { "x-real-ip": "203.0.113.5" }))).status).toBe(429);
    const other = await GET(req("", { "x-real-ip": "203.0.113.6" }));
    expect(other.status).toBe(200);

    await open[0].body?.cancel();
    const again = await GET(req("", { "x-real-ip": "203.0.113.5" }));
    expect(again.status).toBe(200);
    for (const r of [...open.slice(1), other, again]) await r.body?.cancel();
  });
  it("does not apply the per-IP cap when the address is unresolved", async () => {
    const { GET, MAX_CONNECTIONS_PER_IP } = await import("../app/api/events/route");
    const open: Response[] = [];
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP + 5; i++) open.push(await GET(req("")));
    expect(open.every((r) => r.status === 200)).toBe(true);
    for (const r of open) await r.body?.cancel();
  });
});
