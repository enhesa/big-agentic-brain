import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-feedback-test-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.BAB_MAINTAINERS;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

// One mock for the whole test, reading a mutable identity: modules that already imported
// next/headers keep their binding, so a second doMock would not reach them.
let current: Record<string, string> = {};
function as(email: string | null, name = "Some One") {
  current = email ? { "x-bab-actor-email": email, "x-bab-actor-name": name } : {};
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
}

const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const MAINT = "maria.m@example.com";

const newItem = {
  kind: "bug",
  area: "hooks",
  title: "Stop hook nudges twice in one turn",
  body: "After a merge the Stop hook asks for a learning and then asks again on the next turn.",
};

function req(url: string, method: string, body?: unknown) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function post(body: unknown = newItem) {
  const { POST } = await import("../app/api/feedback/route");
  return POST(req("/api/feedback", "POST", body) as never);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("GET/POST /api/feedback", () => {
  it("401s without identity", async () => {
    as(null);
    const { GET, POST } = await import("../app/api/feedback/route");
    expect((await GET(req("/api/feedback", "GET") as never)).status).toBe(401);
    expect((await POST(req("/api/feedback", "POST", newItem) as never)).status).toBe(401);
  });

  it("creates an agent-sourced item and lists it", async () => {
    as(ALICE);
    const res = await post();
    expect(res.status).toBe(201);
    const { feedback } = await res.json();
    expect(feedback).toMatchObject({ status: "open", source: "agent", votes: 0, kind: "bug", area: "hooks" });

    const { GET } = await import("../app/api/feedback/route");
    const json = await (await GET(req("/api/feedback?kind=bug&limit=5", "GET") as never)).json();
    expect(json.total).toBe(1);
    expect(json.nextOffset).toBeNull();
    expect(json.items[0].id).toBe(feedback.id);
  });

  it("400s on a bad body or enum, and 409s with candidates on a duplicate", async () => {
    as(ALICE);
    expect((await post("nope")).status).toBe(400);
    expect((await post({ ...newItem, kind: "rant" })).status).toBe(400);
    expect((await post({ ...newItem, title: "" })).status).toBe(400);
    expect((await post()).status).toBe(201);
    as(BOB);
    const dup = await post();
    expect(dup.status).toBe(409);
    expect((await dup.json()).candidates).toHaveLength(1);
    expect((await post({ ...newItem, confirmNotDuplicate: true })).status).toBe(201);
  });

  it("429s past the daily cap", async () => {
    as(ALICE);
    const { FEEDBACK_DAILY_LIMIT } = await import("../lib/feedback");
    const { getDb } = await import("../lib/db");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: ALICE, email: ALICE, name: null, roles: [] });
    const ins = getDb().prepare(
      "INSERT INTO feedback (id, author_id, source, kind, area, title, body) VALUES (?, ?, 'agent', 'bug', 'hooks', ?, ?)",
    );
    for (let i = 0; i < FEEDBACK_DAILY_LIMIT; i++) ins.run(`f-${i}`, ALICE, `filler ${i}`, `filler body ${i}`);
    const res = await post({ ...newItem, title: "sixth unrelated thing about uploads", body: "uploads misbehave when huge" });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/Daily feedback limit/);
  });

  it("400s on an unknown filter value", async () => {
    as(ALICE);
    const { GET } = await import("../app/api/feedback/route");
    expect((await GET(req("/api/feedback?status=weird", "GET") as never)).status).toBe(400);
  });
});

describe("/api/feedback/:id", () => {
  async function seeded() {
    as(ALICE);
    return (await (await post()).json()).feedback.id as string;
  }

  it("GET returns the item and its comments, 404 when unknown", async () => {
    const id = await seeded();
    as(BOB);
    const { GET } = await import("../app/api/feedback/[id]/route");
    const json = await (await GET(req(`/api/feedback/${id}`, "GET") as never, ctx(id))).json();
    expect(json.feedback.id).toBe(id);
    expect(json.comments).toEqual([]);
    expect((await GET(req("/api/feedback/nope", "GET") as never, ctx("nope"))).status).toBe(404);
  });

  it("vote is idempotent", async () => {
    const id = await seeded();
    as(BOB);
    const { POST } = await import("../app/api/feedback/[id]/vote/route");
    const first = await (await POST(req(`/api/feedback/${id}/vote`, "POST", {}) as never, ctx(id))).json();
    expect(first).toMatchObject({ changed: true, feedback: { votes: 1 } });
    const again = await (await POST(req(`/api/feedback/${id}/vote`, "POST", {}) as never, ctx(id))).json();
    expect(again).toMatchObject({ changed: false, feedback: { votes: 1 } });
  });

  it("comments are stored; an empty one is a 400", async () => {
    const id = await seeded();
    as(BOB);
    const { POST } = await import("../app/api/feedback/[id]/comments/route");
    const ok = await POST(req(`/api/feedback/${id}/comments`, "POST", { body: "Seen here too" }) as never, ctx(id));
    expect(ok.status).toBe(201);
    expect((await ok.json()).comment.body).toBe("Seen here too");
    expect((await POST(req(`/api/feedback/${id}/comments`, "POST", { body: " " }) as never, ctx(id))).status).toBe(400);
  });

  it("status is 403 without BAB_MAINTAINERS, 403 for non-maintainers, 200 for a maintainer", async () => {
    const id = await seeded();
    const { POST } = await import("../app/api/feedback/[id]/status/route");
    as(MAINT);
    const unset = await POST(req(`/api/feedback/${id}/status`, "POST", { status: "planned" }) as never, ctx(id));
    expect(unset.status).toBe(403);
    expect((await unset.json()).error).toBe("BAB_MAINTAINERS is not configured");

    process.env.BAB_MAINTAINERS = MAINT;
    as(BOB);
    expect((await POST(req(`/api/feedback/${id}/status`, "POST", { status: "planned" }) as never, ctx(id))).status).toBe(403);

    as(MAINT);
    const ok = await POST(req(`/api/feedback/${id}/status`, "POST", { status: "planned", note: "Soon" }) as never, ctx(id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).feedback.status).toBe("planned");
    expect((await POST(req(`/api/feedback/${id}/status`, "POST", { status: "bogus" }) as never, ctx(id))).status).toBe(400);
  });
});

describe("GET /api", () => {
  it("documents every feedback endpoint", async () => {
    const { GET } = await import("../app/api/route");
    const { endpoints } = await (await GET()).json();
    for (const key of [
      "GET /api/feedback",
      "POST /api/feedback",
      "GET /api/feedback/:id",
      "POST /api/feedback/:id/vote",
      "POST /api/feedback/:id/comments",
      "POST /api/feedback/:id/status",
    ]) {
      expect(endpoints[key], key).toBeTruthy();
    }
  });
});
