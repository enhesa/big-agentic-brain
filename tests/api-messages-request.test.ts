import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-messages-request-test-"));
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

function mockAgentIdentity(email: string, name: string) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": name }),
  }));
}

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice.t@example.com", email: "alice.t@example.com", name: "Alice", roles: [] });
  upsertUser({ id: "bob.t@example.com", email: "bob.t@example.com", name: "Bob", roles: [] });
}

function postReq(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request("http://x/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

const VALID_REQUEST = {
  kind: "review-pr",
  goal: "Please review the auth changes on this PR before I merge.",
  repo: "https://git.example.com/org/bab.git",
  ref: "feature/JIRA-123-request",
  cwd: "bab",
  links: ["https://git.example.com/org/bab/pulls/42"],
};

describe("POST /api/messages: request", () => {
  it("201s with a valid request and returns it stored/parsed", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(
      postReq({ to: "bob.t@example.com", subject: "Please review", body: "See request", request: VALID_REQUEST }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.request).toEqual(VALID_REQUEST);
  });

  it("exposes the parsed request in GET /api/inbox/<thread>", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const sendRes = await POST(
      postReq({ to: "bob.t@example.com", subject: "Please review", body: "See request", request: VALID_REQUEST }) as never,
    );
    const sendBody = await sendRes.json();
    const threadId = sendBody.thread.id;

    const { GET } = await import("../app/api/inbox/[threadId]/route");
    const res = await GET(
      new Request(`http://x/api/inbox/${threadId}`) as never,
      { params: Promise.resolve({ threadId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const msg = body.messages.find((m: { request: unknown }) => m.request);
    expect(msg.request).toEqual(VALID_REQUEST);
  });

  it("a message without a request has request: null", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "bob.t@example.com", body: "Plain message" }) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.request).toBeNull();
  });

  it("400s on an invalid kind", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(
      postReq({ to: "bob.t@example.com", body: "Hi", request: { ...VALID_REQUEST, kind: "Review PR!" } }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/kind/i);
  });

  it("400s on an over-long goal", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(
      postReq({
        to: "bob.t@example.com",
        body: "Hi",
        request: { ...VALID_REQUEST, goal: "x".repeat(2001) },
      }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/goal/i);
  });

  it("400s on a cwd with a slash", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(
      postReq({ to: "bob.t@example.com", body: "Hi", request: { ...VALID_REQUEST, cwd: "some/path" } }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/cwd/i);
  });

  it("400s on more than 5 links", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(
      postReq({
        to: "bob.t@example.com",
        body: "Hi",
        request: {
          ...VALID_REQUEST,
          links: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`),
        },
      }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/links/i);
  });

  it("400s on a non-object request", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "bob.t@example.com", body: "Hi", request: "not-an-object" }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/request/i);
  });

  it("redacts a secret in the goal", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const secret = `ghp_${"a".repeat(36)}`;
    const res = await POST(
      postReq({
        to: "bob.t@example.com",
        body: "Hi",
        request: { ...VALID_REQUEST, goal: `Please check this token ${secret} is rotated.` },
      }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.request.goal).not.toContain(secret);
    expect(body.message.request.goal).toContain("[redacted]");
  });
  it("400s on a link that is not an http(s) URL", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(
      postReq({ to: "bob.t@example.com", body: "Hi", request: { ...VALID_REQUEST, links: ["javascript:alert(1)"] } }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain("http(s)");
  });

  it("201s on a self-send that carries a request (open a new session for me)", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(
      postReq({ to: "alice.t@example.com", subject: "Do this", body: "Open a session for this", request: VALID_REQUEST }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.request).toEqual(VALID_REQUEST);
  });

  it("a self-send with no request is a plain note in your own inbox (201)", async () => {
    await seedUsers();
    mockAgentIdentity("alice.t@example.com", "Alice");
    const { POST } = await import("../app/api/messages/route");
    const res = await POST(postReq({ to: "alice.t@example.com", body: "Note to self" }) as never);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.message.to_id).toBe("alice.t@example.com");
    expect(body.message.request).toBeNull();
  });
});
