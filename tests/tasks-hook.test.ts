import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const plugin = path.join(process.cwd(), "plugins", "bab-tasks");

describe("the bab-tasks session hook", () => {
  it("runs the rule script on every session start, with no matcher, so a compaction is covered", () => {
    const { hooks } = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8"));
    expect(Object.keys(hooks)).toEqual(["SessionStart"]);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0].matcher).toBeUndefined();
    expect(hooks.SessionStart[0].hooks).toEqual([
      { type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/tasks-rule.sh"', timeout: 5 },
    ]);
  });

  it("prints one fixed line that names the skill and the rule, and exits 0", () => {
    const script = path.join(plugin, "scripts", "tasks-rule.sh");
    expect(readFileSync(script, "utf8")).not.toContain("\r");
    const run = spawnSync("sh", [script], { encoding: "utf8", input: "{}" });
    expect(run.status).toBe(0);
    const out = run.stdout.trim();
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("load that skill now");
    expect(out).toContain("after a context compaction");
    expect(out).toContain("as the last call of every turn");
    expect(out).toContain("leave BAB Tasks alone");
    expect(out.length).toBeLessThan(600);
  });

  it("makes no network call and reads no setting", () => {
    const text = readFileSync(path.join(plugin, "scripts", "tasks-rule.sh"), "utf8");
    expect(text).not.toMatch(/curl|wget|CLAUDE_PLUGIN_OPTION/);
  });
});
