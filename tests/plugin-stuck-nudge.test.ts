import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ERROR_NAME_RE, FAILURE_IN_OUTPUT_RE, isReadOnlyCommand, stuckKey } from "../plugins/claude-code/hooks/stuck-nudge";

describe("failure in output", () => {
  it.each([
    "Tests: 12 passed, 0 FAILED",
    "Tests:       0 failed, 12 passed, 12 total",
    " Tests  0 failed | 4 passed (4)",
    "FAIL_FAST=true",
    'if (status === "FAILED") retry()',
    "grep: exit code 1 means no match",
    "# fail 0",
    "# pass 12",
    "ok 1 - adds numbers",
    "export const FAILED = 'x'",
    "the build passed with no errors",
    "Compiled successfully",
  ])("ignores %j", (line) => expect(FAILURE_IN_OUTPUT_RE.test(line)).toBe(false));

  it.each([
    "not ok 3 - parses the header",
    "# fail 2",
    "FAIL src/ledger.test.ts",
    " FAIL  tests/ledger.test.ts > ledger > sums",
    "--- FAIL: TestLedger (0.01s)",
    "FAIL\texample.com/acme/ledger\t0.12s",
    "FAILED tests/test_ledger.py::test_sum - AssertionError",
    "Tests:       1 failed, 11 passed, 12 total",
    " Tests  2 failed | 3 passed (5)",
    "======= 1 failed, 2 passed in 0.12s =======",
    "  2 failing",
    "npm ERR! code ELIFECYCLE",
    "npm error code ELIFECYCLE",
    "TypeError: Cannot read properties of undefined",
    "src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
    "error[E0425]: cannot find value `x` in this scope",
    "Command failed with exit code 1.",
    "Process exited with code 2",
    "make: *** [Makefile:4: build] Error 2",
    "Build failed with 3 errors",
    "bash: pnpx: command not found",
    "zsh: command not found: pnpx",
    "/usr/bin/bash: line 1: pnpx: command not found",
  ])("matches %j", (line) => expect(FAILURE_IN_OUTPUT_RE.test(line)).toBe(true));

  it("finds a failure line inside longer output", () => {
    expect(FAILURE_IN_OUTPUT_RE.test("> vitest run\n\n FAIL  tests/a.test.ts\nmore output")).toBe(true);
  });
});

describe("error name", () => {
  it.each([
    ["LedgerSyncError: out of step", "LedgerSyncError"],
    ["TypeError: x is undefined", "TypeError"],
    ["error TS2304: Cannot find name", "error TS2304"],
    ["Error: listen EADDRINUSE: address already in use", "EADDRINUSE"],
    ["npm ERR! code E404", "E404"],
    ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package", "ERR_MODULE_NOT_FOUND"],
    ["open x: ENOENT", "ENOENT"],
  ])("names %j", (text, name) => expect(ERROR_NAME_RE.exec(text)?.[1]).toBe(name));

  it.each(["EXPORT PATH=/x ENABLED", "EOF reached", "ECHO is on", "EXIT 0"])("does not take %j for an error name", (text) => {
    expect(ERROR_NAME_RE.exec(text)).toBeNull();
  });
});

describe("read-only commands", () => {
  it.each([
    "grep -rn FAIL tests",
    "cat build.log | grep -i failed",
    "rg 'exit code [1-9]' plugins",
    "git log --oneline -5",
    "git -C repo diff | head -40",
    "cd tests && ls",
    "LC_ALL=C sort out.txt | uniq -c",
    "sed -n 1,20p a.ts",
    "find . -name '*.log'",
  ])("skips %j", (command) => expect(isReadOnlyCommand(command)).toBe(true));

  it.each([
    "npm test 2>&1 | head -60",
    "pnpm vitest run | tail -20",
    "cd app && pnpm build",
    "git commit -m x",
    "git push",
    "sed -i 's/a/b/' a.ts",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} ;",
    "node scripts/run.mjs | grep FAIL",
    "",
  ])("does not skip %j", (command) => expect(isReadOnlyCommand(command)).toBe(false));
});

describe("stuckKey", () => {
  it("stays quiet for a grep that found nothing", () => {
    expect(stuckKey("grep -rn FAIL_FAST src", "", true)).toBeNull();
  });

  it("stays quiet for output that only quotes a failure", () => {
    expect(stuckKey("cat src/status.ts", 'if (status === "FAILED") retry()\nFAIL_FAST=true', false)).toBeNull();
    expect(stuckKey("npm test", "Tests:       0 failed, 12 passed, 12 total", false)).toBeNull();
  });

  it("stays quiet for a refused or interrupted command", () => {
    expect(stuckKey("rm -rf build", "This command requires approval", true)).toBeNull();
    expect(stuckKey("pnpm build", "Interrupted by user", true)).toBeNull();
  });

  it("names a piped test failure by its error", () => {
    expect(stuckKey("npm test 2>&1 | head -60", " FAIL  tests/a.test.ts\nTypeError: x is undefined", false)).toBe("TypeError");
  });

  it("falls back to the command when the output names no error", () => {
    expect(stuckKey("pnpm build", "EXPORT PATH=/x ENABLED\nBuild failed with 2 errors", false)).toBe("pnpm build");
    expect(stuckKey("make deploy", "something broke", true)).toBe("make deploy");
  });
});

describe("source", () => {
  it("holds no control characters, so every \\b stays a word boundary", () => {
    for (const file of ["plugins/claude-code/hooks/stuck-nudge.ts", "plugins/claude-code/hooks/register.tsx", "plugins/claude-code/hooks/poll-backoff.ts"]) {
      // eslint-disable-next-line no-control-regex
      expect(readFileSync(file, "utf8")).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    }
  });
});
