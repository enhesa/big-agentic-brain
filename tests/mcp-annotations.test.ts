import { describe, it, expect } from "vitest";
import { toolsFor } from "../lib/mcp";

/**
 * Hosts such as the Claude desktop app prompt for every tool call unless the tool says it is
 * read-only. Pin the hints so a new tool cannot ship without them, and a writer cannot pass as a read.
 * bab_inbox counts as read-only although opening a thread marks it read: that is what the caller asked for.
 * bab_people counts as read-only for listing; its profile actions are own-profile settings that need the user's yes.
 */
const READ_ONLY = ["bab_search", "bab_people", "bab_inbox"];
const WRITERS_DESTRUCTIVE: Record<string, boolean> = {
  bab_learn: true,
  bab_react: true,
  bab_send: false,
  bab_remind: false,
  bab_identify: false,
  bab_link_session: false,
  bab_feedback: false,
};

describe("MCP tool annotations", () => {
  const tools = toolsFor("full");

  it("covers every tool, with a short title", () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_ONLY, ...Object.keys(WRITERS_DESTRUCTIVE)].sort());
    for (const t of tools) {
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.title.length).toBeLessThanOrEqual(30);
      expect(t.annotations.title).toBe(t.title);
      expect(t.annotations.openWorldHint).toBe(false);
    }
  });

  it("marks the reads read-only and nothing else", () => {
    for (const t of tools) expect(t.annotations.readOnlyHint, t.name).toBe(READ_ONLY.includes(t.name));
  });

  it("states destructiveHint on every writer, true only where it archives or deletes, and never on a read", () => {
    for (const t of tools) {
      if (READ_ONLY.includes(t.name)) expect(t.annotations.destructiveHint, t.name).toBeUndefined();
      else expect(t.annotations.destructiveHint, t.name).toBe(WRITERS_DESTRUCTIVE[t.name]);
    }
  });
});
