import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-inbox-lease-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

function mockNoIdentity() {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
}

function mockAgentIdentity(email: string, name: string) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": name }),
  }));
}

function leaseReq(threadId: string, body: unknown) {
  return new Request(`http://x/api/inbox/${threadId}/lease`, { method: "POST", body: JSON.stringify(body) }) as never;
}

describe("POST /api/inbox/[threadId]/lease", () => {
  it("401s without identity", async () => {
    mockNoIdentity();
    const { POST } = await import("../app/api/inbox/[threadId]/lease/route");
    const res = await POST(leaseReq("t1", { turns: 3, minutes: 10 }), { params: Promise.resolve({ threadId: "t1" }) });
    expect(res.status).toBe(401);
  });

  it("records a lease for a participant and returns it", async () => {
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob.t@example.com", email: "bob.t@example.com", name: "Bob", roles: [] });
    upsertUser({ id: "alice.t@example.com", email: "alice.t@example.com", name: "Alice", roles: [] });
    const { send } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice.t@example.com", to: "bob.t@example.com", body: "hi" }, "mcp");

    const { POST } = await import("../app/api/inbox/[threadId]/lease/route");
    const res = await POST(leaseReq(thread.id, { turns: 5, minutes: 15 }), {
      params: Promise.resolve({ threadId: thread.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lease.turnsLeft).toBe(5);
    expect(body.lease.actorId).toBe("alice.t@example.com");
  });

  it("400s on turns/minutes outside 1-10 / 1-60", async () => {
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob.t@example.com", email: "bob.t@example.com", name: "Bob", roles: [] });
    upsertUser({ id: "alice.t@example.com", email: "alice.t@example.com", name: "Alice", roles: [] });
    const { send } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice.t@example.com", to: "bob.t@example.com", body: "hi" }, "mcp");

    const { POST } = await import("../app/api/inbox/[threadId]/lease/route");
    const bad1 = await POST(leaseReq(thread.id, { turns: 0, minutes: 10 }), { params: Promise.resolve({ threadId: thread.id }) });
    expect(bad1.status).toBe(400);
    const bad2 = await POST(leaseReq(thread.id, { turns: 11, minutes: 10 }), { params: Promise.resolve({ threadId: thread.id }) });
    expect(bad2.status).toBe(400);
    const bad3 = await POST(leaseReq(thread.id, { turns: 3, minutes: 61 }), { params: Promise.resolve({ threadId: thread.id }) });
    expect(bad3.status).toBe(400);
  });

  it("404s for an unknown thread, 403s for a non-participant", async () => {
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob.t@example.com", email: "bob.t@example.com", name: "Bob", roles: [] });
    upsertUser({ id: "carol.t@example.com", email: "carol.t@example.com", name: "Carol", roles: [] });
    const { send } = await import("../lib/messages");
    const { thread } = send({ fromId: "bob.t@example.com", to: "carol.t@example.com", body: "hi" }, "mcp");

    const { POST } = await import("../app/api/inbox/[threadId]/lease/route");
    const missing = await POST(leaseReq("nope", { turns: 3, minutes: 10 }), { params: Promise.resolve({ threadId: "nope" }) });
    expect(missing.status).toBe(404);

    const forbidden = await POST(leaseReq(thread.id, { turns: 3, minutes: 10 }), {
      params: Promise.resolve({ threadId: thread.id }),
    });
    expect(forbidden.status).toBe(403);
  });
});
