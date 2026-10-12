import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-todos-actions-test-"));
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

async function seedTodo(ownerId: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ownerId, email: ownerId, name: "Owner", roles: [] });
  const { create } = await import("../lib/todos");
  return create({ ownerId, title: "Mine", dueAt: "2030-01-01" });
}

function actionReq() {
  return new Request("http://x/action", { method: "POST" });
}

for (const action of ["complete", "snooze", "abandon"] as const) {
  describe(`POST /api/todos/[id]/${action}`, () => {
    it("returns 401 without identity", async () => {
      mockNoIdentity();
      const { POST } = await import(`../app/api/todos/[id]/${action}/route`);
      const res = await POST(actionReq() as never, { params: Promise.resolve({ id: "x" }) });
      expect(res.status).toBe(401);
    });

    it("happy path: the owner can act on their own reminder", async () => {
      const todo = await seedTodo("owner.t@example.com");
      mockAgentIdentity("owner.t@example.com", "Owner");
      const { POST } = await import(`../app/api/todos/[id]/${action}/route`);
      const res = await POST(actionReq() as never, { params: Promise.resolve({ id: todo.id }) });
      expect(res.status).toBe(200);
    });

    it("404s for another user's reminder (owner-only)", async () => {
      const todo = await seedTodo("owner.t@example.com");
      mockAgentIdentity("intruder.t@example.com", "Intruder");
      const { POST } = await import(`../app/api/todos/[id]/${action}/route`);
      const res = await POST(actionReq() as never, { params: Promise.resolve({ id: todo.id }) });
      expect(res.status).toBe(404);
    });

    it("404s for an unknown id", async () => {
      mockAgentIdentity("owner.t@example.com", "Owner");
      const { POST } = await import(`../app/api/todos/[id]/${action}/route`);
      const res = await POST(actionReq() as never, { params: Promise.resolve({ id: "nope" }) });
      expect(res.status).toBe(404);
    });
  });
}
