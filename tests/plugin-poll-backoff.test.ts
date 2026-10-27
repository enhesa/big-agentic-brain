import { describe, it, expect } from "vitest";
import { BACKOFF_MAX_MS, PAUSED_TEXT, SLASH_WARNING, backoffMs, hasTrailingSlash, isOwnBabTool, looksLikeRefusal } from "../plugins/claude-code/hooks/poll-backoff";

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
    "approves %s on the plugin's own server",
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
