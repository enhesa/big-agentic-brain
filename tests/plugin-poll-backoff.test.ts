import { describe, it, expect } from "vitest";
import { BACKOFF_MAX_MS, PAUSED_TEXT, SLASH_WARNING, backoffMs, hasTrailingSlash, isAutoAllowed, isOwnBabTool, looksLikeRefusal } from "../plugins/claude-code/hooks/poll-backoff";

describe("poll back-off", () => {
  it("waits nothing until a poll has failed, then doubles up to five minutes", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 50].map(backoffMs)).toEqual([0, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000]);
    expect(BACKOFF_MAX_MS).toBe(300_000);
  });

  it("treats a bad count as no failure", () => {
    expect(backoffMs(-1)).toBe(0);
    expect(backoffMs(Number.NaN)).toBe(0);
  });
});

describe("refusal detection", () => {
  it.each([
    "Permission denied for tool mcp__plugin_bab_bab__bab_inbox",
    "Error: The user declined to allow this tool call",
    "User denied permission to use bab_inbox",
    "Tool use was rejected",
    "bab_inbox requires approval",
    "Tool call was blocked by policy",
  ])("recognises %s", (text) => expect(looksLikeRefusal(text)).toBe(true));

  it.each([
    "bab_inbox timed out",
    "fetch failed: ECONNREFUSED",
    "Error: socket hang up",
    "BAB does not know you yet: call bab_identify",
    "Rate limit exceeded, retry later",
    "",
  ])("does not mistake %j for a refusal", (text) => expect(looksLikeRefusal(text)).toBe(false));

  it("says in plain text how to resume", () => {
    expect(PAUSED_TEXT).toContain("allow its tools");
    expect(PAUSED_TEXT).toContain("/bab-check");
    expect(PAUSED_TEXT).not.toContain("—");
  });
});

describe("trailing slash warning", () => {
  it("flags a bab_url ending in a slash only", () => {
    expect(hasTrailingSlash("https://bab.example.com/")).toBe(true);
    expect(hasTrailingSlash(" https://bab.example.com/ ")).toBe(true);
    expect(hasTrailingSlash("https://bab.example.com")).toBe(false);
    expect(hasTrailingSlash(undefined)).toBe(false);
    expect(hasTrailingSlash("")).toBe(false);
  });

  it("tells the person what to do, in plain text", () => {
    expect(SLASH_WARNING).toContain("bab_url");
    expect(SLASH_WARNING).toContain("restart Claude");
    expect(SLASH_WARNING).not.toContain("\u2014");
  });
});

describe("isOwnBabTool", () => {
  it.each(["mcp__plugin_bab_bab__bab_inbox", "mcp__plugin_bab_bab__bab_send", "mcp__plugin_bab_bab__bab_link_session"])(
    "recognises %s on the plugin's own server",
    (name) => expect(isOwnBabTool(name, "plugin:bab:bab")).toBe(true),
  );

  it("follows the name the plugin was installed under", () => {
    expect(isOwnBabTool("mcp__plugin_bab-inline_bab__bab_inbox", "plugin:bab-inline:bab")).toBe(true);
    expect(isOwnBabTool("mcp__plugin_bab_bab__bab_inbox", "plugin:bab-inline:bab")).toBe(false);
  });

  it.each(["Bash", "mcp__plugin_bab_bab__", "mcp__plugin_evil_bab__bab_x", "mcp__plugin_bab_bab__other", "mcp__plugin_bab_bab__bab_inbox;rm", "xmcp__plugin_bab_bab__bab_inbox"])(
    "leaves %s to the normal check",
    (name) => expect(isOwnBabTool(name, "plugin:bab:bab")).toBe(false),
  );

  it("approves nothing while the server is unknown", () => {
    expect(isOwnBabTool("mcp__plugin_bab_bab__bab_inbox", null)).toBe(false);
  });
});

describe("isAutoAllowed", () => {
  const server = "plugin:bab:bab";
  const tool = (name: string) => `mcp__plugin_bab_bab__${name}`;

  it.each(["bab_search", "bab_inbox", "bab_identify", "bab_link_session", "bab_remind"])(
    "approves the low-risk tool %s",
    (name) => expect(isAutoAllowed(tool(name), server, {})).toBe(true),
  );

  it.each(["bab_send", "bab_files", "bab_kv", "bab_unknown"])("keeps the ask for %s", (name) => {
    expect(isAutoAllowed(tool(name), server, { action: "list" })).toBe(false);
  });

  it.each(["list", "get"])("approves bab_feedback %s", (action) => {
    expect(isAutoAllowed(tool("bab_feedback"), server, { action })).toBe(true);
  });

  it.each(["post", "vote", "comment", "status", undefined])("keeps the ask for bab_feedback %s", (action) => {
    expect(isAutoAllowed(tool("bab_feedback"), server, { action })).toBe(false);
  });

  it.each([{}, { area: "billing" }, { action: "" }, { action: null }])("approves a bab_people read %j", (input) => {
    expect(isAutoAllowed(tool("bab_people"), server, input)).toBe(true);
  });

  it.each([
    { action: "set_home_team", team: "x" },
    { action: "add_contact", area: "billing" },
    { action: "remove_contact", area: "billing" },
    { action: "other" },
    { user: "someone@example.com" },
    { action: "set_home_team", user: "someone@example.com", team: "x" },
  ])("keeps the ask for bab_people %j", (input) => {
    expect(isAutoAllowed(tool("bab_people"), server, input)).toBe(false);
  });

  it.each([{}, { title: "t" }, { kind: "learning" }, { kind: "practice" }, { kind: "learning", supersedes: [] }, { supersedes: "" }])(
    "approves a plain bab_learn %j",
    (input) => expect(isAutoAllowed(tool("bab_learn"), server, input)).toBe(true),
  );

  it.each([
    { kind: "decision" },
    { kind: "standard" },
    { kind: "other" },
    { supersedes: ["a"] },
    { supersedes: "a" },
    { kind: "learning", supersedes: ["a", "b"] },
  ])("keeps the ask for bab_learn %j", (input) => {
    expect(isAutoAllowed(tool("bab_learn"), server, input)).toBe(false);
  });

  it.each(["helpful", "not_helpful", "kudos", "confirm", "keep", "flag", "label", "comment"])("approves bab_react %s", (action) => {
    expect(isAutoAllowed(tool("bab_react"), server, { learningId: "x", action })).toBe(true);
  });

  it.each(["retire", "delete", "pin", "unpin", "other"])("keeps the ask for bab_react %s", (action) => {
    expect(isAutoAllowed(tool("bab_react"), server, { learningId: "x", action })).toBe(false);
  });

  it.each(["publish", "list"])("approves bab_command_center %s, which the skill calls every turn", (action) => {
    expect(isAutoAllowed(tool("bab_command_center"), server, { action })).toBe(true);
  });

  it.each(["remove", "delete_all", "export", "grant_export", "revoke_export", "backfill_link"])("keeps the ask for bab_command_center %s", (action) => {
    expect(isAutoAllowed(tool("bab_command_center"), server, { action })).toBe(false);
  });

  it.each([undefined, null, "publish", 7, {}, { action: 1 }, { action: "PUBLISH" }])("keeps the ask when the input is %j", (input) => {
    expect(isAutoAllowed(tool("bab_command_center"), server, input)).toBe(false);
    expect(isAutoAllowed(tool("bab_react"), server, input)).toBe(false);
    if (typeof input !== "object" || input === null) {
      expect(isAutoAllowed(tool("bab_people"), server, input)).toBe(false);
      expect(isAutoAllowed(tool("bab_learn"), server, input)).toBe(false);
    }
  });

  it("approves nothing on another server or while the server is unknown", () => {
    expect(isAutoAllowed("mcp__plugin_evil_bab__bab_search", server, {})).toBe(false);
    expect(isAutoAllowed(tool("bab_search"), null, {})).toBe(false);
  });
});
