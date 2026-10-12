import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-learnings-duplicates-test-"));
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

describe("GET /api/learnings/duplicates", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/learnings/duplicates/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns empty pairs when there are no near-duplicates", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "ada.t@example.com", email: "ada.t@example.com", name: "Ada", roles: [] });
    const { create } = await import("../lib/learnings");
    create({
      authorId: "ada.t@example.com",
      title: "Coffee machine on floor 3 is broken",
      body: "Use floor 2 instead until facilities fixes it.",
      tags: ["facilities"],
    });
    create({
      authorId: "ada.t@example.com",
      title: "Kubernetes context defaults to dev",
      body: "Always check kubectl config before running anything.",
      tags: ["engineering", "kubernetes"],
      confirmNotDuplicate: true,
    });

    const { GET } = await import("../app/api/learnings/duplicates/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pairs).toEqual([]);
  });

  it("finds a pair of active learnings that look like duplicates of each other", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "ada.t@example.com", email: "ada.t@example.com", name: "Ada", roles: [] });
    const { create } = await import("../lib/learnings");

    const a = create({
      authorId: "ada.t@example.com",
      title: "Use runTest.sh not dotnet test directly",
      body: "runTest.sh wires up loggers and coverage and starts dependency containers for integration tests.",
      tags: ["ci", "testing"],
    });
    const b = create({
      authorId: "ada.t@example.com",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage and starts dependency containers for integration tests.",
      tags: ["ci", "testing"],
      confirmNotDuplicate: true,
    });

    const { GET } = await import("../app/api/learnings/duplicates/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pairs.length).toBe(1);
    const pair = body.pairs[0];
    expect([pair.a.id, pair.b.id].sort()).toEqual([a.id, b.id].sort());
    expect(pair.score).toBeGreaterThan(0);
  });

  it("excludes archived learnings from the scan", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "ada.t@example.com", email: "ada.t@example.com", name: "Ada", roles: [] });
    const { create, supersede } = await import("../lib/learnings");

    const original = create({
      authorId: "ada.t@example.com",
      title: "Use runTest.sh not dotnet test directly",
      body: "runTest.sh wires up loggers and coverage and starts dependency containers for integration tests.",
      tags: ["ci", "testing"],
    });
    const replacement = create({
      authorId: "ada.t@example.com",
      title: "Correction: runTest.sh guidance",
      body: "Totally different replacement content about something else entirely, unrelated to test runners.",
      tags: ["ci"],
    });
    supersede(replacement.id, original.id, "ada.t@example.com");

    const stillDuplicate = create({
      authorId: "ada.t@example.com",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage and starts dependency containers for integration tests.",
      tags: ["ci", "testing"],
      confirmNotDuplicate: true,
    });

    const { GET } = await import("../app/api/learnings/duplicates/route");
    const res = await GET();
    const body = await res.json();

    for (const pair of body.pairs) {
      expect([pair.a.id, pair.b.id]).not.toContain(original.id);
    }
    void stillDuplicate;
  });
});
