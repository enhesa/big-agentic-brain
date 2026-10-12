import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/** scripts/suggest-applies-to.mjs: proposes labels into a file, never writes a database. */

let dir: string;
const SCRIPT = path.join(process.cwd(), "scripts", "suggest-applies-to.mjs");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bab-suggest-applies-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(memories: unknown, extra: string[] = []) {
  const input = path.join(dir, "memories.json");
  writeFileSync(input, JSON.stringify(memories));
  const result = spawnSync(process.execPath, [SCRIPT, input, ...extra], { encoding: "utf8" });
  const out = path.join(dir, "suggestions.json");
  return { result, suggestions: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
}

describe("suggest-applies-to.mjs", () => {
  it("proposes labels from title, body and tags, with the words that matched", () => {
    const { result, suggestions } = run([
      { id: "a", title: "Use IsEnabledForAsync", body: "In the .csproj reference the feature flags NuGet package.", tags: '["engineering"]' },
      { id: "b", title: "Deploy with helm", body: "Bump values-dev.yaml, never kubectl apply.", tags: ["devops"] },
      { id: "c", title: "Write short commit messages", body: "Say what changed in one line.", tags: [] },
    ]);
    expect(result.status).toBe(0);
    type Suggestion = { id: string; suggested: string[]; matchedOn: Record<string, string[]> };
    const byId = new Map<string, Suggestion>(suggestions.map((s: Suggestion) => [s.id, s]));
    expect(byId.get("a")).toMatchObject({ suggested: ["dotnet"] });
    expect(byId.get("b")).toMatchObject({ suggested: ["helm", "aks"] });
    expect(byId.get("a")!.matchedOn.dotnet).toContain(".csproj");
    // No match, no entry.
    expect(byId.has("c")).toBe(false);
  });

  it("does not match go in going or java in javascript", () => {
    const { suggestions } = run([{ id: "a", title: "We are going to ship javascript", body: "Going well.", tags: [] }]);
    const labels = (suggestions as Array<{ suggested: string[] }>).flatMap((s) => s.suggested);
    expect(labels).not.toContain("go");
    expect(labels).not.toContain("java");
  });

  it("skips memories that already have labels, and leaves a cross-cutting one empty with a note", () => {
    const { suggestions } = run({
      results: [
        { id: "done", title: "Dotnet thing", body: "dotnet", tags: [], appliesTo: ["dotnet"] },
        { id: "done2", title: "Dotnet thing", body: "dotnet", tags: [], applies_to: '["dotnet"]' },
        { id: "wide", title: "Stack overview", body: "dotnet, node, python, docker and kafka all run here", tags: [] },
      ],
    });
    expect(suggestions.map((s: { id: string }) => s.id)).toEqual(["wide"]);
    expect(suggestions[0].suggested).toEqual([]);
    expect(suggestions[0].note).toMatch(/probably general/);
  });

  it("--all lists memories with nothing suggested too, and --out chooses the file", () => {
    const input = path.join(dir, "memories.json");
    writeFileSync(input, JSON.stringify([{ id: "c", title: "Plain", body: "Nothing technical", tags: [] }]));
    const out = path.join(dir, "elsewhere.json");
    const result = spawnSync(process.execPath, [SCRIPT, input, "--all", "--out", out], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([{ id: "c", title: "Plain", suggested: [], matchedOn: {} }]);
    expect(result.stdout).toContain("Nothing was applied");
  });

  it("explains the usage and exits 2 without an input", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage");
  });
});
