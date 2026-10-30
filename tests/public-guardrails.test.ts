import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** The public-repository rules in CLAUDE.md and AGENTS.md, and scripts/check-public-content.sh. */

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "check-public-content.sh");

function section(file: string): string {
  const text = readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf("## Public repository");
  expect(start, `${file} has a Public repository section`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next).trim();
}

function scan(mode: "--text" | "--commit-messages", input: string) {
  return spawnSync("bash", [SCRIPT, mode], { input, encoding: "utf8" });
}

// Built at runtime so this file itself passes the scan.
const at = "@";
const dot = ".";

describe("public repository guardrails", () => {
  it("keeps the Public repository section identical in CLAUDE.md and AGENTS.md", () => {
    expect(section("AGENTS.md")).toBe(section("CLAUDE.md"));
  });

  it("names the scan and a pre-PR checklist in the rules", () => {
    const rules = section("CLAUDE.md");
    expect(rules).toContain("pnpm check:public");
    expect(rules).toContain("### Before you open a pull request");
  });

  it("passes plain text with reserved placeholders", () => {
    const r = scan("--text", `Tighten the docs\nAsk user${at}example${dot}com, call 192${dot}0.2.10, see KEY-1.\n`);
    expect(r.stdout + r.stderr).toContain("clean");
    expect(r.status).toBe(0);
  });

  it.each([
    ["email", `mail jane${at}acmecorp${dot}io`],
    ["host", `db at pg${dot}prod${dot}internal`],
    ["host", `api${dot}ns${dot}svc${dot}cluster${dot}local`],
    ["ip", `node 10${dot}1.2.3`],
    ["ip", `node 172${dot}20.0.5`],
    ["ip", `node 192${dot}168.1.10`],
    ["url", `https://acme${dot}atlassian${dot}net/x`],
    ["url", `https://teams${dot}microsoft${dot}com/l/x`],
    ["ticket", `see ji${"ra"} ABC-77`],
    ["ticket", `fi${"x"}(ABC-123): thing`],
    ["secret", `token gh${"p"}_${"a".repeat(36)}`],
    ["secret", `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----`],
    ["vendor", `see docs/${"specs"}/x`],
  ])("flags %s in PR text: %s", (check, text) => {
    const r = scan("--text", `${text}\n`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`[${check}]`);
  });

  it("ignores the commit subject scope, trailers and merge subjects, but not a key in the body", () => {
    const ok = scan("--commit-messages", `chore(ABC-12): tighten rules\n\nCo-authored-by: A <a${at}acmecorp${dot}io>\nMerge pull request #1 from acme/x\n`);
    expect(ok.status).toBe(0);
    const bad = scan("--commit-messages", `chore(ABC-12): tighten rules\n\nSee ti${"cket"} ABC-13\n`);
    expect(bad.status).toBe(1);
    const body = scan("--commit-messages", `\x1e\nchore(ABC-12): one\n\nfi${"x"}(ABC-14): a scope in the body still counts\n`);
    expect(body.status).toBe(1);
    const two = scan("--commit-messages", `\x1e\nchore(ABC-12): one\n\x1e\nfi${"x"}(ABC-15): two\n`);
    expect(two.status).toBe(0);
  });

  it("flags an internal SSH remote and a placeholder label on a real host", () => {
    expect(scan("--text", `git${at}git${dot}acmecorp${dot}io:team/repo\n`).status).toBe(1);
    expect(scan("--text", `db${dot}example${dot}prod${dot}internal\n`).status).toBe(1);
    expect(scan("--text", `git${at}github${dot}com:acme/repo\n`).status).toBe(0);
  });
});
