import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-learnings-vote-test-"));
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

function voteReq(body: unknown) {
  return new Request("http://x/vote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/learnings/[id]/vote", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { POST } = await import("../app/api/learnings/[id]/vote/route");
    const res = await POST(voteReq({ kind: "helpful" }) as never, { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
  });

  it("happy path: records a helpful vote", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("voter.t@example.com", "Voter");
    const { POST } = await import("../app/api/learnings/[id]/vote/route");
    const res = await POST(voteReq({ kind: "helpful" }) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.learning.score).toBe(1);
  });

  it("400s on an invalid kind", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("voter.t@example.com", "Voter");
    const { POST } = await import("../app/api/learnings/[id]/vote/route");
    const res = await POST(voteReq({ kind: "love-it" }) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(res.status).toBe(400);
  });

  it("403s on voting for your own learning", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("author.t@example.com", "Author");
    const { POST } = await import("../app/api/learnings/[id]/vote/route");
    const res = await POST(voteReq({ kind: "helpful" }) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(res.status).toBe(403);
  });

  it("404s on an unknown learning", async () => {
    mockAgentIdentity("voter.t@example.com", "Voter");
    const { POST } = await import("../app/api/learnings/[id]/vote/route");
    const res = await POST(voteReq({ kind: "helpful" }) as never, { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("replays the same response for a repeat Idempotency-Key", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("voter.t@example.com", "Voter");
    const { POST } = await import("../app/api/learnings/[id]/vote/route");

    const req1 = new Request("http://x/vote", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "k1" },
      body: JSON.stringify({ kind: "helpful" }),
    });
    const first = await POST(req1 as never, { params: Promise.resolve({ id: learning.id }) });
    const firstBody = await first.json();

    const req2 = new Request("http://x/vote", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "k1" },
      body: JSON.stringify({ kind: "not_helpful" }),
    });
    const second = await POST(req2 as never, { params: Promise.resolve({ id: learning.id }) });
    const secondBody = await second.json();

    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(secondBody).toEqual(firstBody);
  });
});
