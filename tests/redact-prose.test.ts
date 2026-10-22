import { describe, it, expect } from "vitest";
import { redact } from "../lib/redact";

// Credential-shaped fixtures are assembled at runtime; see tests/redact.test.ts.
const PW = ["Sup3r", "Secret!"].join("");
const TOKEN = ["a1B2c3", "D4e5F6g7"].join("");

describe("redact: key=value prose and config (feedback f8942f33)", () => {
  it("leaves a YAML block whose keys mention secrets but whose values are keys", () => {
    const yaml = ["authentication:", "  type: scram-sha-512", "  passwordSecret:", "    secretName: app-user", "    key: password"].join("\n");
    expect(redact(yaml)).toBe(yaml);
  });

  it("does not take an unindented next line as the value", () => {
    expect(redact("Use this token:\nnext line of prose")).toBe("Use this token:\nnext line of prose");
  });

  it("leaves prose where the key sits mid-sentence and the sentence goes on", () => {
    for (const text of ["Use a scoped token: pull access only", "Rotate the secret: weekly or sooner", "with a password: required for writes"]) {
      expect(redact(text)).toBe(text);
    }
  });

  it("still masks plain lowercase defaults in config and at the end of a line", () => {
    for (const text of ["password: changeme", "  password: postgres", "secret: mysupersecret", "password: kettle-abrupt-fan", "the db password: postgres"]) {
      expect(redact(text), text).not.toContain(text.split(": ")[1]);
    }
    expect(redact("postgres:\n  password: postgres")).toBe("postgres:\n  [redacted]");
  });

  it("masks a YAML value on the next, indented line", () => {
    expect(redact(`password:\n  ${PW}`)).toBe("[redacted]");
  });

  it("keeps masking after = even when the value contains a colon", () => {
    expect(redact("token=abc: def")).toBe("[redacted] def");
  });

  it("still masks real values", () => {
    expect(redact(`password: ${PW}`)).toBe("[redacted]");
    expect(redact(`token: ${TOKEN}`)).toBe("[redacted]");
    expect(redact("password=hunter")).toBe("[redacted]");
    expect(redact("DB_PASSWORD: hunter")).toBe("[redacted]");
    expect(redact(`  password: "${PW}"`)).toBe("  [redacted]");
    expect(redact(`"client_secret": "${TOKEN}"`)).toBe("[redacted]");
  });
});

describe("redact: documentation placeholders survive (BAB feedback)", () => {
  it("keeps values in angle brackets", () => {
    for (const text of ["token=<address>", "Authorization: Bearer <token>", "password: <your-password>", "api-key=<key>", 'secret = "<value>"']) {
      expect(redact(text), text).toBe(text);
    }
  });

  it("keeps the bare words token, secret, password and xxx as a value", () => {
    for (const text of ["token=xxx", "secret: secret", "password=password", "Authorization: Bearer token", "apikey=XXX", "the db password: xxx"]) {
      expect(redact(text), text).toBe(text);
    }
  });

  it("keeps a maintainer comment that holds placeholders", () => {
    const text = "Set token=<address> and send Authorization: Bearer <token> with each call.";
    expect(redact(text)).toBe(text);
  });

  it("still masks real-looking values next to the same labels", () => {
    const random = ["abc123", "XYZ789qwe", "RTY456uio"].join("");
    expect(redact(`Authorization: Bearer ${random}`)).not.toContain(random);
    expect(redact(`Authorization: Bearer ${random}`)).toContain("[redacted]");
    const key = ["sk-", "proj1234567890abcdefghij"].join("");
    expect(redact(`token=${key}`)).toBe("[redacted]");
    expect(redact(`token=${key}`)).not.toContain(key);
    expect(redact("password=<tmp>x")).not.toBe("password=<tmp>x");
    expect(redact("token=tokens123")).not.toContain("tokens123");
  });
});
