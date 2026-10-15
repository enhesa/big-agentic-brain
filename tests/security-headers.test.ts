import { describe, it, expect } from "vitest";
import config from "../next.config";

/**
 * Clickjacking (security review round 3): the connect page's confirm button is a state-changing
 * POST behind the viewer's SSO session, so no other site may frame any BAB page. Sent on every
 * path; /mcp and /api are JSON and indifferent to frame headers.
 */
describe("next.config headers", () => {
  it("sends frame-ancestors 'none' and X-Frame-Options DENY on every path", async () => {
    const rules = await config.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeTruthy();
    const byKey = Object.fromEntries(all!.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(byKey["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(byKey["x-frame-options"]).toBe("DENY");
  });

  it("sends nosniff, a strict referrer policy and a locked-down permissions policy on every path", async () => {
    const rules = await config.headers!();
    const all = rules.find((r) => r.source === "/:path*");
    const byKey = Object.fromEntries(all!.headers.map((h) => [h.key.toLowerCase(), h.value]));
    expect(byKey["x-content-type-options"]).toBe("nosniff");
    expect(byKey["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("sets no script or style CSP (Next inline styles would break): only frame-ancestors", async () => {
    const rules = await config.headers!();
    const csp = rules.flatMap((r) => r.headers).filter((h) => h.key.toLowerCase() === "content-security-policy");
    expect(csp.map((h) => h.value)).toEqual(["frame-ancestors 'none'"]);
  });

  it("keeps the service worker's no-cache rule", async () => {
    const rules = await config.headers!();
    const sw = rules.find((r) => r.source === "/sw.js");
    expect(sw?.headers).toEqual([{ key: "Cache-Control", value: "no-cache" }]);
  });

  it("does not narrow the frame rule to some paths (no other rule sets frame headers)", async () => {
    const rules = await config.headers!();
    const framing = rules.filter((r) => r.headers.some((h) => /frame/i.test(h.key) || /frame-ancestors/i.test(h.value)));
    expect(framing.map((r) => r.source)).toEqual(["/:path*"]);
  });
});
