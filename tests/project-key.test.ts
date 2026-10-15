import { describe, it, expect, afterEach } from "vitest";
import { normalizeProjectKey } from "../lib/project-key";
import { _resetConfigForTests } from "../lib/config";

describe("project key prefixes", () => {
  const saved = process.env.BAB_PROJECT_KEY_PREFIXES;
  afterEach(() => {
    if (saved === undefined) delete process.env.BAB_PROJECT_KEY_PREFIXES;
    else process.env.BAB_PROJECT_KEY_PREFIXES = saved;
    _resetConfigForTests();
  });

  it("project key strips configured prefixes only", () => {
    process.env.BAB_PROJECT_KEY_PREFIXES = "acme.";
    _resetConfigForTests();
    expect(normalizeProjectKey("acme.bab")).toBe("bab");
    expect(normalizeProjectKey("other.bab")).toBe("other.bab");
  });

  it("strips the Acme prefixes under the default test env", () => {
    expect(normalizeProjectKey("acmecorp.bab")).toBe("bab");
  });
});
