import { describe, it, expect } from "vitest";
import { origin, actorHeaders, ALICE } from "./helpers";

const post = (path: string, body: unknown) =>
  fetch(`${origin()}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("e2e: repeated leading slashes (a bab_url with a trailing slash)", () => {
  it("POST //api/hook answers the same as /api/hook, without a redirect", async () => {
    const body = { hook_event_name: "SessionStart", session_id: "slash-test" };
    const clean = await post("/api/hook", body);
    const slashed = await post("//api/hook", body);
    expect(slashed.status).toBe(200);
    expect(slashed.status).toBe(clean.status);
    expect(await slashed.text()).toBe(await clean.text());
  });

  it("//mcp reaches the MCP route without a redirect", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "ping" };
    const clean = await post("/mcp", body);
    const slashed = await post("//mcp", body);
    expect(slashed.status).toBeLessThan(300);
    expect(slashed.status).toBe(clean.status);
  });

  it("runs of slashes collapse and the query string survives", async () => {
    const res = await fetch(`${origin()}///api//me?x=a//b`, { redirect: "manual", headers: actorHeaders(ALICE) });
    expect(res.status).toBe(200);
  });

  it("//evil.example.com never redirects off-host", async () => {
    for (const p of ["//evil.example.com", "//evil.example.com/", "///evil.example.com/x", "//%2F/evil.example.com"]) {
      const res = await fetch(`${origin()}${p}`, { redirect: "manual" });
      const location = res.headers.get("location");
      // Next may still redirect (trailing slash); it must stay on this host.
      if (location) expect(new URL(location, origin()).origin, p).toBe(new URL(origin()).origin);
      expect(res.status, p).toBeGreaterThanOrEqual(300);
      expect(res.status, p).toBeLessThan(500);
    }
  });
});
