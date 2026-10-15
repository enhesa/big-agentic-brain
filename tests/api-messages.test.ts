import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-messages-test-"));
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

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice.t@example.com", email: "alice.t@example.com", name: "Alice", roles: [] });
  upsertUser({ id: "bob@example.com", email: "bob@example.com", name: "Bob", roles: [] });
  upsertUser({ id: "carol.t@example.com", email: "carol.t@example.com", name: "Carol", roles: [] });
}

function postReq(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request("http://x/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

describe("POST /api/messages", () => {
  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "bob@example.com", body: "Hi" }) as never);
    expect(res.status).toBe(401);
  });

  it("happy path: sends a new message and returns 201", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "bob@example.com", subject: "Hi", body: "First" }) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.to_id).toBe("bob@example.com");
  });

  it("400s when to or body is missing", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "", body: "" }) as never);
    expect(res.status).toBe(400);
  });

  it("400s on an unknown recipient", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "ghost@example.com", body: "Hi" }) as never);
    expect(res.status).toBe(400);
  });

  it("404s when replying into a thread that doesn't exist", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "bob@example.com", body: "Hi", threadId: "nope" }) as never);
    expect(res.status).toBe(404);
  });

  it("403s when replying into a thread you're not a participant of", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice.t@example.com", to: "bob@example.com", subject: "Hi", body: "First" });

    mockAgentIdentity("carol.t@example.com", "Carol");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "alice.t@example.com", body: "Butting in", threadId: thread.id }) as never);
    expect(res.status).toBe(403);
  });

  it("replays the same body for a repeat Idempotency-Key", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");

    const first = await POST(postReq({ to: "bob@example.com", body: "Hi" }, { "Idempotency-Key": "m1" }) as never);
    const firstBody = await first.json();
    const second = await POST(postReq({ to: "bob@example.com", body: "Hi" }, { "Idempotency-Key": "m1" }) as never);
    const secondBody = await second.json();

    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(secondBody).toEqual(firstBody);

    const third = await POST(postReq({ to: "bob@example.com", body: "Different" }, { "Idempotency-Key": "m1" }) as never);
    expect(third.status).toBe(422);

    const { inboxFor } = await import("../lib/messages");
    expect(inboxFor("bob@example.com").length).toBe(1);
  });
});

describe("POST /api/messages: inbox only, toSession is ignored", () => {
  it("delivers to the recipient's inbox and ignores toSession", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "bob@example.com", body: "Hi", toSession: "docs" }) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.to_id).toBe("bob@example.com");
    expect(body.message).not.toHaveProperty("toSession");
    expect(body.message).not.toHaveProperty("to_session");
    const { inboxFor } = await import("../lib/messages");
    expect(inboxFor("bob@example.com")).toHaveLength(1);
  });

  it("400s a new thread with only toSession, saying messages go to a person's inbox", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ body: "Hi", toSession: "docs" }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/to is required/);
    expect(body.error).toMatch(/inbox/);
  });

  it("a note to yourself is a 201 and lands in your own inbox", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "alice.t@example.com", subject: "Note", body: "Remember the flaky test" }) as never);
    expect(res.status).toBe(201);
    const { inboxFor } = await import("../lib/messages");
    expect(inboxFor("alice.t@example.com")[0].unreadCount).toBe(1);
  });
});

describe("POST /api/messages: replies infer the recipient", () => {
  it("a reply with threadId and no `to` goes to the other participant", async () => {
    const { send, thread } = await import("../lib/messages");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "a@example.com", email: "a@example.com", name: "A", roles: [] });
    upsertUser({ id: "b@example.com", email: "b@example.com", name: "B", roles: [] });
    const first = send({ fromId: "a@example.com", to: "b@example.com", subject: "s", body: "hello" }, "mcp");
    const reply = send({ fromId: "b@example.com", body: "hi back", threadId: first.thread.id }, "mcp");
    expect(reply.message.to_id).toBe("a@example.com");
    const again = send({ fromId: "a@example.com", body: "thanks", threadId: first.thread.id }, "mcp");
    expect(again.message.to_id).toBe("b@example.com");
    expect(thread(first.thread.id, "a@example.com")?.messages.length ?? 0).toBe(3);
  });

  it("a reply naming a non-participant as `to` is refused", async () => {
    const { send } = await import("../lib/messages");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "a@example.com", email: "a@example.com", name: "A", roles: [] });
    upsertUser({ id: "b@example.com", email: "b@example.com", name: "B", roles: [] });
    upsertUser({ id: "c@example.com", email: "c@example.com", name: "C", roles: [] });
    const first = send({ fromId: "a@example.com", to: "b@example.com", body: "hello" }, "mcp");
    expect(() => send({ fromId: "a@example.com", to: "c@example.com", body: "x", threadId: first.thread.id }, "mcp")).toThrow(/participant/i);
  });

  it("a new thread without `to` is rejected", async () => {
    const { send } = await import("../lib/messages");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "a@example.com", email: "a@example.com", name: "A", roles: [] });
    expect(() => send({ fromId: "a@example.com", body: "x" }, "mcp")).toThrow(/recipient/i);
  });
});
