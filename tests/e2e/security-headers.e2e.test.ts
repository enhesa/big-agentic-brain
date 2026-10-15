import { describe, it, expect } from "vitest";
import { api, origin } from "./helpers";

/** The built server really sends the frame headers: on pages, on the connect page, on /api and /mcp. */
describe("e2e: nobody can frame BAB", () => {
  const paths = ["/", "/changelog", "/connect/not-a-real-nonce", "/me/devices", "/api", "/healthz"];

  it.each(paths)("%s refuses framing", async (p) => {
    const res = await fetch(`${origin()}${p}`);
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("POST /mcp answers normally and carries the headers too", async () => {
    const res = await api("/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect((await res.json()).result.tools.length).toBeGreaterThan(0);
  });
});
