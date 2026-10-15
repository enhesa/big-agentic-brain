import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-learnings-id-test-"));
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

async function seedLearning() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author.t@example.com", email: "author.t@example.com", name: "Author", roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId: "author.t@example.com", title: "T", body: "B" });
}

describe("GET /api/learnings/[id]", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request("http://x/api/learnings/abc") as never, {
      params: Promise.resolve({ id: "abc" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with the learning and vote counts", async () => {
    const learning = await seedLearning();
    mockAgentIdentity("caller.t@example.com", "Caller");
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request(`http://x/api/learnings/${learning.id}`) as never, {
      params: Promise.resolve({ id: learning.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.learning.id).toBe(learning.id);
    expect(body.votes).toEqual({ helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 0 });
    expect(body.learning).toMatchObject({ standing: "weak", standingReason: "no reactions yet" });
  });

  it("returns 404 for an unknown id", async () => {
    mockAgentIdentity("caller.t@example.com", "Caller");
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request("http://x/api/learnings/nope") as never, {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("includes supersededBy { id, title } when a newer learning supersedes it, and omits it otherwise", async () => {
    const oldLearning = await seedLearning();
    mockAgentIdentity("author.t@example.com", "Author");
    const { create, supersede } = await import("../lib/learnings");
    const newLearning = create({
      authorId: "author.t@example.com",
      title: "Corrected version",
      body: "The fixed body.",
      supersedesId: oldLearning.id,
    });
    supersede(newLearning.id, oldLearning.id, "author.t@example.com");

    const { GET } = await import("../app/api/learnings/[id]/route");

    const oldRes = await GET(new Request(`http://x/api/learnings/${oldLearning.id}`) as never, {
      params: Promise.resolve({ id: oldLearning.id }),
    });
    const oldBody = await oldRes.json();
    expect(oldBody.supersededBy).toEqual({ id: newLearning.id, title: "Corrected version" });

    const newRes = await GET(new Request(`http://x/api/learnings/${newLearning.id}`) as never, {
      params: Promise.resolve({ id: newLearning.id }),
    });
    const newBody = await newRes.json();
    expect(newBody.supersededBy).toBeUndefined();
  });

  it("returns an archived learning by id, with status visible", async () => {
    const learning = await seedLearning();
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET status = 'archived' WHERE id = ?").run(learning.id);
    mockAgentIdentity("caller.t@example.com", "Caller");
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request(`http://x/api/learnings/${learning.id}`) as never, {
      params: Promise.resolve({ id: learning.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.learning.status).toBe("archived");
  });
});

describe("GET /api/learnings/[id] recentNotes", () => {
  const SENTINEL = "NOTE-SENTINEL-4471";

  async function seedWithNotes() {
    const learning = await seedLearning();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "checker.t@example.com", email: "checker.t@example.com", name: "Checker", roles: [] });
    const { confirm } = await import("../lib/learnings");
    confirm(learning.id, "checker.t@example.com", `${SENTINEL} <b>src/x.ts</b> 2026-10-01`);
    return learning;
  }

  it("includes recentNotes; a note with markup stays a string", async () => {
    const learning = await seedWithNotes();
    mockAgentIdentity("caller.t@example.com", "Caller");
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request(`http://x/api/learnings/${learning.id}`) as never, { params: Promise.resolve({ id: learning.id }) });
    const body = await res.json();
    expect(body.recentNotes).toEqual([
      { kind: "confirm", voterName: expect.stringContaining("Checker"), note: `${SENTINEL} <b>src/x.ts</b> 2026-10-01`, at: expect.any(String) },
    ]);
  });

  it("recentNotes is an empty list when nobody confirmed or flagged", async () => {
    const learning = await seedLearning();
    mockAgentIdentity("caller.t@example.com", "Caller");
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request(`http://x/api/learnings/${learning.id}`) as never, { params: Promise.resolve({ id: learning.id }) });
    expect((await res.json()).recentNotes).toEqual([]);
  });

  it("note text never appears outside recentNotes: not in the list JSON, not in search", async () => {
    const learning = await seedWithNotes();
    mockAgentIdentity("caller.t@example.com", "Caller");
    const { GET: LIST } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    const listJson = await (await LIST(new NextRequest("http://x/api/learnings?status=all"))).text();
    expect(listJson).toContain(learning.id);
    expect(listJson).not.toContain(SENTINEL);

    const { search } = await import("../lib/learnings");
    expect(JSON.stringify(search("", { status: "all" }))).not.toContain(SENTINEL);
    expect(search(SENTINEL)).toEqual([]);

    const { GET } = await import("../app/api/learnings/[id]/route");
    const detail = await GET(new Request(`http://x/api/learnings/${learning.id}`) as never, { params: Promise.resolve({ id: learning.id }) });
    const body = await detail.json();
    const { recentNotes: notes, ...rest } = body;
    expect(JSON.stringify(notes)).toContain(SENTINEL);
    expect(JSON.stringify(rest)).not.toContain(SENTINEL);
  });
});
