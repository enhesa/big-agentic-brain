#!/usr/bin/env node
// Maps staged files to related unit test files (by name/import) and runs
// only those with vitest, falling back to the full unit suite when the
// staged set is large (>15 files) or touches lib/db.ts (the shared SQLite
// layer nearly every test file depends on transitively).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function stagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    encoding: "utf8",
  });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

function allUnitTestFiles() {
  const dir = path.join(process.cwd(), "tests");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx"))
    .map((f) => path.join("tests", f));
}

function baseNameNoExt(p) {
  return path.basename(p).replace(/\.(ts|tsx|mjs|js)$/, "");
}

function runFullSuite(reason) {
  console.log(`test:changed: ${reason} — running the full unit suite.`);
  const res = spawnSync("pnpm", ["run", "test:unit"], { stdio: "inherit", shell: true });
  process.exit(res.status ?? 1);
}

const staged = stagedFiles().filter((f) => !f.startsWith("tests/e2e/"));

if (staged.length === 0) {
  console.log("test:changed: no staged files, nothing to test.");
  process.exit(0);
}

if (staged.length > 15) {
  runFullSuite(`${staged.length} staged files (>15)`);
}

if (staged.some((f) => path.normalize(f) === path.normalize("lib/db.ts"))) {
  runFullSuite("lib/db.ts changed (shared by nearly every test file)");
}

const testFiles = allUnitTestFiles();
const related = new Set();

for (const staged1 of staged) {
  // A staged test file itself: always run it directly.
  if (/\.test\.(ts|tsx)$/.test(staged1)) {
    if (fs.existsSync(staged1)) related.add(staged1);
    continue;
  }

  const before = related.size;
  const stagedBase = baseNameNoExt(staged1); // e.g. "learnings" from lib/learnings.ts
  const stagedImportSpecifier = staged1
    .replace(/^app\//, "@/app/")
    .replace(/^lib\//, "@/lib/")
    .replace(/\.(ts|tsx)$/, "");
  // Extra name keys for files whose basename says nothing about the feature:
  //   content/instructions/skill.md      -> instructions*.test.ts
  //   app/api/todos/[id]/complete/route.ts -> api-todos*.test.ts
  //   app/memory/[id]/page.tsx           -> memory*.test.ts
  const nameKeys = new Set([stagedBase]);
  if (staged1.startsWith("content/instructions/")) nameKeys.add("instructions");
  const apiMatch = staged1.match(/^app\/api\/([^/]+)\//);
  if (apiMatch) nameKeys.add(`api-${apiMatch[1]}`);
  const pageMatch = staged1.match(/^app\/([^/]+)\//);
  if (pageMatch && pageMatch[1] !== "api") nameKeys.add(pageMatch[1]);

  for (const testFile of testFiles) {
    const testBase = baseNameNoExt(testFile);
    // Name match: "learnings.test.ts" / "learnings-gaps.test.ts" relate to "learnings.ts".
    if ([...nameKeys].some((k) => testBase === k || testBase.startsWith(`${k}-`))) {
      related.add(testFile);
      continue;
    }
    // Import match: the test file imports the staged module by path.
    try {
      const content = fs.readFileSync(testFile, "utf8");
      if (content.includes(stagedImportSpecifier) || content.includes(`./${path.basename(staged1)}`)) {
        related.add(testFile);
      }
    } catch {
      // ignore unreadable test file
    }
  }

  // Fail closed per file: a source change nothing maps to runs everything,
  // even if other staged files did find their tests.
  if (related.size === before && /\.(ts|tsx|mjs|md)$/.test(staged1) && !staged1.startsWith("docs/")) {
    runFullSuite(`no related unit test files found for ${staged1}`);
  }
}

if (related.size === 0) {
  runFullSuite("no related unit test files found for the staged changes");
}

const files = Array.from(related);
console.log(`test:changed: running ${files.length} related test file(s):\n  ${files.join("\n  ")}`);
const res = spawnSync("pnpm", ["exec", "vitest", "run", ...files], { stdio: "inherit", shell: true });
process.exit(res.status ?? 1);
