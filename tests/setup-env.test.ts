import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACME_ENV } from "./setup-env";
import { _resetConfigForTests, config } from "@/lib/config";

const saved = { ...process.env };

beforeEach(() => {
  _resetConfigForTests();
  Object.assign(process.env, ACME_ENV);
});
afterEach(() => {
  for (const k of Object.keys(ACME_ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetConfigForTests();
});

describe("ACME_ENV identity patterns", () => {
  it("keeps the regex escapes literal", () => {
    expect(ACME_ENV.BAB_IDENTITY_EMAIL_PATTERN).toContain("\\.com$");
    expect(ACME_ENV.BAB_IDENTITY_ALIAS_PATTERN).toBe("^[a-z0-9._%+-]+@example\\.com$");
  });

  it("long form matches both, short alias only the alias pattern, lookalikes neither", () => {
    const { emailPattern, aliasPattern } = config().identity;
    expect(emailPattern.test("first.last@example.com")).toBe(true);
    expect(aliasPattern!.test("first.last@example.com")).toBe(true);
    expect(emailPattern.test("aexample@example.com")).toBe(false);
    expect(aliasPattern!.test("aexample@example.com")).toBe(true);
    for (const bad of ["first.last@examplexcom", "x@gmail.com"]) {
      expect(emailPattern.test(bad)).toBe(false);
      expect(aliasPattern!.test(bad)).toBe(false);
    }
  });
});
