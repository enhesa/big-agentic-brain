import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { _resetConfigForTests } from "@/lib/config";

let current: Record<string, string> = {};
vi.mock("next/headers", () => ({ headers: async () => new Headers(current) }));

const KEYS = [
  "BAB_HEADER_USER_ID",
  "BAB_HEADER_EMAIL",
  "BAB_HEADER_NAME",
  "BAB_HEADER_ROLES",
  "BAB_PROXY_SECRET",
  "BAB_TRUST_PROXY_IDENTITY",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  current = {};
  _resetConfigForTests();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetConfigForTests();
  vi.restoreAllMocks();
});

async function who() {
  const { currentUser } = await import("@/lib/user");
  return currentUser();
}

describe("currentUser proxy identity", () => {
  it("reads configured header names", async () => {
    process.env.BAB_HEADER_USER_ID = "X-Custom-Id";
    process.env.BAB_HEADER_EMAIL = "x-custom-mail";
    process.env.BAB_HEADER_ROLES = "x-custom-roles";
    current = { "x-custom-id": "u1", "x-custom-mail": "a@b.co", "x-custom-roles": "admin dev" };
    expect(await who()).toEqual({ id: "u1", email: "a@b.co", name: null, roles: ["admin", "dev"] });
  });

  it("default names are the oauth2-proxy ones", async () => {
    for (const k of KEYS) delete process.env[k];
    for (const k of ["BAB_HEADER_USER_ID", "BAB_HEADER_EMAIL", "BAB_HEADER_NAME", "BAB_HEADER_ROLES"]) {
      delete process.env[k];
    }
    current = {
      "x-auth-request-user": "u2",
      "x-auth-request-email": "c@d.co",
      "x-auth-request-preferred-username": "Cee",
      "x-auth-request-groups": "g1",
    };
    expect(await who()).toEqual({ id: "u2", email: "c@d.co", name: "Cee", roles: ["g1"] });
  });

  it("secret required when set, mismatch gives null and logs nothing containing the header values", async () => {
    process.env.BAB_PROXY_SECRET = "s3cret-value";
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    const id = { "x-auth-request-user": "leaky-id-123", "x-auth-request-email": "leaky@x.co" };

    current = { ...id };
    expect(await who()).toBeNull();
    current = { ...id, "x-bab-proxy-secret": "wrong-secret!" };
    expect(await who()).toBeNull();
    current = { ...id, "x-bab-proxy-secret": "s3cret-valuX" };
    expect(await who()).toBeNull();
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain("leaky");
    expect(logged).not.toContain("wrong-secret");

    current = { ...id, "x-bab-proxy-secret": "s3cret-value" };
    expect((await who())?.id).toBe("leaky-id-123");
  });

  it("no secret configured means the secret header is not needed", async () => {
    current = { "x-auth-request-user": "u3" };
    expect((await who())?.id).toBe("u3");
  });

  it("percent-decoded name", async () => {
    current = { "x-auth-request-user": "u4", "x-auth-request-preferred-username": "Jo%C3%A3o" };
    expect((await who())?.name).toBe("João");
  });

  it("trustProxyHeaders follows BAB_TRUST_PROXY_IDENTITY", async () => {
    const { trustProxyHeaders } = await import("@/lib/session");
    expect(trustProxyHeaders()).toBe(false);
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    _resetConfigForTests();
    expect(trustProxyHeaders()).toBe(true);
  });
});
