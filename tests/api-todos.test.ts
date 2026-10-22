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

  it("defaults to the open tab when no tab is given", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "owner.t@example.com", email: "owner.t@example.com", name: "Owner", roles: [] });
    const { create } = await import("../lib/todos");
    create({ ownerId: "owner.t@example.com", title: "Open one", dueAt: "2030-01-01" });

    const { GET } = await import("../app/api/todos/route");
    const res = await GET(new Request("http://x/api/todos") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.todos.length).toBe(1);
  });

  it("400s on an unknown tab value and lists the valid ones", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { GET } = await import("../app/api/todos/route");
    const res = await GET(new Request("http://x/api/todos?tab=bogus") as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "tab must be one of overdue, due_soon, open, done" });
  });

  it("still lists the overdue and due_soon tabs for valid dates", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { todayUtc, addDaysUtc } = await import("../lib/dates");
    const { POST, GET } = await import("../app/api/todos/route");
    expect((await POST(postReq({ title: "Late", dueAt: addDaysUtc(todayUtc(), -3) }) as never)).status).toBe(201);
    expect((await POST(postReq({ title: "Soon", dueAt: addDaysUtc(todayUtc(), 2) }) as never)).status).toBe(201);
    const titles = async (tab: string) =>
      ((await (await GET(new Request(`http://x/api/todos?tab=${tab}`) as never)).json()).todos as { title: string }[]).map((t) => t.title);
    expect(await titles("overdue")).toEqual(["Late"]);
    expect(await titles("due_soon")).toEqual(["Soon"]);
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

  it.each(["2026-13-01", "2026-02-30", "2026-02-29", "2026-13-45"])("400s on %s: not a real calendar date", async (dueAt) => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { POST } = await import("../app/api/todos/route");
    const res = await POST(postReq({ title: "T", dueAt }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "dueAt must be YYYY-MM-DD, or an ISO 8601 date-time with an offset or Z, e.g. 2026-10-21T16:00:00-04:00" });
    const { listMine } = await import("../lib/todos");
    expect(listMine("owner.t@example.com", "open")).toHaveLength(0);
  });

  it.each(["2024-02-29", "2026-10-15"])("accepts %s", async (dueAt) => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { POST } = await import("../app/api/todos/route");
    const res = await POST(postReq({ title: "T", dueAt }) as never);
    expect(res.status).toBe(201);
  });

  it("replays the first response for a repeat Idempotency-Key with the same body", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { POST } = await import("../app/api/todos/route");
    const req1 = postReq({ title: "T", dueAt: "2030-01-01" });
    req1.headers.set("Idempotency-Key", "k1");
    const first = await POST(req1 as never);
    const firstBody = await first.json();

    const req2 = postReq({ title: "T", dueAt: "2030-01-01" });
    req2.headers.set("Idempotency-Key", "k1");
    const second = await POST(req2 as never);
    const secondBody = await second.json();

    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(secondBody).toEqual(firstBody);

    const { listMine } = await import("../lib/todos");
    expect(listMine("owner.t@example.com", "open").length).toBe(1);
  });

  it("422s when the Idempotency-Key was used with a different body, and creates nothing", async () => {
    mockAgentIdentity("owner.t@example.com", "Owner");
    const { POST } = await import("../app/api/todos/route");
    const req1 = postReq({ title: "T", dueAt: "2030-01-01" });
    req1.headers.set("Idempotency-Key", "k1");
    expect((await POST(req1 as never)).status).toBe(201);

    const req2 = postReq({ title: "Different", dueAt: "2030-02-02" });
    req2.headers.set("Idempotency-Key", "k1");
    const second = await POST(req2 as never);
    expect(second.status).toBe(422);
    expect(await second.json()).toEqual({ error: "Idempotency-Key was already used with a different request" });
    expect(second.headers.get("Idempotent-Replayed")).toBeNull();

    const { listMine } = await import("../lib/todos");
    expect(listMine("owner.t@example.com", "open").length).toBe(1);
  });
});
