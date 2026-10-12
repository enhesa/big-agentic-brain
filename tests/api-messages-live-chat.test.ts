import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-messages-live-chat-test-"));
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

function mockAgentIdentity(email: string, name: string) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": name }),
  }));
}

function postReq(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request("http://x/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/messages: kind and lease wiring", () => {
  it("400s on an invalid kind value", async () => {
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob.t@example.com", email: "bob.t@example.com", name: "Bob", roles: [] });
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "bob.t@example.com", body: "hi", kind: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("400s a kind:auto send (auto is no longer supported)", async () => {
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob.t@example.com", email: "bob.t@example.com", name: "Bob", roles: [] });
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "bob.t@example.com", body: "hi", kind: "auto" }));
    expect(res.status).toBe(400);
  });

  it("X-Bab-Lease: 1 decrements the lease on a plain (kind-less) send", async () => {
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob.t@example.com", email: "bob.t@example.com", name: "Bob", roles: [] });
    upsertUser({ id: "alice.t@example.com", email: "alice.t@example.com", name: "Alice", roles: [] });

    const { send, recordLease, getLeaseForActor } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice.t@example.com", to: "bob.t@example.com", body: "hi" }, "mcp");
    recordLease(thread.id, "alice.t@example.com", 3, 10);

    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ threadId: thread.id, body: "leased human" }, { "X-Bab-Lease": "1" }));
    expect(res.status).toBe(201);
    expect(getLeaseForActor(thread.id, "alice.t@example.com")!.turnsLeft).toBe(2);
  });
});
