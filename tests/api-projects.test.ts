import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-projects-test-"));
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

function postReq(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/learnings with project", () => {
  it("normalizes and stores project", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(
      postReq("http://x/api/learnings", { title: "Campaign kickoff", body: "Notes.", project: "Q4 ESG Campaign" }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.learning.project).toBe("q4-esg-campaign");
  });

  it("auto-fills project from repo when project is omitted", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(
      postReq("http://x/api/learnings", {
        title: "Runbook note",
        body: "Deploy steps.",
        repo: "https://git.forge.example.com/forge/bab.git",
      }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.learning.project).toBe("bab");
  });

  it("400s on a project value that normalizes to nothing", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq("http://x/api/learnings", { title: "T", body: "B", project: "!!!" }) as never);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/learnings?project=", () => {
  async function seed() {
    const { POST } = await import("../app/api/learnings/route");
    await POST(
      postReq("http://x/api/learnings", {
        title: "Bab deploy notes",
        body: "runTest.sh wires up CI for this repo.",
        tags: ["engineering", "ci"],
        project: "bab",
      }) as never,
    );
    await POST(
      postReq("http://x/api/learnings", {
        title: "Forge deploy notes",
        body: "runTest.sh wires up CI for this other repo.",
        tags: ["engineering", "ci"],
        project: "forge2",
        confirmNotDuplicate: true,
      }) as never,
    );
  }

  it("filters to an exact match on the normalized project key", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    await seed();
    const { GET } = await import("../app/api/learnings/route");
    const res = await GET(new Request("http://x/api/learnings?project=bab") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { project: string }) => r.project)).toEqual(["bab"]);
  });

  it("normalizes the query param the same way as write (case/whitespace-insensitive)", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    await seed();
    const { GET } = await import("../app/api/learnings/route");
    const res = await GET(new Request("http://x/api/learnings?project=%20BAB%20") as never);
    const body = await res.json();
    expect(body.results.length).toBe(1);
    expect(body.results[0].project).toBe("bab");
  });

  it("combines project with tag and q", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    await seed();
    const { GET } = await import("../app/api/learnings/route");
    const res = await GET(new Request("http://x/api/learnings?q=runTest&tag=ci&project=forge2") as never);
    const body = await res.json();
    expect(body.results.length).toBe(1);
    expect(body.results[0].title).toBe("Forge deploy notes");
  });

  it("project=_general filters to no-project memories", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    await seed();
    const { POST, GET } = await import("../app/api/learnings/route");
    await POST(
      postReq("http://x/api/learnings", { title: "Company-wide note", body: "No scope here.", confirmNotDuplicate: true }) as never,
    );

    const res = await GET(new Request("http://x/api/learnings?project=_general") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { title: string }) => r.title)).toEqual(["Company-wide note"]);
  });

  it("returns an empty page (not a 400) for a project param that normalizes to nothing", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    await seed();
    const { GET } = await import("../app/api/learnings/route");
    const res = await GET(new Request("http://x/api/learnings?project=%21%21%21") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
  });
});

describe("GET /api/projects", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/projects/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("lists known projects with counts, newest activity first", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    await POST(
      postReq("http://x/api/learnings", { title: "Bab note one", body: "First note about bab.", project: "bab" }) as never,
    );
    await POST(
      postReq("http://x/api/learnings", {
        title: "Bab note two",
        body: "Second note about bab.",
        project: "bab",
        confirmNotDuplicate: true,
      }) as never,
    );

    const { GET } = await import("../app/api/projects/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projects).toEqual([{ project: "bab", count: 2, lastActivityAt: expect.any(String) }]);
  });

  it("writes an audit row", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { GET } = await import("../app/api/projects/route");
    await GET();

    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1").get() as {
      path: string;
      via: string;
    };
    expect(row.path).toBe("/api/projects");
    expect(row.via).toBe("mcp");
  });
});
