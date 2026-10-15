import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-todos-test-"));
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

describe("GET /api/todos", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/todos/route");
    const res = await GET(new Request("http://x/api/todos") as never);
    expect(res.status).toBe(401);
  });

  it("defaults to the open tab and falls back for an unknown tab value", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "owner.t@example.com", email: "owner.t@example.com", name: "Owner", roles: [] });
    const { create } = await import("../lib/todos");
    create({ ownerId: "owner.t@example.com", title: "Open one", dueAt: "2030-01-01" });

    const { GET } = await import("../app/api/todos/route");
    const res = await GET(new Request("http://x/api/todos?tab=bogus") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.todos.length).toBe(1);
  });
});

function postReq(body: unknown) {
  return new Request("http://x/api/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/todos", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { POST } = await import("../app/api/todos/route");
    const res = await POST(postReq({ title: "T", dueAt: "2030-01-01" }) as never);
    expect(res.status).toBe(401);
  });

  it("happy path: creates a reminder and returns 201", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { POST } = await import("../app/api/todos/route");
    const res = await POST(postReq({ title: "Re-enable alert filter", dueAt: "2030-01-01" }) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.todo.title).toBe("Re-enable alert filter");
    expect(body.todo.owner_id).toBe("owner.t@example.com");
  });

  it("400s when title is missing", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { POST } = await import("../app/api/todos/route");
    const res = await POST(postReq({ dueAt: "2030-01-01" }) as never);
    expect(res.status).toBe(400);
  });

  it("400s when dueAt is missing or malformed", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { POST } = await import("../app/api/todos/route");
    const res = await POST(postReq({ title: "T", dueAt: "tomorrow" }) as never);
    expect(res.status).toBe(400);
  });

  it("replays the same body for a repeat Idempotency-Key", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { POST } = await import("../app/api/todos/route");
    const req1 = postReq({ title: "T", dueAt: "2030-01-01" });
    req1.headers.set("Idempotency-Key", "k1");
    const first = await POST(req1 as never);
    const firstBody = await first.json();

    const req2 = postReq({ title: "Different", dueAt: "2030-02-02" });
    req2.headers.set("Idempotency-Key", "k1");
    const second = await POST(req2 as never);
    const secondBody = await second.json();

    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(secondBody).toEqual(firstBody);

    const { listMine } = await import("../lib/todos");
    expect(listMine("owner.t@example.com", "open").length).toBe(1);
  });
});
