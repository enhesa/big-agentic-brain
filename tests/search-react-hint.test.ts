import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Reactions: in real sessions agents read and used
 * colleagues' memories but reacted in only part of them. The texts that speak at the moment of use
 * now say so: every bab_search answer carries a `react` hint and marks the caller's own entries
 * own: true (BAB takes no vote, confirm or kudos from the author), and the bab_search and bab_react
 * descriptions say the same.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-search-react-hint-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

const ME = "eval.user@example.com";
const ANNA = "anna.devries@example.com";

async function users() {
  const { upsertUser } = await import("../lib/users");
  for (const id of [ME, ANNA]) upsertUser({ id, email: id, name: id, roles: [] });
}

async function memory(authorId: string, title: string, body = "Deploys go through the gitops repo values file.") {
  const { create } = await import("../lib/learnings");
  return create({ authorId, title, body, confirmNotDuplicate: true });
}

async function search(actorId: string, query: string, extra: Record<string, unknown> = {}) {
  const { findTool } = await import("../lib/mcp");
  return JSON.parse(findTool("bab_search")!.run({ id: actorId } as never, { query, ...extra }));
}

describe("bab_search answers", () => {
  it("carry a react hint when there are results, and none when there are not", async () => {
    await users();
    await memory(ANNA, "Deploy the export service through gitops");
    const hit = await search(ME, "export gitops");
    expect(hit.results).toHaveLength(1);
    const { SEARCH_REACT_HINT } = await import("../lib/mcp");
    expect(hit.react).toBe(SEARCH_REACT_HINT);
    const none = await search(ME, "nothingmatchesthisatall");
    expect(none.results).toHaveLength(0);
    expect(none.react).toBeUndefined();
  });

  it("the hint asks for one of helpful or confirm, kudos only for the user's praise, and flag with evidence", async () => {
    const { SEARCH_REACT_HINT } = await import("../lib/mcp");
    for (const needle of [
      "react before your reply ends, without asking: bab_react helpful",
      "or confirm instead (note: where and when) if you checked it yourself in code or docs",
      "kudos (note) only when the user praises that memory or its author",
      "flag (note: the evidence) if it is wrong",
      "Not on results marked own (yours), and not on ones you did not use",
    ]) {
      expect(SEARCH_REACT_HINT).toContain(needle);
    }
  });

  it("mark only the caller's own entries own: true", async () => {
    await users();
    const mine = await memory(ME, "My note on the export deploy");
    const theirs = await memory(ANNA, "Anna's note on the export deploy");
    const { results } = await search(ME, "export deploy", { limit: 10 });
    const byId = new Map<string, { own?: boolean }>(results.map((r: { id: string; own?: boolean }) => [r.id, r]));
    expect(byId.get(mine.id)!.own).toBe(true);
    expect(byId.get(theirs.id)!.own).toBeUndefined();
  });

  it("mark own entries in a plain listing too (empty query)", async () => {
    await users();
    const mine = await memory(ME, "My note on the export deploy");
    const { results } = await search(ME, "");
    expect(results.find((r: { id: string }) => r.id === mine.id).own).toBe(true);
  });
});

describe("the bab_search and bab_react texts", () => {
  it("bab_search says to react to a result that helped, and that own results take no votes", async () => {
    const { findTool } = await import("../lib/mcp");
    const d = findTool("bab_search")!.description;
    expect(d).toContain("When a result helped, bab_react before your reply ends");
    expect(d).toContain("own: true");
  });

  it("bab_react puts helpful or confirm, and kudos, on autopilot, with kudos for the user's praise", async () => {
    const { findTool } = await import("../lib/mcp");
    const d = findTool("bab_react")!.description;
    expect(d).toContain("Autopilot: helpful (or confirm, if you checked it) and kudos on a colleague's memory you used");
    expect(d).toContain("kudos (the user praised it; why in note)");
  });
});
