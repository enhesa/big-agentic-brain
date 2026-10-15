import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _resetConfigForTests } from "@/lib/config";
import { identityDomain, identityHint, identityRejectionText, isAliasEmail, isValidIdentityEmail } from "@/lib/identity";

const KEYS = ["DATA_DIR", "BAB_IDENTITY_EMAIL_PATTERN", "BAB_IDENTITY_ALIAS_PATTERN", "BAB_IDENTITY_HINT", "BAB_ALLOWED_EMAILS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  _resetConfigForTests();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetConfigForTests();
});

describe("with the Acme pattern (setup-env)", () => {
  it("accepts the long form", () => {
    expect(isValidIdentityEmail("alice.example@example.com")).toBe(true);
    expect(isAliasEmail("alice.example@example.com")).toBe(false);
  });
  it("treats the short address as an alias", () => {
    expect(isValidIdentityEmail("aexample@example.com")).toBe(false);
    expect(isAliasEmail("aexample@example.com")).toBe(true);
  });
  it("rejects other domains", () => {
    expect(isValidIdentityEmail("someone@other.com")).toBe(false);
    expect(isAliasEmail("someone@other.com")).toBe(false);
  });
  it("words the rejections from the hint", () => {
    expect(identityHint()).toBe("first.last@example.com");
    expect(identityRejectionText("aexample@example.com")).toBe(
      "Use your long address in the form first.last@example.com (not the short alias)",
    );
    expect(identityRejectionText("someone@other.com")).toBe("email must be an address in the form first.last@example.com");
  });
});

describe("with the neutral default", () => {
  beforeEach(() => {
    delete process.env.BAB_IDENTITY_EMAIL_PATTERN;
    delete process.env.BAB_IDENTITY_ALIAS_PATTERN;
    delete process.env.BAB_IDENTITY_HINT;
    _resetConfigForTests();
  });
  it("accepts any well-formed address", () => {
    expect(isValidIdentityEmail("someone@other.com")).toBe(true);
    expect(isAliasEmail("someone@other.com")).toBe(false);
    expect(isValidIdentityEmail("not an email")).toBe(false);
  });
  it("names the neutral hint", () => {
    expect(identityRejectionText("nope")).toBe("email must be an address in the form you@example.com");
  });
  it("applies BAB_ALLOWED_EMAILS as an extra check, case-insensitively", () => {
    process.env.BAB_ALLOWED_EMAILS = "A@x.com";
    _resetConfigForTests();
    expect(isValidIdentityEmail("a@x.com")).toBe(true);
    expect(isValidIdentityEmail("A@X.com")).toBe(true);
    expect(isValidIdentityEmail("b@x.com")).toBe(false);
  });
});

describe("allow-list with the Acme pattern", () => {
  it("accepts a listed email and rejects an unlisted valid-shape one", () => {
    process.env.BAB_ALLOWED_EMAILS = "Alice.Example@example.com";
    _resetConfigForTests();
    expect(isValidIdentityEmail("alice.example@example.com")).toBe(true);
    expect(isValidIdentityEmail("anna.smith@example.com")).toBe(false);
    expect(identityRejectionText("anna.smith@example.com")).toBe("email is not on the allowed list");
    expect(identityRejectionText("someone@other.com")).toBe("email must be an address in the form first.last@example.com");
  });
});

describe("edge cases", () => {
  it("an address matching both patterns is not an alias", () => {
    expect(isAliasEmail("alice.example@example.com")).toBe(false);
  });
  it("a hint without @ gives an empty domain and nothing throws", () => {
    process.env.BAB_IDENTITY_HINT = "first.last";
    _resetConfigForTests();
    expect(identityDomain()).toBe("");
    expect(identityRejectionText("x")).toBe("email must be an address in the form first.last");
    expect(isValidIdentityEmail("x@y.com")).toBe(false);
  });
});

describe("proxy-links alias matching with another domain", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "bab-identity-pattern-"));
    process.env.DATA_DIR = dataDir;
    process.env.BAB_IDENTITY_EMAIL_PATTERN = String.raw`^[a-z]+\.[a-z]+@acme\.example$`;
    process.env.BAB_IDENTITY_ALIAS_PATTERN = String.raw`^[a-z0-9._%+-]+@acme\.example$`;
    process.env.BAB_IDENTITY_HINT = "first.last@acme.example";
    _resetConfigForTests();
  });
  afterEach(async () => {
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    rmSync(dataDir, { recursive: true, force: true });
  });
  it("suggests the long-form user for an alias on the hint domain only", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "alice.example@acme.example", email: "alice.example@acme.example", name: null, roles: [] });
    const { suggestLinkFor } = await import("../lib/proxy-links");
    expect(suggestLinkFor("oid-1", "aexample@acme.example", "Alice Example")?.email).toBe("alice.example@acme.example");
    expect(suggestLinkFor("oid-1", "aexample@example.com", "Alice Example")).toBeNull();
  });
});
