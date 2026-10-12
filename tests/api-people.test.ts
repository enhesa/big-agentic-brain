import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-people-test-"));
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

describe("GET /api/people", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/people/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the directory with learning counts", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { GET } = await import("../app/api/people/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users.some((u: { id: string }) => u.id === "ada.t@example.com")).toBe(true);
    expect(body.users[0]).toHaveProperty("learningCount");
  });
});
