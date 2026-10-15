import { describe, it, expect } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { isPublicPath } from "../lib/public-paths";

const IDENTITY_HELPERS = ["requireActorForApi", "getSessionUser", "requireUser", "currentUser", "pendingProxyLinkUser", "getViewer"];

/**
 * Routes and pages that deliberately resolve no identity. Each needs a one-line reason; a new
 * route with neither an identity helper nor an entry here fails this test.
 */
const ANONYMOUS_OK: Record<string, string> = {
  "/": "public landing page, static marketing content",
  "/api/:slug*": "catch-all for unknown /api paths, answers 404 { error } to everyone and reads nothing",
  "/board": "redirect to /memory, reads nothing",
  "/board/:id": "redirect to /memory/:id, reads nothing",
  "/connect/:nonce": "retired link, static explanation, reads nothing",
  "/handoff/:threadId": "redirect to /inbox, which decides who may see the thread",
  "/instructions": "agent-facing instructions document, no user data (public on the reverse proxy)",
  "/inbox/manifest": "web app manifest: names and icons only, fetched without credentials by the browser",
  "/me/devices/claim": "identity is the SSO viewer, resolved with currentUser inside lib/devices-web.ts",
  "/me/devices/unlink": "identity is the SSO viewer, resolved with currentUser inside lib/unlink-own-web.ts",
};

function urlPath(file: string): string {
  const p = file
    .replace(/^app/, "")
    .replace(/\/(route\.ts|page\.tsx)$/, "")
    .replace(/\/\([^/]+\)/g, "")
    .replace(/\[\.\.\.(\w+)\]/g, ":$1*")
    .replace(/\[(\w+)\]/g, ":$1");
  return p === "" ? "/" : p;
}

function staticPrefix(p: string): string {
  const i = p.indexOf("/:");
  return i < 0 ? p : p.slice(0, i + 1);
}

describe("route inventory", () => {
  const files = [...globSync("app/**/route.ts"), ...globSync("app/**/page.tsx")].map((f) => f.split(sep).join("/")).sort();

  it("finds the routes", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s resolves an identity, is public, or is listed as anonymous", (file) => {
    const src = readFileSync(file, "utf8");
    const url = urlPath(file);
    const usesHelper = IDENTITY_HELPERS.some((h) => new RegExp(`\\b${h}\\b`).test(src));
    const ok = usesHelper || isPublicPath(staticPrefix(url)) || url in ANONYMOUS_OK;
    expect(ok, `${file} (${url}) has no identity helper, is not public and is not in ANONYMOUS_OK`).toBe(true);
  });

  it("ANONYMOUS_OK has no stale entries", () => {
    const urls = new Set(files.map(urlPath));
    for (const u of Object.keys(ANONYMOUS_OK)) expect(urls.has(u), u).toBe(true);
  });
});
