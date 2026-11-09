import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _resetConfigForTests } from "@/lib/config";

/**
 * GET /inbox/unread, the count behind the nav badge. SSO-viewer only: an agent header, a device
 * or a connection is not a browser viewer. The Inbox is read-only, so there is no POST route.
 */

let dataDir: string;
const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const CARL = "carl.c@example.com";
const HOST = "localhost:4310";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-inbox-routes-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  current = {};
  vi.resetModules();
  vi.doMock("next/headers", () => ({ headers: async () => new Headers({ host: HOST, ...current }) }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
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
  mockHeaders({ "x-auth-request-user": `proxy-${email}`, "x-auth-request-email": email, "x-auth-request-preferred-username": name });
}

async function seed() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ALICE, email: ALICE, name: "Alice A", roles: [] });
  upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
  upsertUser({ id: CARL, email: CARL, name: "Carl C", roles: [] });
  const { send } = await import("../lib/messages");
  return send({ fromId: ALICE, to: BOB, subject: "Hi", body: "Hello" }).thread.id;
}

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
