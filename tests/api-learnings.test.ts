import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-learnings-test-"));
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
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers(),
    cookies: async () => ({ get: () => undefined }),
  }));
}

function mockAgentIdentity(email: string, name: string) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": name }),
    cookies: async () => ({ get: () => undefined }),
  }));
}

async function seedLearning(authorId: string, title: string, body: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: authorId, email: authorId, name: "Author", roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId, title, body });
}

describe("GET /api/learnings", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://x/api/learnings"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with agent headers and finds seeded learnings", async () => {
    await seedLearning("author.t@example.com", "Use runTest.sh", "CI wiring details.");
    mockAgentIdentity("caller.t@example.com", "Caller T");
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");

    const res = await GET(new NextRequest("http://x/api/learnings?q=runTest"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBe(1);
  });

  it("carries ageDays and expiresInDays on every result", async () => {
    const learning = await seedLearning("author.t@example.com", "Use runTest.sh", "CI wiring details.");
    const { getDb } = await import("../lib/db");
    getDb()
      .prepare("UPDATE learnings SET created_at = datetime('now', '-95 days'), expires_at = date('now', '+30 days') WHERE id = ?")
      .run(learning.id);

    mockAgentIdentity("caller.t@example.com", "Caller T");
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");

    const res = await GET(new NextRequest("http://x/api/learnings?q=runTest"));
    const body = await res.json();
    expect(body.results[0].ageDays).toBe(95);
    expect(body.results[0].expiresInDays).toBe(30);
  });

  it("expiresInDays is negative once past expiry, null when there is no expiry", async () => {
    const learning = await seedLearning("author.t@example.com", "Expired note", "Old advice.");
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET expires_at = date('now', '-3 days') WHERE id = ?").run(learning.id);

    mockAgentIdentity("caller.t@example.com", "Caller T");
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");

    const res = await GET(new NextRequest("http://x/api/learnings?q=Expired"));
    const body = await res.json();
    expect(body.results[0].expiresInDays).toBe(-3);

    getDb().prepare("UPDATE learnings SET expires_at = NULL WHERE id = ?").run(learning.id);
    const res2 = await GET(new NextRequest("http://x/api/learnings?q=Expired"));
    const body2 = await res2.json();
    expect(body2.results[0].expiresInDays).toBeNull();
  });

  it("clamps a plain list's limit to a max of 50 and reports the effective limit", async () => {
    mockAgentIdentity("caller.t@example.com", "Caller T");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "author.t@example.com", email: "author.t@example.com", name: "Author", roles: [] });
    const { create } = await import("../lib/learnings");
    for (let i = 0; i < 55; i++) {
      create({
        authorId: "author.t@example.com",
        title: `Learning ${i}`,
        body: "Body text about deployments.",
        confirmNotDuplicate: true,
      });
    }

    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://x/api/learnings?limit=1000"));
    const body = await res.json();
    expect(body.limit).toBe(50);
    expect(body.results.length).toBeLessThanOrEqual(50);
  });

  it("clamps a search's (q set) limit to a max of 20", async () => {
    mockAgentIdentity("caller.t@example.com", "Caller T");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "author.t@example.com", email: "author.t@example.com", name: "Author", roles: [] });
    const { create } = await import("../lib/learnings");
    for (let i = 0; i < 25; i++) {
      create({
        authorId: "author.t@example.com",
        title: `Learning about deployments ${i}`,
        body: "Body text about deployments.",
        confirmNotDuplicate: true,
      });
    }

    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://x/api/learnings?q=deployments&limit=1000"));
    const body = await res.json();
    expect(body.limit).toBe(20);
    expect(body.results.length).toBeLessThanOrEqual(20);
  });

  it("escapes HTML in the snippet output", async () => {
    await seedLearning(
      "author.t@example.com",
      "XSS test",
      "before <img src=x onerror=alert(1)> after runTest.sh",
    );
    mockAgentIdentity("caller.t@example.com", "Caller T");
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");

    const res = await GET(new NextRequest("http://x/api/learnings?q=runTest"));
    const body = await res.json();
    expect(body.results[0].snippet).not.toContain("<img");
    expect(body.results[0].snippet).toContain("&lt;img");
  });

  it("writes an audit row with actor name/email/path/via", async () => {
    mockAgentIdentity("caller.t@example.com", "Caller T");
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    await GET(new NextRequest("http://x/api/learnings"));

    const { getDb } = await import("../lib/db");
    const row = getDb()
      .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { actor_name: string; actor_email: string; path: string; via: string };
    expect(row.actor_name).toBe("Caller T");
    expect(row.actor_email).toBe("caller.t@example.com");
    expect(row.path).toBe("/api/learnings");
    expect(row.via).toBe("mcp");
  });
});

describe("GET /api/learnings flagged filter", () => {
  it("?flagged=true lists the flagged standards and decisions that wait for a maintainer; a bad value is 400", async () => {
    process.env.BAB_MAINTAINERS = "maint.f@example.com";
    try {
      const { upsertUser } = await import("../lib/users");
      for (const id of ["author.f@example.com", "flagger.f@example.com", "maint.f@example.com"]) {
        upsertUser({ id, email: id, name: id, roles: [] });
      }
      const { create, flag } = await import("../lib/learnings");
      const waiting = create({ authorId: "author.f@example.com", title: "Flagged rule", body: "flagged kiosk rule", kind: "standard", confirmNotDuplicate: true });
      create({ authorId: "author.f@example.com", title: "Plain rule", body: "plain kiosk rule", kind: "standard", confirmNotDuplicate: true });
      flag(waiting.id, "flagger.f@example.com", "mcp", "Moved to src/lib/x.ts, 2026-10-02");

      mockAgentIdentity("caller.f@example.com", "Caller F");
      const { GET } = await import("../app/api/learnings/route");
      const { NextRequest } = await import("next/server");

      const res = await GET(new NextRequest("http://x/api/learnings?flagged=true"));
      expect(res.status).toBe(200);
      expect(((await res.json()).results as Array<{ id: string }>).map((r) => r.id)).toEqual([waiting.id]);

      const text = await GET(new NextRequest("http://x/api/learnings?q=kiosk&flagged=1"));
      expect(((await text.json()).results as Array<{ id: string }>).map((r) => r.id)).toEqual([waiting.id]);

      const off = await GET(new NextRequest("http://x/api/learnings?flagged=false"));
      expect((await off.json()).results).toHaveLength(2);

      const bad = await GET(new NextRequest("http://x/api/learnings?flagged=maybe"));
      expect(bad.status).toBe(400);
    } finally {
      delete process.env.BAB_MAINTAINERS;
    }
  });
});

describe("GET /api/learnings kind filter", () => {
  async function seedKinds() {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "author.k@example.com", email: "author.k@example.com", name: "Author", roles: [] });
    const { create } = await import("../lib/learnings");
    const mk = (kind: "learning" | "standard" | "decision", title: string, body: string) =>
      create({ authorId: "author.k@example.com", title, body, kind, confirmNotDuplicate: true });
    mk("learning", "Red gotcha", "red kiosk gotcha");
    mk("standard", "Blue rule", "blue kiosk rule");
    mk("decision", "Green choice", "green kiosk choice");
  }

  it("?kind=standard,decision filters, ?kind=bogus is 400, no kind is all kinds", async () => {
    await seedKinds();
    mockAgentIdentity("caller.k@example.com", "Caller K");
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");

    const some = await GET(new NextRequest("http://x/api/learnings?kind=standard,decision"));
    expect(some.status).toBe(200);
    const kinds = ((await some.json()).results as Array<{ kind: string }>).map((r) => r.kind).sort();
    expect(kinds).toEqual(["decision", "standard"]);

    const one = await GET(new NextRequest("http://x/api/learnings?q=kiosk&kind=standard"));
    expect(((await one.json()).results as Array<{ kind: string }>).map((r) => r.kind)).toEqual(["standard"]);

    const bad = await GET(new NextRequest("http://x/api/learnings?kind=bogus"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/kind/);

    const all = await GET(new NextRequest("http://x/api/learnings"));
    expect((await all.json()).results).toHaveLength(3);
  });

  it("results carry kind, source, source_url, source_version, standing and standingReason", async () => {
    await seedKinds();
    mockAgentIdentity("caller.k@example.com", "Caller K");
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://x/api/learnings?kind=standard"));
    const [hit] = (await res.json()).results;
    expect(hit).toMatchObject({
      kind: "standard",
      source: "native",
      source_url: null,
      source_version: null,
      standing: "weak",
      standingReason: "no reactions yet",
    });
  });

  it("a repeated ?kind= is read as a list, and a bad kind is a 400 even when project would end the request early", async () => {
    await seedKinds();
    mockAgentIdentity("caller.k@example.com", "Caller K");
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");

    const two = await GET(new NextRequest("http://x/api/learnings?kind=standard&kind=decision"));
    expect(two.status).toBe(200);
    expect(((await two.json()).results as Array<{ kind: string }>).map((r) => r.kind).sort()).toEqual(["decision", "standard"]);

    const badSecond = await GET(new NextRequest("http://x/api/learnings?kind=standard&kind=bogus"));
    expect(badSecond.status).toBe(400);

    // A project that normalizes to nothing returns an empty page; a bad kind must still win.
    const early = await GET(new NextRequest("http://x/api/learnings?project=!!!&kind=bogus"));
    expect(early.status).toBe(400);
  });
});
