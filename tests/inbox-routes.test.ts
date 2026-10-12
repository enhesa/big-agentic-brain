import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _resetConfigForTests } from "@/lib/config";

/**
 * The two small Inbox routes: POST /inbox/read (mark a thread read) and GET /inbox/unread (the
 * count behind the nav badge). Both are SSO-viewer only: an agent header, a device or a
 * connection is not a browser viewer, and a cross-site POST must not act with the viewer's cookie.
 */

let dataDir: string;
const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const CARL = "carl.c@example.com";
const HOST = "localhost:4310";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-inbox-routes-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_FORGE_HEADERS = "1";
  current = {};
  vi.resetModules();
  vi.doMock("next/headers", () => ({ headers: async () => new Headers({ host: HOST, ...current }) }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_FORGE_HEADERS;
  delete process.env.BAB_INBOX_PAGE;
  _resetConfigForTests();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

// One mock for the whole test: the route modules are imported once, so the headers a request
// carries are swapped through this variable rather than by re-mocking next/headers.
let current: Record<string, string> = {};
function mockHeaders(map: Record<string, string>) {
  current = map;
}
function asViewer(email: string, name: string) {
  mockHeaders({ "x-auth-request-user": `forge-${email}`, "x-auth-request-email": email, "x-auth-request-preferred-username": name });
}

async function seed() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ALICE, email: ALICE, name: "Alice A", roles: [] });
  upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
  upsertUser({ id: CARL, email: CARL, name: "Carl C", roles: [] });
  const { send } = await import("../lib/messages");
  return send({ fromId: ALICE, to: BOB, subject: "Hi", body: "Hello" }).thread.id;
}

function post(body: unknown, headers: Record<string, string> = {}, form = false) {
  return new Request(`http://${HOST}/inbox/read`, {
    method: "POST",
    headers: {
      "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
      host: HOST,
      origin: `http://${HOST}`,
      ...headers,
    },
    body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
  });
}

describe("POST /inbox/read", () => {
  it("marks the viewer's messages read and says how many are left", async () => {
    const threadId = await seed();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/read/route");
    const res = await POST(post({ threadId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unread: 0 });
    const { unreadCountFor } = await import("../lib/messages");
    expect(unreadCountFor(BOB)).toBe(0);
  });

  it("answers a plain form post with a redirect back to the thread", async () => {
    const threadId = await seed();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/read/route");
    const res = await POST(post({ threadId }, {}, true));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`http://${HOST}/inbox?thread=${threadId}`);
    const { unreadCountFor } = await import("../lib/messages");
    expect(unreadCountFor(BOB)).toBe(0);
  });

  it("refuses a cross-site or origin-less post and marks nothing", async () => {
    const threadId = await seed();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/read/route");
    expect((await POST(post({ threadId }, { origin: "https://evil.example" }))).status).toBe(403);
    const noOrigin = new Request(`http://${HOST}/inbox/read`, {
      method: "POST",
      headers: { "content-type": "application/json", host: HOST },
      body: JSON.stringify({ threadId }),
    });
    expect((await POST(noOrigin)).status).toBe(403);
    const { unreadCountFor } = await import("../lib/messages");
    expect(unreadCountFor(BOB)).toBe(1);
  });

  it("is 401 for an agent header, a missing viewer and an unlinked alias viewer", async () => {
    const threadId = await seed();
    const { POST } = await import("../app/inbox/read/route");
    const { unreadCountFor } = await import("../lib/messages");

    mockHeaders({ "x-bab-actor-email": BOB, "x-bab-actor-name": "Bob B" });
    expect((await POST(post({ threadId }))).status).toBe(401);

    mockHeaders({});
    expect((await POST(post({ threadId }))).status).toBe(401);

    mockHeaders({ "x-auth-request-user": "alias-1", "x-auth-request-email": "bobb@example.com", "x-auth-request-preferred-username": "Bob B" });
    expect((await POST(post({ threadId }))).status).toBe(401);

    expect(unreadCountFor(BOB)).toBe(1);
  });

  it("redirects a signed-out form post to /inbox instead of showing JSON", async () => {
    const threadId = await seed();
    mockHeaders({});
    const { POST } = await import("../app/inbox/read/route");
    const res = await POST(post({ threadId }, {}, true));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`http://${HOST}/inbox`);
  });

  it("is 404 for a thread the viewer is not in, an unknown id or a missing id, and touches nothing", async () => {
    const threadId = await seed();
    asViewer(CARL, "Carl C");
    const { POST } = await import("../app/inbox/read/route");
    expect((await POST(post({ threadId }))).status).toBe(404);
    expect((await POST(post({ threadId: "no-such-thread" }))).status).toBe(404);
    expect((await POST(post({ threadId: "../x" }))).status).toBe(404);
    expect((await POST(post({}))).status).toBe(404);
    const { unreadCountFor } = await import("../lib/messages");
    expect(unreadCountFor(BOB)).toBe(1);
  });

  it("only reads the viewer's side: the sender's own view of the thread is unchanged", async () => {
    const threadId = await seed();
    const { send, unreadCountFor } = await import("../lib/messages");
    send({ fromId: BOB, to: ALICE, threadId, body: "Reply" });
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/read/route");
    await POST(post({ threadId }));
    expect(unreadCountFor(BOB)).toBe(0);
    expect(unreadCountFor(ALICE)).toBe(1);
  });

  it("emits a read event so other open tabs refresh, audits it, and is rate limited", async () => {
    const threadId = await seed();
    asViewer(BOB, "Bob B");
    const events = await import("../lib/events");
    const { POST } = await import("../app/inbox/read/route");
    await POST(post({ threadId }));
    expect(events.eventsSince(0).some((e) => e.payload.kind === "read" && e.id === threadId)).toBe(true);
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT via FROM audit_log WHERE action = 'read' AND entity_id = ?").get(threadId);
    expect(row).toEqual({ via: "ui" });
  });

  it("writes no audit row when there was nothing to mark read", async () => {
    const threadId = await seed();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/read/route");
    const { getDb } = await import("../lib/db");
    const count = () =>
      (getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'read' AND entity_id = ?").get(threadId) as { n: number }).n;
    await POST(post({ threadId }));
    expect(count()).toBe(1);
    await POST(post({ threadId }));
    await POST(post({ threadId }));
    expect(count()).toBe(1);
  });

  it("has its own rate-limit bucket: a busy agent session cannot 429 the person's click, and the reverse", async () => {
    const threadId = await seed();
    asViewer(BOB, "Bob B");
    const { POST } = await import("../app/inbox/read/route");
    const { checkRateLimit, checkUiRateLimit } = await import("../lib/rate-limit");

    // Bob's agent spends the whole agent-API budget under his id.
    while (checkRateLimit(BOB)) {
      /* spend the window */
    }
    expect((await POST(post({ threadId }))).status).toBe(200);

    // The browser's own budget runs out on its own, and only for the browser routes.
    while (checkUiRateLimit(BOB)) {
      /* spend the window */
    }
    expect((await POST(post({ threadId }))).status).toBe(429);
    const { GET } = await import("../app/inbox/unread/route");
    expect((await GET()).status).toBe(429);

    // Another person is unaffected, and so is the agent bucket of someone else.
    asViewer(CARL, "Carl C");
    expect((await GET()).status).toBe(200);
    expect(checkRateLimit(CARL)).toBe(true);
  });

  it("answers 503 while BAB_INBOX_PAGE=0", async () => {
    const threadId = await seed();
    asViewer(BOB, "Bob B");
    process.env.BAB_INBOX_PAGE = "0";
    (await import("@/lib/config"))._resetConfigForTests(); // same module registry as the routes
    const { POST } = await import("../app/inbox/read/route");
    expect((await POST(post({ threadId }))).status).toBe(503);
    const { unreadCountFor } = await import("../lib/messages");
    expect(unreadCountFor(BOB)).toBe(1);
  });
});

describe("GET /inbox/unread", () => {
  it("returns the viewer's own count, uncached", async () => {
    await seed();
    asViewer(BOB, "Bob B");
    const { GET } = await import("../app/inbox/unread/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ unread: 1 });

    asViewer(CARL, "Carl C");
    expect(await (await GET()).json()).toEqual({ unread: 0 });
  });

  it("is 401 for agent headers and signed-out callers, and 503 when switched off", async () => {
    await seed();
    const { GET } = await import("../app/inbox/unread/route");
    mockHeaders({ "x-bab-actor-email": BOB, "x-bab-actor-name": "Bob B" });
    expect((await GET()).status).toBe(401);
    mockHeaders({});
    expect((await GET()).status).toBe(401);

    asViewer(BOB, "Bob B");
    process.env.BAB_INBOX_PAGE = "0";
    (await import("@/lib/config"))._resetConfigForTests(); // same module registry as the routes
    expect((await GET()).status).toBe(503);
  });
});
