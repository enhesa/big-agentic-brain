import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-learnings-flag-test-"));
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

function flagReq(body?: unknown) {
  return new Request("http://x/flag", {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

describe("POST /api/learnings/[id]/flag", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { POST } = await import("../app/api/learnings/[id]/flag/route");
    const res = await POST(flagReq() as never, { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
  });

  it("happy path: flags a learning", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("flagger.t@example.com", "Flagger");
    const { POST } = await import("../app/api/learnings/[id]/flag/route");
    const res = await POST(flagReq({ note: "moved to src/x.ts, 2026-10-02" }) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(res.status).toBe(200);
  });

  it("stores the note; a call with no body is a 400 (the note is required for agents)", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("flagger.t@example.com", "Flagger");
    const { POST } = await import("../app/api/learnings/[id]/flag/route");
    const noBody = await POST(flagReq() as never, { params: Promise.resolve({ id: learning.id }) });
    expect(noBody.status).toBe(400);
    const withNote = await POST(flagReq({ note: "moved to src/x.ts, 2026-10-01" }) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(withNote.status).toBe(200);
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT note FROM votes WHERE learning_id = ? AND kind = 'flag'").get(learning.id) as { note: string };
    expect(row.note).toBe("moved to src/x.ts, 2026-10-01");
  });

  it("400s on a note over 300 characters", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("flagger.t@example.com", "Flagger");
    const { POST } = await import("../app/api/learnings/[id]/flag/route");
    const res = await POST(flagReq({ note: "a".repeat(301) }) as never, { params: Promise.resolve({ id: learning.id }) });
    expect(res.status).toBe(400);
  });

  it("two identities flagging a standard leave it active, a learning archives", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "author.t@example.com", email: "author.t@example.com", name: "Author", roles: [] });
    const { create } = await import("../lib/learnings");
    const standard = create({ authorId: "author.t@example.com", title: "Rule S", body: "A rule body", kind: "standard" });
    const plain = create({ authorId: "author.t@example.com", title: "Gotcha P", body: "A gotcha zebra", confirmNotDuplicate: true });
    // One mock reading a variable: re-mocking after the route is imported would not reach it.
    let current = "";
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": current, "x-bab-actor-name": "Flagger" }),
    }));
    const { POST } = await import("../app/api/learnings/[id]/flag/route");
    for (const who of ["a.t@example.com", "b.t@example.com"]) {
      current = who;
      for (const l of [standard, plain]) {
        const res = await POST(flagReq({ note: "checked src/x.ts, 2026-10-02" }) as never, { params: Promise.resolve({ id: l.id }) });
        expect(res.status).toBe(200);
      }
    }
    const { getById } = await import("../lib/learnings");
    expect(getById(standard.id)!.status).toBe("active");
    expect(getById(plain.id)!.status).toBe("archived");
  });

  it("403s on flagging your own learning", async () => {
    const learning = await seedLearning("author.t@example.com");
    mockAgentIdentity("author.t@example.com", "Author");
    const { POST } = await import("../app/api/learnings/[id]/flag/route");
    const res = await POST(flagReq() as never, { params: Promise.resolve({ id: learning.id }) });
    expect(res.status).toBe(403);
  });

  it("404s on an unknown learning", async () => {
    mockAgentIdentity("flagger.t@example.com", "Flagger");
    const { POST } = await import("../app/api/learnings/[id]/flag/route");
    const res = await POST(flagReq() as never, { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });
});
