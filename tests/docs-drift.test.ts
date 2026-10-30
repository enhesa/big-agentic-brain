import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Docs are part of every change (CLAUDE.md). This keeps the written docs from silently falling
 * behind the tools: every MCP tool registered in lib/mcp.ts must be named in the spec and in both
 * skill texts, which no other test links. The /docs page has the same check in
 * tests/docs-page.test.ts, on the rendered HTML.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-docs-drift-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

const DOCS = [
  "docs/spec.md",
  "content/instructions/skill.md",
  "plugins/claude-code/skills/big-agentic-brain/SKILL.md",
];

describe("docs name every MCP tool", () => {
  for (const file of DOCS) {
    it(`${file} names every tool in lib/mcp.ts`, async () => {
      const { TOOLS } = await import("../lib/mcp");
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      const missing = TOOLS.map((t) => t.name).filter((name) => !new RegExp(`\\b${name}\\b`).test(text));
      expect(missing, `add these tools to ${file}`).toEqual([]);
    });
  }
});
