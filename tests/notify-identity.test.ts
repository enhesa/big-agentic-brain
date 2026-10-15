import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-notify-identity-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  vi.doUnmock("next/headers");
  vi.restoreAllMocks();
  vi.resetModules();
});

function mockHeaders(map: Record<string, string>) {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(map) }));
}

function asViewer(email: string, id = "proxy-oid-1", name = "Alice Example") {
  mockHeaders({ "x-auth-request-user": id, "x-auth-request-email": email, "x-auth-request-preferred-username": name });
}

async function seed(...emails: string[]) {
  const { upsertUser } = await import("../lib/users");
  for (const email of emails) upsertUser({ id: email, email, name: null, roles: [] });
}

function claim(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/notify/identity/claim", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", ...headers },
    body: JSON.stringify(body),
  });
}

describe("GET /notify/identity", () => {
  it("401s with no proxy viewer", async () => {
    mockHeaders({});
    const { GET } = await import("../app/notify/identity/route");
    const res = await GET();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("401s for agent headers only", async () => {
    mockHeaders({ "x-bab-actor-email": "bob.t@example.com", "x-bab-actor-name": "Bob" });
    const { GET } = await import("../app/notify/identity/route");
    expect((await GET()).status).toBe(401);
  });

  it("401s when proxy headers are not trusted", async () => {
    delete process.env.BAB_TRUST_PROXY_IDENTITY;
    asViewer("aexample@example.com");
    const { GET } = await import("../app/notify/identity/route");
    expect((await GET()).status).toBe(401);
  });

  it("reports linked for a long-form viewer", async () => {
    asViewer("bob.t@example.com");
    const { GET } = await import("../app/notify/identity/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "linked", email: "bob.t@example.com" });
  });

  it("reports linked for an alias viewer whose proxy id is linked", async () => {
    await seed("alice.example@example.com");
    const { claimSuggestedLink } = await import("../lib/proxy-links");
    claimSuggestedLink("proxy-oid-1", "aexample@example.com", "Alice Example", "alice.example@example.com");
    asViewer("aexample@example.com");
    const { GET } = await import("../app/notify/identity/route");
    expect(await (await GET()).json()).toMatchObject({ state: "linked", email: "alice.example@example.com" });
  });

  it("suggests the matching long-form user for an unlinked alias viewer", async () => {
    await seed("alice.example@example.com");
    asViewer("aexample@example.com");
    const { GET } = await import("../app/notify/identity/route");
    expect(await (await GET()).json()).toEqual({
      state: "suggest",
      email: "alice.example@example.com",
      name: "Alice Example",
    });
  });

  it("points an unlinked viewer with no suggestion at /me/devices, with no code", async () => {
    asViewer("aexample@example.com");
    const { GET } = await import("../app/notify/identity/route");
    expect(await (await GET()).json()).toEqual({ state: "claim", url: "/me/devices" });
  });
});

describe("POST /notify/identity/claim", () => {
  it("links the viewer when the claim matches the suggestion", async () => {
    await seed("alice.example@example.com");
    asViewer("aexample@example.com");
    const { POST } = await import("../app/notify/identity/claim/route");
    const res = await POST(claim({ email: "alice.example@example.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "linked", email: "alice.example@example.com" });
    const { getLinkedUserId } = await import("../lib/proxy-links");
    expect(getLinkedUserId("proxy-oid-1")).toBe("alice.example@example.com");
  });

  it("400s when the claim does not match the suggestion", async () => {
    await seed("alice.example@example.com", "anna.smith@example.com");
    asViewer("aexample@example.com");
    const { POST } = await import("../app/notify/identity/claim/route");
    expect((await POST(claim({ email: "anna.smith@example.com" }))).status).toBe(400);
    expect((await POST(claim({}))).status).toBe(400);
    expect((await POST(claim({ email: 5 }))).status).toBe(400);
  });

  it("409s when the user is already linked to another proxy id", async () => {
    await seed("alice.example@example.com");
    const { claimSuggestedLink } = await import("../lib/proxy-links");
    claimSuggestedLink("someone-else", "aexample@example.com", "Alice Example", "alice.example@example.com");
    asViewer("aexample@example.com");
    const { POST } = await import("../app/notify/identity/claim/route");
    expect((await POST(claim({ email: "alice.example@example.com" }))).status).toBe(409);
  });

  it("401s with no proxy viewer", async () => {
    mockHeaders({});
    const { POST } = await import("../app/notify/identity/claim/route");
    expect((await POST(claim({ email: "alice.example@example.com" }))).status).toBe(401);
  });

  it("403s cross-origin and 415s for text/plain, linking nothing", async () => {
    await seed("alice.example@example.com");
    asViewer("aexample@example.com");
    const { POST } = await import("../app/notify/identity/claim/route");
    expect((await POST(claim({ email: "alice.example@example.com" }, { origin: "https://evil.example" }))).status).toBe(403);
    const plain = new Request("http://localhost/notify/identity/claim", {
      method: "POST",
      headers: { "content-type": "text/plain", host: "localhost", origin: "http://localhost" },
      body: JSON.stringify({ email: "alice.example@example.com" }),
    });
    expect((await POST(plain)).status).toBe(415);
    const { getLinkedUserId } = await import("../lib/proxy-links");
    expect(getLinkedUserId("proxy-oid-1")).toBeNull();
  });
});
