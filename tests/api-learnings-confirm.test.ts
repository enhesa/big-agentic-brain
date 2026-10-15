import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-learnings-confirm-test-"));
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

async function seedLearning(authorId: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: authorId, email: authorId, name: "Author", roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId, title: "T", body: "B" });
}

function confirmReq(body: unknown = {}) {
  return new Request("http://x/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/learnings/[id]/confirm", () => {
  const ROUTE = "../app/api/learnings/[id]/confirm/route";

  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { POST } = await import(ROUTE);
    const res = await POST(confirmReq({ note: "src/x.ts, 2026-10-01" }) as never, { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
  });

  it.each([{}, { note: "" }, { note: "   " }])("400s when the note is missing or blank: %j", async (payload) => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("checker.t@example.com", "Checker");
    const { POST } = await import(ROUTE);
    const res = await POST(confirmReq(payload) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/note/);
  });

  it("403s when the author confirms their own learning", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("author.t@example.com", "Author");
    const { POST } = await import(ROUTE);
    const res = await POST(confirmReq({ note: "src/x.ts, 2026-10-01" }) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(res.status).toBe(403);
  });

  it("404s on an unknown learning", async () => {
    mockAgentIdentity("checker.t@example.com", "Checker");
    const { POST } = await import(ROUTE);
    const res = await POST(confirmReq({ note: "src/x.ts, 2026-10-01" }) as never, { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("200 with changed true and score 2, then changed false on a repeat inside 30 days", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("checker.t@example.com", "Checker");
    const { POST } = await import(ROUTE);
    const first = await POST(confirmReq({ note: "src/x.ts, 2026-10-01" }) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.changed).toBe(true);
    expect(firstBody.learning.score).toBe(2);

    const again = await POST(confirmReq({ note: "src/y.ts, 2026-10-02" }) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(again.status).toBe(200);
    const againBody = await again.json();
    expect(againBody.changed).toBe(false);
    expect(againBody.learning.score).toBe(2);
  });
});
