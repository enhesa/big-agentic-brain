import { describe, it, expect, afterEach, vi } from "vitest";

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, "");
    else vi.stubEnv(k, v);
  }
  return import("../lib/gate");
}

function req(path: string, init: RequestInit = {}) {
  return new Request("http://bab.test" + path, init);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("gate", () => {
  it("/api/hook bypasses the gate with tokens set (plugin hooks carry no token)", async () => {
    const { gate } = await load({ BAB_API_TOKENS: "secret-one" });
    expect(gate(req("/api/hook", { method: "POST" }))).toBeNull();
    expect(gate(req("/api/learnings"))?.status).toBe(401);
  });

  it("no tokens configured passes", async () => {
    const { gate } = await load({ BAB_API_TOKENS: "", BAB_API_TOKENS_FILE: "" });
    expect(gate(req("/api/learnings"))).toBeNull();
  });

  it("bare token accepted", async () => {
    const { gate } = await load({ BAB_API_TOKENS: "secret-one" });
    expect(gate(req("/api/learnings", { headers: { authorization: "Bearer secret-one" } }))).toBeNull();
  });

  it("token=email pins identity header", async () => {
    const { gate, tokenIdentityFor } = await load({ BAB_API_TOKENS: "t1=alice.example@example.com" });
    const headers = { authorization: "Bearer t1" };
    expect(gate(req("/api/learnings", { headers }))).toBeNull();
    expect(tokenIdentityFor(new Headers(headers))).toBe("alice.example@example.com");
    expect(tokenIdentityFor(new Headers({ authorization: "Bearer nope" }))).toBeNull();
    expect(tokenIdentityFor(new Headers())).toBeNull();
  });

  it("a bare token pins nothing", async () => {
    const { tokenIdentityFor } = await load({ BAB_API_TOKENS: "bare" });
    expect(tokenIdentityFor(new Headers({ authorization: "Bearer bare" }))).toBeNull();
  });

  it("wrong token 401", async () => {
    const { gate } = await load({ BAB_API_TOKENS: "secret-one" });
    for (const headers of [{} as Record<string, string>, { authorization: "Bearer wrong" }, { authorization: "Basic secret-one" }, { authorization: "Bearer secret-on" }]) {
      const res = gate(req("/api/learnings", { headers }));
      expect(res?.status).toBe(401);
      expect(await res?.json()).toEqual({ error: "token required" });
    }
    expect(gate(req("/mcp"))?.status).toBe(401);
  });

  it("public path bypasses", async () => {
    const { gate } = await load({ BAB_API_TOKENS: "secret-one" });
    expect(gate(req("/api"))).toBeNull();
    expect(gate(req("/healthz"))).toBeNull();
    expect(gate(req("/readyz"))).toBeNull();
    expect(gate(req("/instructions/skill.md"))).toBeNull();
    expect(gate(req("/api/events"))).toBeNull();
    expect(gate(req("/api/learnings"))?.status).toBe(401);
  });

  it("oversize content-length 413", async () => {
    const { gate } = await load({ BAB_API_TOKENS: "", BAB_MAX_BODY_BYTES: "100" });
    const res = gate(req("/api/learnings", { method: "POST", headers: { "content-length": "101" } }));
    expect(res?.status).toBe(413);
    expect(gate(req("/api/learnings", { method: "POST", headers: { "content-length": "100" } }))).toBeNull();
  });

  it("/api/hook is exempt from the content-length cap", async () => {
    const { gate } = await load({ BAB_API_TOKENS: "", BAB_MAX_BODY_BYTES: "100" });
    expect(gate(req("/api/hook", { method: "POST", headers: { "content-length": "5000" } }))).toBeNull();
    expect(gate(req("/api/hook/", { method: "POST", headers: { "content-length": "5000" } }))).toBeNull();
    expect(gate(req("/api/hook/x", { method: "POST", headers: { "content-length": "5000" } }))?.status).toBe(413);
  });
});
