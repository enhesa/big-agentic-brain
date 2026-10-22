import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** BAB_TEAM_TAGS (lib/teams.ts): the default list, a custom list, an invalid value, and who reads it. */

const DEFAULT = ["engineering", "product", "marketing", "sales", "content", "legal", "regulatory", "finance", "hr", "management", "operations", "it", "data"];
const USER = "ada.t@example.com";
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-team-tags-test-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.BAB_TEAM_TAGS;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TEAM_TAGS;
  vi.resetModules();
});

async function user() {
  const { getDb } = await import("../lib/db");
  getDb().prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(USER, USER, "ada");
}

describe("BAB_TEAM_TAGS", () => {
  it("defaults to exactly the built-in list", async () => {
    const { teamTags } = await import("../lib/teams");
    expect([...teamTags()]).toEqual(DEFAULT);
    const { CONFIG_SPEC } = await import("../lib/config");
    expect(CONFIG_SPEC.find((e) => e.env === "BAB_TEAM_TAGS")!.default).toBe(DEFAULT.join(","));
  });

  it("refuses an empty value at startup", async () => {
    process.env.BAB_TEAM_TAGS = "";
    const { config, ConfigError } = await import("../lib/config");
    expect(() => config()).toThrow(ConfigError);
    expect(() => config()).toThrow(/BAB_TEAM_TAGS/);
  });

  it("reads a custom list, lowercased, trimmed and without duplicates", async () => {
    process.env.BAB_TEAM_TAGS = " Engineering, expert-services,engineering ,q4-ops";
    const { teamTags } = await import("../lib/teams");
    expect([...teamTags()]).toEqual(["engineering", "expert-services", "q4-ops"]);
  });

  it.each(["engineering,Expert Services", "a_b", "-lead", "trail-", "double--hyphen", "quote'x", "a;b", " , ,"])("refuses %j at startup", async (bad) => {
    process.env.BAB_TEAM_TAGS = bad;
    const { config, ConfigError } = await import("../lib/config");
    expect(() => config()).toThrow(ConfigError);
    expect(() => config()).toThrow(/BAB_TEAM_TAGS/);
  });

  it("labels slugs for people", async () => {
    const { teamLabel } = await import("../lib/teams");
    expect(teamLabel("expert-services")).toBe("Expert services");
    expect(teamLabel("engineering")).toBe("Engineering");
    expect(teamLabel("hr")).toBe("HR");
    expect(teamLabel("it")).toBe("IT");
  });

  it("setHomeTeam accepts a configured team and refuses one that is not configured", async () => {
    process.env.BAB_TEAM_TAGS = "engineering,expert-services";
    await user();
    const { setHomeTeam } = await import("../lib/area-contacts");
    expect(setHomeTeam(USER, "Expert-Services", "mcp")).toBe("expert-services");
    expect(() => setHomeTeam(USER, "sales", "mcp")).toThrow(/team must be one of engineering, expert-services/);
    expect(setHomeTeam(USER, "", "mcp")).toBeNull();
  });

  it("setHomeTeam keeps an unchanged home team whose team left the list", async () => {
    process.env.BAB_TEAM_TAGS = "engineering,expert-services";
    await user();
    const { setHomeTeam } = await import("../lib/area-contacts");
    setHomeTeam(USER, "expert-services", "mcp");
    process.env.BAB_TEAM_TAGS = "engineering";
    const { _resetConfigForTests } = await import("../lib/config");
    _resetConfigForTests();
    expect(setHomeTeam(USER, "expert-services", "mcp")).toBe("expert-services");
    expect(() => setHomeTeam(USER, "marketing", "mcp")).toThrow(/team must be one of engineering/);
  });

  it("setHomeTeam refuses expert-services on the default list", async () => {
    await user();
    const { setHomeTeam } = await import("../lib/area-contacts");
    expect(() => setHomeTeam(USER, "expert-services", "mcp")).toThrow(/team must be one of engineering, product/);
  });

  it("lists the configured teams in the tool descriptions, built when asked", async () => {
    process.env.BAB_TEAM_TAGS = "engineering,expert-services";
    const { findTool, toolsFor } = await import("../lib/mcp");
    expect(findTool("bab_learn")!.description).toContain("one team tag (engineering, expert-services) plus topic tags");
    const people = JSON.stringify(toolsFor("full").find((t) => t.name === "bab_people")!.inputSchema);
    expect(people).toContain("your home team (engineering, expert-services)");
    expect(people).not.toContain("marketing");
  });

  it("serves the default teams in the tool descriptions", async () => {
    const { findTool } = await import("../lib/mcp");
    expect(findTool("bab_learn")!.description).toContain(`one team tag (${DEFAULT.join(", ")}) plus topic tags`);
  });

  it("renders the served skill with the configured teams", async () => {
    process.env.BAB_TEAM_TAGS = "engineering,expert-services";
    const { renderInstructionText } = await import("../lib/instructions");
    const text = renderInstructionText("Team tags: {{TEAM_TAGS}}.", null);
    expect(text).toBe("Team tags: `engineering`, `expert-services`.");
  });
});
