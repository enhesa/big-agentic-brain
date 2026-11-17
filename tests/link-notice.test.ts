import { describe, it, expect } from "vitest";
import { DEFAULT_RETURN, safeReturnPath, withClaimCode } from "@/lib/link-notice";

/**
 * The link card's return path. The claim route redirects to `${origin}${path}`, so anything that
 * is not a plain same-origin path (a second slash, a backslash, user info, a scheme) must fall back.
 */
describe("safeReturnPath", () => {
  it("keeps the plain paths the link card sends", () => {
    for (const p of ["/inbox", "/reminders", "/feedback/new", "/me/devices", "/memory/abc-12", "/memory/a%20b"]) {
      expect(safeReturnPath(p)).toBe(p);
    }
  });

  it("falls back for anything that could leave the site or is not a plain path", () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      "",
      "inbox",
      "//evil.example.test",
      "/\\evil.example.test",
      "\\\\evil.example.test",
      "@evil.example.test",
      ".evil.example.test",
      "https://evil.example.test/inbox",
      "javascript:alert(1)",
      "/inbox?claim=x",
      "/inbox#top",
      "/a/../b",
      "/%2e%2e/b",
      "/inbox\n/x",
      "/inbox\t",
      `/${"a".repeat(600)}`,
    ];
    for (const p of bad) expect(safeReturnPath(p), String(p)).toBe(DEFAULT_RETURN);
  });
});

describe("withClaimCode", () => {
  it("adds the code as a query parameter on a safe path", () => {
    expect(withClaimCode("/inbox", "mismatch")).toBe("/inbox?claim=mismatch");
    expect(withClaimCode("//evil.example.test", "taken")).toBe("/me/devices?claim=taken");
  });
});
