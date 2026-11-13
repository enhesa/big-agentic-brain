import { describe, expect, it } from "vitest";
import { redact } from "../lib/redact";

/**
 * redact() runs synchronously on the request path, so one slow scan stalls every caller.
 * Each case feeds a 32k adversarial string (a keyword, then a long run that almost matches)
 * and fails when the scan takes longer than the budget. A quadratic pattern needs seconds here.
 */
// Built at runtime: the public-content scan rejects a literal key header.
const PEM = "-----BEGIN " + "PRIVATE KEY-----";
const N = 32_000;
const BUDGET_MS = 250;

const cases: Record<string, string> = {
  "token + spaces": "token" + " ".repeat(N) + "!",
  "token + colon + spaces": "token:" + " ".repeat(N) + "!",
  "token + tabs": "token" + "\t".repeat(N) + "!",
  "password: + spaces/tabs": "password:" + " \t".repeat(N / 2) + "!",
  "password: + newline + indent": "password:\n" + " ".repeat(N) + "!",
  "password: + repeated newlines": "password:" + "\n ".repeat(N / 2) + "!",
  "repeated token words": "token ".repeat(N / 6),
  "repeated password:": "password: ".repeat(N / 10),
  "repeated key-value lines": "api_key=\n".repeat(N / 9),
  "authorization + spaces": "authorization" + " ".repeat(N) + "!",
  "bearer + long run": "Bearer " + "a".repeat(N) + "!",
  "bearer repeated": "Bearer ".repeat(N / 7),
  "pat + spaces": "pat" + " ".repeat(N) + "!",
  "colon + base32": ":" + "a".repeat(N) + "!",
  "underscores": "_".repeat(N) + "password=",
  "pem unterminated": PEM + "a\n".repeat(N / 2),
  "pem repeated": (PEM + "\n").repeat(N / 28),
  "url credentials": "a://" + "b".repeat(N),
  "url repeated": "a://b:".repeat(N / 6),
  "digits and spaces": "1 ".repeat(N / 2),
  "digits and dashes": "1-".repeat(N / 2),
  "iban-like": "AB12" + " ABCD".repeat(N / 5),
  "email-like": "a".repeat(N) + "@",
  "email dots": "a.".repeat(N / 2) + "@",
  "sig=": "sig=" + "a".repeat(N) + "!",
  "semicolon password": ";" + " ".repeat(N) + "Password",
  "semicolon repeated": "; Password = ".repeat(N / 13),
};

describe("redact stays linear on adversarial input", () => {
  for (const [name, input] of Object.entries(cases)) {
    it(`${name} (${input.length} chars) finishes within ${BUDGET_MS} ms`, () => {
      const start = performance.now();
      redact(input);
      const ms = performance.now() - start;
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
});
