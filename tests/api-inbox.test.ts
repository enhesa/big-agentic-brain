import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-inbox-test-"));
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

async function seedThread() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
  upsertUser({ id: "bob.t@example.com", email: "bob.t@example.com", name: "Bob", roles: [] });
  const { send } = await import("../lib/messages");
  return send({ fromId: "alice@example.com", to: "bob.t@example.com", subject: "Hi", body: "First" });
}

describe("GET /api/inbox", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/inbox/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns my threads with unread counts", async () => {
    await seedThread();
    mockAgentIdentity("bob.t@example.com", "Bob");
    const { GET } = await import("../app/api/inbox/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.threads.length).toBe(1);
    expect(body.threads[0].unreadCount).toBe(1);
  });
});

describe("GET /api/inbox/[threadId]", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { GET } = await import("../app/api/inbox/[threadId]/route");
    const res = await GET(new Request("http://x/api/inbox/t1") as never, {
      params: Promise.resolve({ threadId: "t1" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns the thread for a participant and marks it read", async () => {
    const { thread } = await seedThread();
    mockAgentIdentity("bob.t@example.com", "Bob");
    const { GET } = await import("../app/api/inbox/[threadId]/route");
    const res = await GET(new Request(`http://x/api/inbox/${thread.id}`) as never, {
      params: Promise.resolve({ threadId: thread.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages.length).toBe(1);

    const { unreadCountFor } = await import("../lib/messages");
    expect(unreadCountFor("bob.t@example.com")).toBe(0);
  });

  it("the response's own messages already reflect read_at, not a stale pre-mark snapshot", async () => {
    const { thread } = await seedThread();
    mockAgentIdentity("bob.t@example.com", "Bob");
    const { GET } = await import("../app/api/inbox/[threadId]/route");
    const res = await GET(new Request(`http://x/api/inbox/${thread.id}`) as never, {
      params: Promise.resolve({ threadId: thread.id }),
    });
    const body = await res.json();
    const messageToBob = body.messages.find((m: { to_id: string }) => m.to_id === "bob.t@example.com");
    expect(messageToBob.read_at).not.toBeNull();
  });

  it("403s for a non-participant", async () => {
    const { thread } = await seedThread();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "carol.t@example.com", email: "carol.t@example.com", name: "Carol", roles: [] });
    mockAgentIdentity("carol.t@example.com", "Carol");
    const { GET } = await import("../app/api/inbox/[threadId]/route");
    const res = await GET(new Request(`http://x/api/inbox/${thread.id}`) as never, {
      params: Promise.resolve({ threadId: thread.id }),
    });
    expect(res.status).toBe(403);
  });

  it("404s for an unknown thread", async () => {
    mockAgentIdentity("bob.t@example.com", "Bob");
    const { GET } = await import("../app/api/inbox/[threadId]/route");
    const res = await GET(new Request("http://x/api/inbox/nope") as never, {
      params: Promise.resolve({ threadId: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("includes fromName/toName on each message", async () => {
    const { thread } = await seedThread();
    mockAgentIdentity("bob.t@example.com", "Bob");
    const { GET } = await import("../app/api/inbox/[threadId]/route");
    const res = await GET(new Request(`http://x/api/inbox/${thread.id}`) as never, {
      params: Promise.resolve({ threadId: thread.id }),
    });
    const body = await res.json();
    // "bob.t@example.com" is a long-form address: upsertUser derives "Bob T" from it
    // on first sight since "Bob" doesn't loosely match, and that stored name wins.
    expect(body.messages[0].fromName).toBe("Alice");
    expect(body.messages[0].toName).toBe("Bob T");
  });
});
