import { describe, it, expect } from "vitest";
import { redact } from "../lib/redact";

// Credential-shaped fixtures are assembled at runtime; see tests/redact.test.ts.
const PW = ["Sup3r", "Secret!"].join("");
const TOKEN = ["a1B2c3", "D4e5F6g7"].join("");

describe("redact: key=value prose and config (feedback f8942f33)", () => {
  it("leaves a YAML block whose keys mention secrets but hold none", () => {
    const yaml = ["authentication:", "  type: scram-sha-512", "  passwordSecret:", "    secretName: app-user", "    password: password"].join("\n");
    expect(redact(yaml)).toBe(yaml);
  });

  it("does not reach onto the next line for a value", () => {
    expect(redact("token:\nnext line of prose")).toBe("token:\nnext line of prose");
  });

  it("leaves prose with a plain word after the key", () => {
    for (const text of ["Use a scoped token: pull access only", "password: required", "the secret: rotation weekly"]) {
      expect(redact(text)).toBe(text);
    }
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
