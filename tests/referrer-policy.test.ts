import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Under Referrer-Policy "no-referrer" a browser sends "Origin: null" on a form POST, and every
 * sameOrigin() route (lib/feedback-web.ts) then answers "Cross-site request refused". That broke
 * the connect page's confirm button on bab-test. A page that posts a form to this app must use a
 * policy that still sends its own origin to itself ("same-origin" does, and sends nothing to
 * other sites).
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const root = path.join(process.cwd(), "app");
const files = walk(root).map((f) => ({
  file: path.relative(process.cwd(), f).split(path.sep).join("/"),
  src: readFileSync(f, "utf8"),
}));
const policyOf = (src: string) => /referrer:\s*"([^"]+)"/.exec(src)?.[1] ?? null;

describe("referrer policy on pages that post forms", () => {
  it("no page in app/ sets a policy that makes browsers send Origin: null", () => {
    const bad = files.filter((f) => ["no-referrer", "never"].includes(policyOf(f.src) ?? ""));
    expect(bad.map((f) => f.file)).toEqual([]);
  });

  it("no route or page sends a Referrer-Policy header of no-referrer either", () => {
    const bad = files.filter((f) => /["']Referrer-Policy["']\s*[:,]\s*["']no-referrer["']/i.test(f.src));
    expect(bad.map((f) => f.file)).toEqual([]);
  });

  it("every page that has a POST form and sets a policy uses one of the safe ones", () => {
    const safe = [
      "same-origin",
      "strict-origin-when-cross-origin",
      "origin-when-cross-origin",
      "origin",
      "strict-origin",
      "unsafe-url",
      "no-referrer-when-downgrade",
    ];
    const withForm = files.filter((f) => /method="post"/.test(f.src) && policyOf(f.src));
    for (const f of withForm) expect(safe, f.file).toContain(policyOf(f.src));
  });

  it("the retired connect page posts nothing and sets no policy", () => {
    const connect = files.find((f) => f.file === "app/connect/[nonce]/page.tsx")!;
    expect(connect.src).not.toMatch(/method="post"/);
    expect(policyOf(connect.src)).toBeNull();
  });
});
