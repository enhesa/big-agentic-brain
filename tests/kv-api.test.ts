import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionUser } from "../lib/session";

let dataDir: string;
const OWNER = "owner.one@example.com";
const OTHER = "other.two@example.com";
let headers: Record<string, string> = {};

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-kv-api-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  headers = {};
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(headers) }));
  (await import("../lib/kv"))._resetKvForTests();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
  upsertUser({ id: OTHER, email: OTHER, name: "Other Two", roles: [] });
});

afterEach(async () => {
  (await import("../lib/kv"))._resetKvForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_API_TOKENS;
  for (const k of Object.keys(process.env)) if (k.startsWith("BAB_KV") || k === "BAB_REPLICAS") delete process.env[k];
  (await import("../lib/config"))._resetConfigForTests();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

const declared = (email: string) => ({ "x-bab-actor-email": email, "x-bab-actor-name": "Some One" });

/** Sets a setting and drops the cached config, so the next call reads it. */
async function env(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  (await import("../lib/config"))._resetConfigForTests();
}

async function route() {
  return import("../app/api/kv/route");
}

function post(body: unknown, extra: Record<string, string> = {}) {
  return new Request("http://x/api/kv", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...extra } });
}

describe("/api/kv identity", () => {
  it("401s without an identity", async () => {
    const { GET, POST } = await route();
    expect((await GET(new Request("http://x/api/kv?key=a"))).status).toBe(401);
    expect((await POST(post({ action: "get", key: "a" }))).status).toBe(401);
  });

  it("refuses a caller identified only by X-Bab-Actor-* headers, on every action", async () => {
    headers = declared(OWNER);
    const { GET, POST } = await route();
    const res = await GET(new Request("http://x/api/kv?key=a"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/key-value store needs an identity BAB remembers or checks.*Install the BAB plugin/);
    expect((await GET(new Request("http://x/api/kv"))).status).toBe(403);
    for (const action of ["get", "set", "cas", "incr", "delete", "list", "throttle", "lock", "unlock", "renew"]) {
      expect((await POST(post({ action, key: "a", value: 1, ttlSeconds: 5 }))).status, action).toBe(403);
    }
  });

  it("never takes the owner from the body or the query", async () => {
    await env("BAB_KV_ALLOW_DECLARED", "1");
    headers = declared(OTHER);
    const { GET, POST } = await route();
    const res = await POST(post({ action: "set", key: `u/${OWNER}/a`, value: 1, ttlSeconds: 5, actor: OWNER, ownerId: OWNER }));
    expect(res.status).toBe(403);
    expect((await GET(new Request(`http://x/api/kv?key=u/${OWNER}/a&actor=${OWNER}`))).status).toBe(403);
  });

  it("serves a caller whose token is bound to them, and keeps their keys from others", async () => {
    await env("BAB_API_TOKENS", "owner-t0ken-for-tests=" + OWNER + "\nother-t0ken-for-tests=" + OTHER);
    const auth = { authorization: "Bearer owner-t0ken-for-tests" };
    headers = auth;
    const { GET, POST } = await route();
    const set = await POST(post({ action: "set", key: "plan", value: { step: 2 }, ttlSeconds: 60 }, auth));
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ key: `u/${OWNER}/plan`, set: true });
    expect(await (await GET(new Request("http://x/api/kv?key=plan", { headers: auth }))).json()).toMatchObject({ found: true, value: { step: 2 } });
    expect((await (await GET(new Request("http://x/api/kv", { headers: auth }))).json()).keys).toHaveLength(1);

    const other = { authorization: "Bearer other-t0ken-for-tests" };
    headers = other;
    expect(await (await GET(new Request("http://x/api/kv?key=plan", { headers: other }))).json()).toMatchObject({ key: `u/${OTHER}/plan`, found: false });
    expect((await GET(new Request(`http://x/api/kv?key=u/${OWNER}/plan`, { headers: other }))).status).toBe(403);
    expect((await GET(new Request(`http://x/api/kv?prefix=u/${OWNER}/`, { headers: other }))).status).toBe(403);
  });

  it("refuses a header that claims a token-bound address without its token", async () => {
    await env("BAB_API_TOKENS", "owner-t0ken-for-tests=" + OWNER);
    await env("BAB_KV_ALLOW_DECLARED", "1");
    headers = { ...declared(OWNER), authorization: "Bearer owner-t0ken-for-tests-wrong" };
    const { GET } = await route();
    expect((await GET(new Request("http://x/api/kv?key=a"))).status).toBe(401);
  });

  it("runs the gate inside the route, not only through the proxy", async () => {
    await env("BAB_API_TOKENS", "t0ken-for-tests-only");
    await env("BAB_KV_ALLOW_DECLARED", "1");
    headers = declared(OWNER);
    const { GET, POST } = await route();
    expect((await GET(new Request("http://x/api/kv?key=a"))).status).toBe(401);
    expect((await POST(post({ action: "get", key: "a" }))).status).toBe(401);
    const big = "x".repeat(2 * 1024 * 1024);
    expect((await POST(post(big, { "content-length": String(big.length), authorization: "Bearer t0ken-for-tests-only" }))).status).toBe(413);
  });

  it("answers 404 when switched off and 503 with more than one replica", async () => {
    await env("BAB_KV_ALLOW_DECLARED", "1");
    headers = declared(OWNER);
    await env("BAB_KV", "off");
    const { GET } = await route();
    expect((await GET(new Request("http://x/api/kv?key=a"))).status).toBe(404);
    await env("BAB_KV", undefined);
    await env("BAB_REPLICAS", "3");
    (await import("../lib/config"))._resetConfigForTests();
    const res = await GET(new Request("http://x/api/kv?key=a"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/BAB_REPLICAS is 3/);
  });
});

describe("/api/kv actions", () => {
  beforeEach(async () => {
    await env("BAB_KV_ALLOW_DECLARED", "1");
    headers = declared(OWNER);
  });

  it("maps refusals to their status codes", async () => {
    const { POST } = await route();
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post([1, 2]))).status).toBe(400);
    expect((await POST(post({ key: "a" }))).status).toBe(400);
    expect((await POST(post({ action: "set", key: "a", value: 1 }))).status).toBe(400);
    expect((await POST(post({ action: "set", key: "shared/nope/a", value: 1, ttlSeconds: 5 }))).status).toBe(403);
    expect((await POST(post({ action: "lock", key: "l", ttlSeconds: 5 }))).status).toBe(200);
    const conflict = await POST(post({ action: "set", key: "l", value: 1, ttlSeconds: 5 }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: expect.stringMatching(/holds a lock/) });
  });

  it("throttles one person at 20 calls at once, then one a second", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-29T10:00:00Z") });
    try {
      const { POST } = await route();
      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) statuses.push((await POST(post({ action: "get", key: "a" }))).status);
      expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
      const over = await POST(post({ action: "get", key: "a" }));
      expect(over.status).toBe(429);
      expect((await over.json()).error).toMatch(/at most 60 a minute, 20 at once/);
      vi.advanceTimersByTime(1000);
      expect((await POST(post({ action: "get", key: "a" }))).status).toBe(200);
      expect((await POST(post({ action: "get", key: "a" }))).status).toBe(429);
      // Someone else has a bucket of their own.
      headers = declared(OTHER);
      expect((await POST(post({ action: "get", key: "a" }))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("bab_kv tool", () => {
  const me: SessionUser = { id: OWNER, email: OWNER, name: "Owner One", roles: [], source: "device" };
  const them: SessionUser = { id: OTHER, email: OTHER, name: "Other Two", roles: [], source: "device" };

  async function tool() {
    const { findTool } = await import("../lib/mcp");
    const t = findTool("bab_kv")!;
    return async (actor: SessionUser, args: Record<string, unknown>) => JSON.parse(await t.run(actor, args, { origin: "https://bab.example.com" } as never));
  }

  it("states the content rule, the limits and the shared namespaces in its description", async () => {
    const { findTool } = await import("../lib/mcp");
    const d = findTool("bab_kv")!.description;
    expect(d).toContain("Never store secrets, credentials or personal data");
    expect(d).toContain("short-lived coordination state only");
    expect(d).toContain("shared/bitbucket-push/");
    expect(d).toContain("86400");
    expect(d).toContain("64 KB");
    expect(d).not.toMatch(/—/);
  });

  it("runs a lock and a throttle between two people", async () => {
    const run = await tool();
    const lock = await run(me, { action: "lock", key: "shared/bitbucket-push/repo", ttlSeconds: 30 });
    expect(lock.acquired).toBe(true);
    expect(await run(them, { action: "lock", key: "shared/bitbucket-push/repo", ttlSeconds: 30 })).toMatchObject({ acquired: false, holder: OWNER });
    expect((await run(me, { action: "unlock", key: "shared/bitbucket-push/repo", token: lock.token })).released).toBe(true);
    expect((await run(them, { action: "throttle", key: "shared/bitbucket-push/pr", minIntervalSeconds: 20 })).waitSeconds).toBe(0);
    expect((await run(me, { action: "throttle", key: "shared/bitbucket-push/pr", minIntervalSeconds: 20 })).waitSeconds).toBeGreaterThan(19);
  });

  it("refuses a header-only or connection-only caller, with the bab_identify hint for a connection", async () => {
    const { findTool } = await import("../lib/mcp");
    const t = findTool("bab_kv")!;
    expect(() => t.run({ ...me, source: "declared" }, { action: "get", key: "a" })).toThrow(/Install the BAB plugin/);
    expect(() => t.run({ ...me, source: "connection" }, { action: "get", key: "a" })).toThrow(/call bab_identify once/);
    expect(() => t.run({ ...me, source: "declared", tokenBound: true }, { action: "get", key: "a" })).not.toThrow();
    expect(() => t.run({ ...me, source: "proxy" }, { action: "get", key: "a" })).not.toThrow();
    try {
      t.run({ ...me, source: "connection" }, { action: "get", key: "a" });
    } catch (e) {
      expect((e as { status: number }).status).toBe(403);
    }
  });

  it("is in the full tool list and not the lean one", async () => {
    const { toolsFor } = await import("../lib/mcp");
    expect(toolsFor("full").map((t) => t.name)).toContain("bab_kv");
    expect(toolsFor("lean").map((t) => t.name)).not.toContain("bab_kv");
  });
});
