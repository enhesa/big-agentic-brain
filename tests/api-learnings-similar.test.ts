import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-learnings-similar-test-"));
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

function getReq(qs: string) {
  return new Request(`http://x/api/learnings/similar${qs}`);
}

describe("GET /api/learnings/similar", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/learnings/similar/route");
    const res = await GET(getReq("?title=T&body=B") as never);
    expect(res.status).toBe(401);
  });

  it("returns candidates shaped with score/verdict, never throwing on a match", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { create } = await import("../lib/learnings");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "ada.t@example.com", email: "ada.t@example.com", name: "Ada", roles: [] });

    create({
      authorId: "ada.t@example.com",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage for CI runs.",
      tags: ["engineering", "ci"],
    });

    const { GET } = await import("../app/api/learnings/similar/route");
    const res = await GET(
      getReq(
        "?title=" +
          encodeURIComponent("Always use runTest.sh not dotnet test") +
          "&body=" +
          encodeURIComponent("runTest.sh wires up loggers and coverage for CI runs.") +
          "&tags=engineering,ci",
      ) as never,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.length).toBeGreaterThan(0);
    const candidate = body.candidates[0];
    expect(candidate).toHaveProperty("id");
    expect(candidate).toHaveProperty("score");
    expect(["duplicate", "similar"]).toContain(candidate.verdict);
  });

  it("returns an empty list rather than 409 when nothing matches", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { GET } = await import("../app/api/learnings/similar/route");
    const res = await GET(getReq("?title=Totally%20unique%20idea&body=Nothing%20like%20it%20exists") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toEqual([]);
  });
});
