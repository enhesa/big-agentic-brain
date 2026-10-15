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
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  delete process.env.BAB_CLIENT_IP_HEADER;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

function mockRequest(headersMap: Record<string, string>) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers(headersMap),
  }));
}

describe("getSessionUser precedence: proxy > agent headers", () => {
  it("prefers proxy headers over agent headers when both are present and proxy is trusted", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    mockRequest({
      "x-auth-request-user": "proxy-oid",
      "x-auth-request-email": "Proxy.User@example.com",
      "x-auth-request-preferred-username": "Proxy User",
      "x-bab-actor-email": "agent.t@example.com",
      "x-bab-actor-name": "Agent User",
    });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user?.source).toBe("proxy");
    expect(user?.id).toBe("proxy.user@example.com");
  });

  it("keys a trusted proxy viewer on their long-form email, and ignores a short alias", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    mockRequest({ "x-auth-request-user": "proxy-oid", "x-auth-request-email": "fuser@example.com" });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("falls back to agent headers when proxy is untrusted (or absent)", async () => {
    mockRequest({ "x-bab-actor-email": "agent.t@example.com", "x-bab-actor-name": "Agent User" });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user?.source).toBe("declared");
    expect(user?.id).toBe("agent.t@example.com");
  });

  it("even untrusted proxy headers fall through all the way to null with nothing else present", async () => {
    mockRequest({ "x-auth-request-user": "proxy-oid" });
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

  describe("an email bound to a token belongs to that token", () => {
    const ALICE = "alice.example@example.com";
    const asAlice = { "x-bab-actor-email": ALICE, "x-bab-actor-name": "Alice Example" };

    it("declared headers without the bearer resolve to no identity", async () => {
      process.env.BAB_API_TOKENS = `tok=${ALICE}`;
      mockRequest(asAlice);
      const { requireActorForApi } = await import("../lib/session");
      await expect(requireActorForApi()).rejects.toMatchObject({ status: 401 });
    });

    it("the same headers with another bare token do not claim it either", async () => {
      process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
      mockRequest({ ...asAlice, authorization: "Bearer bare" });
      const { requireActorForApi } = await import("../lib/session");
      await expect(requireActorForApi()).rejects.toMatchObject({ status: 401 });
    });

    it("the 401 says the address is bound to a token", async () => {
      process.env.BAB_API_TOKENS = `tok=${ALICE}`;
      mockRequest(asAlice);
      const { requireActorForApi } = await import("../lib/session");
      const res = (await requireActorForApi().catch((e) => e)) as Response;
      expect((await res.json()).error).toBe(`${ALICE} is bound to an API token; connect with that token to act as them`);
    });

    it("the bearer resolves to alice", async () => {
      process.env.BAB_API_TOKENS = `tok=${ALICE}`;
      mockRequest({ ...asAlice, authorization: "Bearer tok" });
      const { requireActorForApi } = await import("../lib/session");
      expect((await requireActorForApi()).id).toBe(ALICE);
    });

    it("a device bound to her address does not act as her without the token", async () => {
      process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
      const device = "d".repeat(64);
      mockRequest({ authorization: "Bearer bare", "x-bab-device": device });
      const d = await import("../lib/devices");
      d.bindDevice(d.hashSecret(device)!, ALICE, "Test device", null);
      const { requireActorForApi } = await import("../lib/session");
      await expect(requireActorForApi()).rejects.toMatchObject({ status: 401 });
    });

    it("a connection bound to her address does not act as her without the token", async () => {
      process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
      const session = "c".repeat(43);
      mockRequest({ authorization: "Bearer bare", "mcp-session-id": session });
      const m = await import("../lib/mcp-connections");
      m.bindConnection(session, ALICE);
      const { requireActorForApi } = await import("../lib/session");
      await expect(requireActorForApi()).rejects.toMatchObject({ status: 401 });
    });

    it("a mixed-case claim of her address is refused too, with the lowercase address in the 401", async () => {
      process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
      mockRequest({
        authorization: "Bearer bare",
        "x-bab-actor-email": "Alice.Example@Example.COM",
        "x-bab-actor-name": "Alice Example",
      });
      const { requireActorForApi } = await import("../lib/session");
      const res = (await requireActorForApi().catch((e) => e)) as Response;
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe(`${ALICE} is bound to an API token; connect with that token to act as them`);
    });

    describe("proxy identity headers on /api and /mcp", () => {
      const asAliceViaProxy = {
        "x-auth-request-user": "proxy-oid",
        "x-auth-request-email": ALICE,
        "x-auth-request-preferred-username": "Alice Example",
      };

      beforeEach(() => {
        process.env.BAB_TRUST_PROXY_IDENTITY = "1";
        process.env.BAB_TRUST_PROXY_WITHOUT_SECRET = "1";
      });

      it("do not claim her address with a bare token", async () => {
        process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
        mockRequest({ ...asAliceViaProxy, authorization: "Bearer bare" });
        const { requireActorForApi } = await import("../lib/session");
        await expect(requireActorForApi()).rejects.toMatchObject({ status: 401 });
      });

      it("do not claim her address with another person's token, which wins instead", async () => {
        process.env.BAB_API_TOKENS = `tok=${ALICE},tokb=bob.example@example.com`;
        mockRequest({ ...asAliceViaProxy, authorization: "Bearer tokb" });
        const { requireActorForApi } = await import("../lib/session");
        expect((await requireActorForApi()).id).toBe("bob.example@example.com");
      });

      it("are her when the request carries her own token", async () => {
        process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
        mockRequest({ ...asAliceViaProxy, authorization: "Bearer tok" });
        const { requireActorForApi } = await import("../lib/session");
        expect((await requireActorForApi()).id).toBe(ALICE);
      });

      it("still identify a person whose address is not bound to a token", async () => {
        process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
        mockRequest({
          "x-auth-request-user": "proxy-oid",
          "x-auth-request-email": "bob.example@example.com",
          "x-auth-request-preferred-username": "Bob Example",
          authorization: "Bearer bare",
        });
        const { requireActorForApi } = await import("../lib/session");
        expect(await requireActorForApi()).toMatchObject({ id: "bob.example@example.com", source: "proxy" });
      });

      it("a token=email bearer beats proxy headers naming someone else who is not token-bound", async () => {
        process.env.BAB_API_TOKENS = `tok=${ALICE}`;
        mockRequest({
          authorization: "Bearer tok",
          "x-auth-request-user": "proxy-oid",
          "x-auth-request-email": "bob.example@example.com",
          "x-auth-request-preferred-username": "Bob Example",
        });
        const { requireActorForApi } = await import("../lib/session");
        expect(await requireActorForApi()).toMatchObject({ id: ALICE, email: ALICE, source: "declared" });
      });

      it("the same headers on a web page (mode off) still resolve to the proxy person", async () => {
        process.env.BAB_API_TOKENS = `tok=${ALICE}`;
        mockRequest({
          authorization: "Bearer tok",
          "x-auth-request-user": "proxy-oid",
          "x-auth-request-email": "bob.example@example.com",
          "x-auth-request-preferred-username": "Bob Example",
        });
        const { getSessionUser } = await import("../lib/session");
        expect(await getSessionUser()).toMatchObject({ id: "bob.example@example.com", source: "proxy" });
      });

      it("keep a token-bound person signed in on a web page (mode off), where no token travels", async () => {
        process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
        mockRequest(asAliceViaProxy);
        const { getSessionUser } = await import("../lib/session");
        expect(await getSessionUser()).toMatchObject({ id: ALICE, source: "proxy" });
      });
    });

    it("another person is unaffected", async () => {
      process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
      mockRequest({ authorization: "Bearer bare", "x-bab-actor-email": "bob.example@example.com", "x-bab-actor-name": "Bob Example" });
      const { requireActorForApi } = await import("../lib/session");
      expect((await requireActorForApi()).id).toBe("bob.example@example.com");
    });

    it("logs one warning line, not one per request", async () => {
      process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
      mockRequest({ ...asAlice, authorization: "Bearer bare" });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { requireActorForApi } = await import("../lib/session");
      for (let i = 0; i < 3; i++) await requireActorForApi().catch(() => {});
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("bound to an API token"))).toHaveLength(1);
      warn.mockRestore();
    });
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

  describe("with BAB_TRUST_PROXY_IDENTITY=1", () => {
    afterEach(() => {
      delete process.env.BAB_PROXY_SECRET;
    });

    const actor = { "x-bab-actor-email": "alice.example@example.com", "x-bab-actor-name": "Alice Example" };

    it("a web page ignores actor headers when the request carries no proxy identity", async () => {
      process.env.BAB_TRUST_PROXY_IDENTITY = "1";
      mockRequest(actor);
      const { getSessionUser } = await import("../lib/session");
      await expect(getSessionUser()).resolves.toBeNull();
    });

    it("a web page ignores actor headers when the proxy secret is wrong", async () => {
      process.env.BAB_TRUST_PROXY_IDENTITY = "1";
      process.env.BAB_PROXY_SECRET = "right";
      mockRequest({
        ...actor,
        "x-bab-proxy-secret": "wrong",
        "x-auth-request-user": "proxy-oid",
        "x-auth-request-email": "bob.example@example.com",
        "x-auth-request-preferred-username": "Bob Example",
      });
      const { getSessionUser } = await import("../lib/session");
      await expect(getSessionUser()).resolves.toBeNull();
    });

    it("API paths still accept actor headers", async () => {
      process.env.BAB_TRUST_PROXY_IDENTITY = "1";
      mockRequest(actor);
      const { requireActorForApi } = await import("../lib/session");
      expect((await requireActorForApi()).id).toBe("alice.example@example.com");
    });
  });
});
