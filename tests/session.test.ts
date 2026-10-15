import { linkForTests } from "./link-helper";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-session-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  const { resetForTests } = await import("../lib/rate-limit");
  resetForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

/** Mocks next/headers so both lib/user.ts's currentUser() and lib/session.ts's
 *  agent-header fallback see the same request headers. No x-proxy-* headers
 *  here, so the the sign-in proxy source never fires in these tests. */
function mockRequest(headersMap: Record<string, string>) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers(headersMap),
  }));
}

describe("getSessionUser: agent headers fallback", () => {
  it("accepts a valid @example.com email + name, lowercases the email, and uses it as id", async () => {
    mockRequest({
      "x-bab-actor-email": "Test.User@Example.com",
      "x-bab-actor-name": "  Test User  ",
    });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user).toEqual({
      id: "test.user@example.com",
      email: "test.user@example.com",
      name: "Test User",
      roles: [],
      source: "declared",
    });
  });

  it("accepts hyphenated and apostrophe names in the local part", async () => {
    mockRequest({
      "x-bab-actor-email": "jean-luc.o'brien@example.com",
      "x-bab-actor-name": "Jean-Luc O'Brien",
    });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user?.id).toBe("jean-luc.o'brien@example.com");
  });

  it("rejects the short alias (no dot in the local part) even though the domain is valid", async () => {
    mockRequest({
      "x-bab-actor-email": "tuser@example.com",
      "x-bab-actor-name": "Test User",
    });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("rejects a non-@example.com email as absent (null), not a crash", async () => {
    mockRequest({
      "x-bab-actor-email": "test.user@gmail.com",
      "x-bab-actor-name": "Test User",
    });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("treats missing headers as absent, falling through to null", async () => {
    mockRequest({});
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });
});

describe("requireActorForApi", () => {
  it("throws a 401 Response with the identity-required message when no identity resolves", async () => {
    mockRequest({});
    const { requireActorForApi } = await import("../lib/session");

    let thrown: unknown;
    try {
      await requireActorForApi();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Identity required: send X-Bab-Actor-Email and X-Bab-Actor-Name");
  });

  it("throws the short-alias-specific message when the email is a valid @example.com address with no dot in the local part", async () => {
    mockRequest({
      "x-bab-actor-email": "tuser@example.com",
      "x-bab-actor-name": "Test User",
    });
    const { requireActorForApi } = await import("../lib/session");

    let thrown: unknown;
    try {
      await requireActorForApi();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe(
      "Identity rejected: Use your long address in the form first.last@example.com (not the short alias)",
    );
  });

  it("throws a distinct 401 identity-rejected message when headers are present but the email isn't @example.com", async () => {
    mockRequest({
      "x-bab-actor-email": "test.user@gmail.com",
      "x-bab-actor-name": "Test User",
    });
    const { requireActorForApi } = await import("../lib/session");

    let thrown: unknown;
    try {
      await requireActorForApi();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe(
      "Identity rejected: X-Bab-Actor-Email must be an address in the form first.last@example.com and X-Bab-Actor-Name 2-80 characters",
    );
  });

  it("throws the identity-rejected message when the name is too short", async () => {
    mockRequest({
      "x-bab-actor-email": "test.user@example.com",
      "x-bab-actor-name": "A",
    });
    const { requireActorForApi } = await import("../lib/session");

    let thrown: unknown;
    try {
      await requireActorForApi();
    } catch (e) {
      thrown = e;
    }

    const res = thrown as Response;
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Identity rejected");
  });

  it("returns the resolved user when an identity is present", async () => {
    mockRequest({
      "x-bab-actor-email": "test.user@example.com",
      "x-bab-actor-name": "Test User",
    });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.id).toBe("test.user@example.com");
  });

  it("throws a 429 Response once the actor is over the rate limit", async () => {
    mockRequest({
      "x-bab-actor-email": "busy.user@example.com",
      "x-bab-actor-name": "Busy User",
    });
    const { requireActorForApi } = await import("../lib/session");
    const { RATE_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");

    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      await requireActorForApi();
    }

    let thrown: unknown;
    try {
      await requireActorForApi();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/rate limit/i);
    // The text states the real number, taken from the constant.
    expect(body.error).toBe(`Rate limit exceeded: ${RATE_LIMIT_PER_MINUTE} requests/minute per identity`);
  });
});

describe("getSessionUser: identity proxy headers are only trusted behind the SSO proxy", () => {
  afterEach(() => {
    delete process.env.BAB_TRUST_PROXY_IDENTITY;
  });

  it("ignores forged identity proxy headers when BAB_TRUST_PROXY_IDENTITY is unset (SSO off)", async () => {
    mockRequest({ "x-auth-request-user": "oid-1", "x-auth-request-email": "spoof@example.com", "x-auth-request-preferred-username": "Spoof" });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("trusts identity proxy headers when BAB_TRUST_PROXY_IDENTITY=1 (SSO on)", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    mockRequest({ "x-auth-request-user": "oid-1", "x-auth-request-email": "real.person@example.com", "x-auth-request-preferred-username": "Real Person" });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user?.source).toBe("proxy");
    expect(user?.id).toBe("real.person@example.com");
  });

  it("a value other than exactly '1' does not enable trust", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "true";
    mockRequest({ "x-auth-request-user": "oid-1", "x-auth-request-email": "spoof@example.com", "x-auth-request-preferred-username": "Spoof" });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });
});

describe("getSessionUser / fromProxy: a redeemed browser link", () => {
  afterEach(() => {
    delete process.env.BAB_TRUST_PROXY_IDENTITY;
  });

  it("makes getSessionUser return the linked user for that proxy id", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    await linkForTests("proxy-oid-linked", "jean.dupont@example.com");

    // Production shape: a short alias in the proxy email header, which alone would resolve
    // to no identity — the proxy_links row is what makes this viewer resolvable at all.
    mockRequest({
      "x-auth-request-user": "proxy-oid-linked",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user?.source).toBe("proxy");
    expect(user?.id).toBe("jean.dupont@example.com");
    expect(user?.email).toBe("jean.dupont@example.com");
  });

  it("never resolves the linked identity for a different proxy id", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    await linkForTests("proxy-oid-linked", "jean.dupont@example.com");

    // A different proxy id, also with a short alias, must resolve to no identity —
    // the link is keyed on the proxy id, not on anything guessable from the email.
    mockRequest({
      "x-auth-request-user": "proxy-oid-someone-else",
      "x-auth-request-email": "someone@example.com",
      "x-auth-request-preferred-username": "Someone Else",
    });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });
});

describe("fromProxy: a stored link must still fit the SSO name (review fix)", () => {
  afterEach(() => {
    delete process.env.BAB_TRUST_PROXY_IDENTITY;
  });

  async function seedLink(proxyId: string, userId: string) {
    const { getDb } = await import("../lib/db");
    getDb().prepare("INSERT INTO proxy_links (proxy_user_id, user_id) VALUES (?, ?)").run(proxyId, userId);
  }

  it("treats a legacy link whose SSO name does not fit the linked email as unlinked, and warns without PII", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1"; // new name: the deprecated alias would add its own warning
    vi.spyOn(console, "warn").mockImplementation(() => {});
    (await import("../lib/config")).config(); // load now: the no-secret startup warning is not under test
    vi.restoreAllMocks();
    await seedLink("proxy-oid-legacy", "jean.dupont@example.com");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockRequest({
      "x-auth-request-user": "proxy-oid-legacy",
      "x-auth-request-email": "mmallory@example.com",
      "x-auth-request-preferred-username": "Mallory Mallet",
    });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain("proxy-oid-legacy");
    expect(msg).not.toMatch(/dupont|mallory|mallet/i);
    warn.mockRestore();
  });

  it("still resolves a link whose SSO name fits", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    await seedLink("proxy-oid-ok", "jean.dupont@example.com");
    mockRequest({
      "x-auth-request-user": "proxy-oid-ok",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });
    const { getSessionUser } = await import("../lib/session");
    expect((await getSessionUser())?.id).toBe("jean.dupont@example.com");
  });
});

describe("pendingProxyLinkUser", () => {
  afterEach(() => {
    delete process.env.BAB_TRUST_PROXY_IDENTITY;
  });

  it("returns the proxy user (id, email, name) for a trusted, unlinked viewer with a short-alias email", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    mockRequest({
      "x-auth-request-user": "proxy-oid-pending",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });
    const { pendingProxyLinkUser } = await import("../lib/session");
    await expect(pendingProxyLinkUser()).resolves.toMatchObject({
      id: "proxy-oid-pending",
      email: "jdupont@example.com",
      name: "Jean Dupont",
    });
  });

  it("returns null once that proxy id is linked", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    await linkForTests("proxy-oid-pending", "jean.dupont@example.com");

    mockRequest({
      "x-auth-request-user": "proxy-oid-pending",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });
    const { pendingProxyLinkUser } = await import("../lib/session");
    await expect(pendingProxyLinkUser()).resolves.toBeNull();
  });

  it("returns null for a long-form proxy email (already resolvable without linking)", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    mockRequest({
      "x-auth-request-user": "proxy-oid-longform",
      "x-auth-request-email": "real.person@example.com",
      "x-auth-request-preferred-username": "Real Person",
    });
    const { pendingProxyLinkUser } = await import("../lib/session");
    await expect(pendingProxyLinkUser()).resolves.toBeNull();
  });

  it("returns null when BAB_TRUST_PROXY_IDENTITY is unset, even with proxy headers present", async () => {
    mockRequest({
      "x-auth-request-user": "proxy-oid-untrusted",
      "x-auth-request-email": "jdupont@example.com",
      "x-auth-request-preferred-username": "Jean Dupont",
    });
    const { pendingProxyLinkUser } = await import("../lib/session");
    await expect(pendingProxyLinkUser()).resolves.toBeNull();
  });

  it("returns null with no proxy viewer at all", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    mockRequest({});
    const { pendingProxyLinkUser } = await import("../lib/session");
    await expect(pendingProxyLinkUser()).resolves.toBeNull();
  });
});

describe("getSessionUser: display name is canonical from the store", () => {
  it("a mismatched X-Bab-Actor-Name is not echoed back once the user is known", async () => {
    mockRequest({ "x-bab-actor-email": "known.t@example.com", "x-bab-actor-name": "Impostor" });
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "known.t@example.com", email: "known.t@example.com", name: "Known T", roles: [] });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user?.name).toBe("Known T");
  });
});

describe("Authorization is ignored (personal tokens are gone)", () => {
  const MALLORY = "mallory.m@example.com";
  const MALLORY_HEADERS = { "x-bab-actor-email": MALLORY, "x-bab-actor-name": "Mallory M" };
  // Built at runtime so no token-shaped literal sits in the source.
  const bearer = () => `Bearer ${["bab", "_", "B".repeat(43)].join("")}`;

  it.each([
    ["a bab bearer", bearer()],
    ["an empty bearer", "Bearer "],
    ["garbage", "Bearer nonsense"],
    ["another scheme", "Basic Zm9vOmJhcg=="],
  ])("%s never refuses the request: the actor headers decide", async (_label, authorization) => {
    mockRequest({ authorization, ...MALLORY_HEADERS });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.id).toBe(MALLORY);
    expect(user.source).toBe("declared");
  });

  it("a bearer alone is not an identity: 401 asking for identity, not for a token", async () => {
    mockRequest({ authorization: bearer() });
    const { requireActorForApi } = await import("../lib/session");
    const res = await requireActorForApi().then(
      () => null,
      (e: unknown) => e as Response,
    );
    expect(res?.status).toBe(401);
    const text = await res!.text();
    expect(text).toMatch(/Identity required/);
    expect(text).not.toMatch(/token/i);
  });

  it("getSessionUser() ignores it too", async () => {
    mockRequest({ authorization: bearer(), ...MALLORY_HEADERS });
    const { getSessionUser } = await import("../lib/session");
    expect((await getSessionUser())?.source).toBe("declared");
  });

  it("an SSO viewer still wins over everything else", async () => {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    mockRequest({
      authorization: bearer(),
      "x-auth-request-user": "proxy-1",
      "x-auth-request-email": "bob.b@example.com",
      "x-auth-request-preferred-username": "Bob B",
    });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.source).toBe("proxy");
    expect(user.id).toBe("bob.b@example.com");
  });

  it("a device user is an agent like a declared one for ownerIdFor, never a browser viewer", async () => {
    const { ownerIdFor } = await import("../lib/reminders-view");
    expect(ownerIdFor({ id: MALLORY, email: MALLORY, source: "device" })).toBe(MALLORY);
  });
});
