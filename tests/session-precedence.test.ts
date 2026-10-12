import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-session-precedence-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_FORGE_HEADERS;
  delete process.env.BAB_CLIENT_IP_HEADER;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

function mockRequest(headersMap: Record<string, string>) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers(headersMap),
  }));
}

describe("getSessionUser precedence: forge > agent headers", () => {
  it("prefers forge headers over agent headers when both are present and forge is trusted", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    mockRequest({
      "x-auth-request-user": "forge-oid",
      "x-auth-request-email": "Forge.User@example.com",
      "x-auth-request-preferred-username": "Forge User",
      "x-bab-actor-email": "agent.t@example.com",
      "x-bab-actor-name": "Agent User",
    });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user?.source).toBe("forge");
    expect(user?.id).toBe("forge.user@example.com");
  });

  it("keys a trusted forge viewer on their long-form email, and ignores a short alias", async () => {
    process.env.BAB_TRUST_FORGE_HEADERS = "1";
    mockRequest({ "x-auth-request-user": "forge-oid", "x-auth-request-email": "fuser@example.com" });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("falls back to agent headers when forge is untrusted (or absent)", async () => {
    mockRequest({ "x-bab-actor-email": "agent.t@example.com", "x-bab-actor-name": "Agent User" });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user?.source).toBe("declared");
    expect(user?.id).toBe("agent.t@example.com");
  });

  it("even untrusted forge headers fall through all the way to null with nothing else present", async () => {
    mockRequest({ "x-auth-request-user": "forge-oid" });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });
});

describe("bearer token identity and the pre-identity limit", () => {
  afterEach(() => {
    delete process.env.BAB_API_TOKENS;
  });

  it("a token=email bearer replaces the declared actor", async () => {
    process.env.BAB_API_TOKENS = "t1=alice.example@example.com";
    mockRequest({
      authorization: "Bearer t1",
      "x-bab-actor-email": "mallory.evil@example.com",
      "x-bab-actor-name": "Mallory Evil",
    });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.id).toBe("alice.example@example.com");
  });

  it("a bare token leaves the declared actor in place", async () => {
    process.env.BAB_API_TOKENS = "bare";
    mockRequest({
      authorization: "Bearer bare",
      "x-bab-actor-email": "agent.t@example.com",
      "x-bab-actor-name": "Agent User",
    });
    const { requireActorForApi } = await import("../lib/session");
    expect((await requireActorForApi()).id).toBe("agent.t@example.com");
  });

  it("does not cap new declared identities while BAB_CLIENT_IP_HEADER is unset (unverified address)", async () => {
    let current: Record<string, string> = {};
    vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
    const { requireActorForApi } = await import("../lib/session");
    for (let n = 0; n < 61; n++) {
      current = {
        "x-real-ip": "203.0.113.9",
        "x-bab-actor-email": `agent.n${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}@example.com`,
        "x-bab-actor-name": "Agent User",
      };
      await expect(requireActorForApi()).resolves.toMatchObject({ source: "declared" });
    }
  });

  it("429s the 61st new declared identity from one address, not an existing one", async () => {
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    let current: Record<string, string> = {};
    vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
    const { requireActorForApi } = await import("../lib/session");
    const as = async (n: number) => {
      current = {
        "x-real-ip": "203.0.113.9",
        "x-bab-actor-email": `agent.n${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}@example.com`,
        "x-bab-actor-name": "Agent User",
      };
      return requireActorForApi();
    };
    for (let n = 0; n < 60; n++) await as(n);
    await expect(as(60)).rejects.toMatchObject({ status: 429 });
    await expect(as(0)).resolves.toMatchObject({ source: "declared" });
  });
  it("a pinned token beats a remembered device", async () => {
    process.env.BAB_API_TOKENS = "t1=alice.example@example.com";
    let current: Record<string, string> = {};
    vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
    const d = await import("../lib/devices");
    const device = "d".repeat(64);
    d.bindDevice(d.hashSecret(device)!, "bob.example@example.com", "Test device", null);
    current = { authorization: "Bearer t1", "x-bab-device": device };
    const { requireActorForApi } = await import("../lib/session");
    expect((await requireActorForApi()).id).toBe("alice.example@example.com");
  });

  it("an unresolved client address is not limited per IP", async () => {
    let n = 0;
    let current: Record<string, string> = {};
    vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
    const { requireActorForApi } = await import("../lib/session");
    for (; n < 65; n++) {
      current = {
        "x-bab-actor-email": `agent.m${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}@example.com`,
        "x-bab-actor-name": "Agent User",
      };
      await expect(requireActorForApi()).resolves.toMatchObject({ source: "declared" });
    }
  });
});

describe("web paths (mode off) and actor headers", () => {
  afterEach(() => {
    delete process.env.BAB_API_TOKENS;
  });

  it("ignores actor headers when tokens are configured, so token mode cannot be bypassed", async () => {
    process.env.BAB_API_TOKENS = "t1=alice.example@example.com";
    mockRequest({ "x-bab-actor-email": "mallory.evil@example.com", "x-bab-actor-name": "Mallory Evil" });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("still honours actor headers when no tokens are configured", async () => {
    delete process.env.BAB_API_TOKENS;
    mockRequest({ "x-bab-actor-email": "agent.t@example.com", "x-bab-actor-name": "Agent User" });
    const { getSessionUser } = await import("../lib/session");
    expect((await getSessionUser())?.id).toBe("agent.t@example.com");
  });
});
