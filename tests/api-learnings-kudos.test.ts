import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-learnings-kudos-test-"));
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

function kudosReq(body: unknown = {}) {
  return new Request("http://x/kudos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/learnings/[id]/kudos", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { POST } = await import("../app/api/learnings/[id]/kudos/route");
    const res = await POST(kudosReq() as never, { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
  });

  it("happy path: gives kudos with a note, worth +2 on the score stub", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("fan.t@example.com", "Fan");
    const { POST } = await import("../app/api/learnings/[id]/kudos/route");
    const res = await POST(kudosReq({ note: "Saved me an hour" }) as never, {
      params: Promise.resolve({ id: learning.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.learning.score).toBe(2);
  });

  it("403s on giving kudos to your own learning", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("author.t@example.com", "Author");
    const { POST } = await import("../app/api/learnings/[id]/kudos/route");
    const res = await POST(kudosReq() as never, { params: Promise.resolve({ id: learning.id }) });
    expect(res.status).toBe(403);
  });

  it("is once per identity per learning: a second kudos from the same voter is an explicit 409, not a silent no-op", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("fan.t@example.com", "Fan");
    const { POST } = await import("../app/api/learnings/[id]/kudos/route");
    const first = await POST(kudosReq() as never, { params: Promise.resolve({ id: learning.id }) });
    expect(first.status).toBe(200);

    const second = await POST(kudosReq() as never, { params: Promise.resolve({ id: learning.id }) });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe("Kudos already given");
  });

  it("404s on an unknown learning", async () => {
    mockAgentIdentity("fan.t@example.com", "Fan");
    const { POST } = await import("../app/api/learnings/[id]/kudos/route");
    const res = await POST(kudosReq() as never, { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });
});
