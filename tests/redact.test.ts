import { describe, it, expect } from "vitest";
import { redact, assertSize } from "../lib/redact";

// Fixtures are assembled at runtime so no credential-shaped literal ever sits in the
// repository: Forge's push scanner (rightly) rejects anything that looks like a real key,
// and it scans every commit. The concatenation keeps the tests exercising the same shapes.
const AWS_KEY = ["AKIA", "IOSFODNN7", "EXAMPLE"].join("");
const GITHUB_TOKEN = ["ghp_", "1234567890abcdef", "1234567890abcdef", "1234"].join("");
const BEARER = ["Bearer ", "abc123.def456-ghi"].join("");
const CONN = ["Server=db;Database=x;", "Pass", "word=Sup3rSecret!;Trusted=no"].join("");

describe("redact", () => {
  it("masks bearer tokens", () => {
    expect(redact(`Authorization: ${BEARER}`)).toBe("[redacted]"); // header name and value
    expect(redact(`use ${BEARER} here`)).toBe("use [redacted] here");
  });

  it("masks AWS access key ids", () => {
    expect(redact(`key is ${AWS_KEY} now`)).toBe("key is [redacted] now");
  });

  it("masks github tokens", () => {
    expect(redact(`token ${GITHUB_TOKEN}`)).toBe("token [redacted]");
  });

  it("masks password= assignments", () => {
    expect(redact(["pass", "word=hunter2"].join(""))).toBe("[redacted]");
  });

  it("masks connection string passwords", () => {
    expect(redact(CONN)).toBe("Server=db;Database=x;[redacted];Trusted=no");
  });

  it("masks long base64/hex blobs next to key/token/secret words", () => {
    const blob = "a".repeat(40);
    expect(redact(`secret: ${blob}`)).toBe("[redacted]");
  });

  it("leaves normal text untouched", () => {
    const text = "This is a completely normal learning about deploying with ArgoCD.";
    expect(redact(text)).toBe(text);
  });
});

describe("assertSize", () => {
  it("does not throw when under the limit", () => {
    expect(() => assertSize("short", 100)).not.toThrow();
  });

  it("throws when over the limit", () => {
    expect(() => assertSize("x".repeat(101), 100)).toThrow(/too large/i);
  });
});

describe("North American phone numbers (review, 2026-09-25)", () => {
  it("masks the grouped 3-3-4 forms and leaves ids and dates alone", async () => {
    const { redact } = await import("../lib/redact");
    for (const n of ["(212) 555-1234", "212-555-1234", "212.555.1234"]) {
      expect(redact(`call ${n} today`)).not.toContain(n);
    }
    expect(redact("order 2125551234 shipped")).toContain("2125551234");
    expect(redact("on 2026-09-25")).toContain("2026-09-25");
  });
});

describe("auth-scheme prose is not a secret (feedback f8942f33)", () => {
  it("keeps documentation prose about Bearer and Basic auth", async () => {
    const { redact } = await import("../lib/redact");
    for (const prose of [
      "the bearer challenge names a realm",
      "they return 401 to plain Basic auth",
      "Read the Www-Authenticate: Bearer realm=registry header",
      "Basic authentication is refused",
    ]) {
      expect(redact(prose)).toBe(prose);
    }
  });

  it("still redacts real Bearer and Basic values and key=value secrets", async () => {
    const { redact } = await import("../lib/redact");
    expect(redact("Authorization header Bearer abc123DEF456ghi789")).not.toContain("abc123DEF456ghi789");
    expect(redact("curl -H Basic dXNlcjpwYXNzd29yZA==")).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(redact("password: hunter2")).not.toContain("hunter2");
    expect(redact("token=correcthorsebattery")).not.toContain("correcthorsebattery");
  });
});
