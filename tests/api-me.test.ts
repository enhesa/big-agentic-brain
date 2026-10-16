import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-me-test-"));
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

describe("GET /api/me", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/me/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("echoes the resolved actor with zeroed counts for a fresh identity", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada T");
    const { GET } = await import("../app/api/me/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actor.id).toBe("ada.t@example.com");
    expect(body.counts).toEqual({ learnings: 0, todosOpen: 0, unreadMessages: 0 });
    expect(body.homeTeam).toBeNull();
    expect(body.areas).toEqual([]);
  });

  it("reflects a learning and an open todo in the counts", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada T");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "ada.t@example.com", email: "ada.t@example.com", name: "Ada T", roles: [] });
    const { create: createLearning } = await import("../lib/learnings");
    createLearning({ authorId: "ada.t@example.com", title: "T", body: "B" });
    const { create: createTodo } = await import("../lib/todos");
    createTodo({ ownerId: "ada.t@example.com", title: "T", dueAt: "2030-01-01" });

    const { GET } = await import("../app/api/me/route");
    const res = await GET();
    const body = await res.json();
    expect(body.counts.learnings).toBe(1);
    expect(body.counts.todosOpen).toBe(1);
  });
});

describe("POST /api/me", () => {
  function req(body: unknown) {
    return new Request("http://x/api/me", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { POST } = await import("../app/api/me/route");
    const res = await POST(req({ name: "New Name" }) as never);
    expect(res.status).toBe(401);
  });

  it("renames the caller and returns the updated actor", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada T");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "ada.t@example.com", email: "ada.t@example.com", name: "Ada T", roles: [] });

    const { POST } = await import("../app/api/me/route");
    const res = await POST(req({ name: "Ada Lovelace" }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actor.name).toBe("Ada Lovelace");

    const { getUser } = await import("../lib/users");
    expect(getUser("ada.t@example.com")!.name).toBe("Ada Lovelace");
  });

  it("400s on a name outside 2-80 characters", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada T");
    const { POST } = await import("../app/api/me/route");
    const res = await POST(req({ name: "A" }) as never);
    expect(res.status).toBe(400);
  });

  it("upsertUser (invoked by every request's identity resolution) never lets a later different name win", async () => {
    // Exercises the same upsertUser() path GET/POST /api/me and every other
    // route go through via getSessionUser(); see lib/users.ts for the full
    // name_mismatch audit coverage.
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "ada.t@example.com", email: "ada.t@example.com", name: "Ada T", roles: [] });
    const second = upsertUser({ id: "ada.t@example.com", email: "ada.t@example.com", name: "Someone Else", roles: [] });
    expect(second.name).toBe("Ada T");
  });
});
