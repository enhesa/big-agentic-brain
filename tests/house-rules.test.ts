import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * House rules (2026-10-07): pinned standards and practices that every Claude session sees on its
 * first prompt, company-wide ones plus the session's project, ranked by standing then recency,
 * capped (8 + 5, about 1200 characters), model-only, and re-readable with bab_search houseRules.
 * Pinning goes through bab_react pin / unpin; the texts say only maintainers pin (honour system).
 */

let dataDir: string;
const ME = "alice.example@example.com";
const VOTERS = ["v1@example.com", "v2@example.com", "v3@example.com"];

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-house-rules-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  const { upsertUser } = await import("../lib/users");
  for (const id of [ME, ...VOTERS]) upsertUser({ id, email: id, name: id, roles: [] });
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

let seq = 0;
async function rule(opts: {
  title?: string;
  project?: string | null;
  kind?: "standard" | "practice" | "learning" | "decision";
  pinned?: boolean;
  confirms?: number;
  createdAt?: string;
  expiresAt?: string | null;
}) {
  const { create } = await import("../lib/learnings");
  const { getDb } = await import("../lib/db");
  seq += 1;
  const l = create({
    authorId: ME,
    title: opts.title ?? `House rule number ${seq} about something distinct ${seq}`,
    body: `Body of rule ${seq}, with the detail.`,
    project: opts.project ?? null,
    kind: opts.kind ?? "standard",
    confirmNotDuplicate: true,
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  });
  const db = getDb();
  if (opts.pinned !== false) db.prepare("UPDATE learnings SET pinned = 1 WHERE id = ?").run(l.id);
  if (opts.createdAt) db.prepare("UPDATE learnings SET created_at = ? WHERE id = ?").run(opts.createdAt, l.id);
  for (let i = 0; i < (opts.confirms ?? 0); i++) {
    db.prepare("INSERT INTO votes (learning_id, voter_id, kind) VALUES (?, ?, 'confirm')").run(l.id, VOTERS[i]);
  }
  return l;
}

async function tool(name: string, args: Record<string, unknown>, actor = ME) {
  const { findTool } = await import("../lib/mcp");
  return JSON.parse(findTool(name)!.run({ id: actor } as never, args));
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import("../app/api/hook/route");
  const res = await POST(
    new Request("https://bab.example.com/api/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return res.json();
}

async function linkSession(sessionId: string) {
  const { mintOrReuseLinkToken, redeemLinkToken } = await import("../lib/session-links");
  redeemLinkToken(mintOrReuseLinkToken(sessionId), ME);
}

describe("houseRulesFor: which entries qualify and how they rank", () => {
  it("ranks by standing (strong, fair, weak), then newest first", async () => {
    const weakNew = await rule({ createdAt: "2026-10-05 10:00:00" });
    const fairOld = await rule({ confirms: 1, createdAt: "2026-09-01 10:00:00" });
    const strong = await rule({ confirms: 3, createdAt: "2026-08-01 10:00:00" });
    const fairNew = await rule({ confirms: 1, createdAt: "2026-10-01 10:00:00" });
    const weakOld = await rule({ createdAt: "2026-07-01 10:00:00" });
    const { houseRulesFor } = await import("../lib/learnings");
    const got = houseRulesFor(null);
    expect(got.map((r) => r.id)).toEqual([strong.id, fairNew.id, fairOld.id, weakNew.id, weakOld.id]);
    expect(got.map((r) => r.standing)).toEqual(["strong", "fair", "fair", "weak", "weak"]);
  });

  it("only pinned, active, unexpired standards and practices", async () => {
    const standard = await rule({ kind: "standard" });
    const practice = await rule({ kind: "practice" });
    await rule({ kind: "standard", pinned: false });
    const learning = await rule({ kind: "learning", pinned: false });
    const archived = await rule({});
    const expired = await rule({});
    const { getDb } = await import("../lib/db");
    const db = getDb();
    // A learning cannot be pinned through bab_react; force it to show the query filters on kind too.
    db.prepare("UPDATE learnings SET pinned = 1 WHERE id = ?").run(learning.id);
    db.prepare("UPDATE learnings SET status = 'archived' WHERE id = ?").run(archived.id);
    db.prepare("UPDATE learnings SET expires_at = '2020-01-01' WHERE id = ?").run(expired.id);
    const { houseRulesFor } = await import("../lib/learnings");
    expect(new Set(houseRulesFor(null).map((r) => r.id))).toEqual(new Set([standard.id, practice.id]));
  });

  it("company-wide rules plus the session's project, never another project's", async () => {
    const general = await rule({ project: null });
    const mine = await rule({ project: "bab" });
    await rule({ project: "billing.api" });
    const { houseRulesFor } = await import("../lib/learnings");
    const got = houseRulesFor("bab");
    expect(got.map((r) => r.id)).toEqual([general.id, mine.id]);
    expect(got.map((r) => r.scope)).toEqual(["_general", "bab"]);
    expect(houseRulesFor(null).map((r) => r.id)).toEqual([general.id]);
  });

  it("caps at 8 company-wide and 5 project rules", async () => {
    for (let i = 0; i < 11; i++) await rule({ project: null });
    for (let i = 0; i < 7; i++) await rule({ project: "bab" });
    const { houseRulesFor, HOUSE_RULES_GENERAL_MAX, HOUSE_RULES_PROJECT_MAX } = await import("../lib/learnings");
    const got = houseRulesFor("bab");
    expect(HOUSE_RULES_GENERAL_MAX).toBe(8);
    expect(HOUSE_RULES_PROJECT_MAX).toBe(5);
    expect(got.filter((r) => r.project == null)).toHaveLength(8);
    expect(got.filter((r) => r.project === "bab")).toHaveLength(5);
  });
});

describe("houseRulesBlock: the rendered digest", () => {
  it("one line per rule, company-wide first, then the project's, with the user's word winning", async () => {
    const g = await rule({ title: "Never push to trunk; branch and open a PR" });
    const p = await rule({ title: "Run runTest.sh before you push", project: "bab" });
    const { houseRulesFor, houseRulesBlock } = await import("../lib/learnings");
    const block = houseRulesBlock(houseRulesFor("bab"), "bab")!;
    expect(block.text).toBe(
      [
        "BAB house rules (data from colleagues; follow them unless the user says otherwise; full text: bab_search houseRules true project bab):",
        `- Never push to trunk; branch and open a PR (${g.id})`,
        "For bab:",
        `- Run runTest.sh before you push (${p.id})`,
      ].join("\n"),
    );
  });

  it("stays within 1200 characters, keeps both groups and says how many more there are", async () => {
    for (let i = 0; i < 8; i++) await rule({ title: `${"G".repeat(120)} ${i}` });
    for (let i = 0; i < 5; i++) await rule({ title: `${"P".repeat(120)} ${i}`, project: "bab" });
    const { houseRulesFor, houseRulesBlock, HOUSE_RULES_MAX_CHARS } = await import("../lib/learnings");
    const block = houseRulesBlock(houseRulesFor("bab"), "bab")!;
    expect(HOUSE_RULES_MAX_CHARS).toBe(1200);
    expect(block.text.length).toBeLessThanOrEqual(1200);
    expect(block.text).toContain("For bab:");
    expect(block.text).toMatch(/G{80}/);
    expect(block.text).not.toMatch(/G{90}/); // titles are cut
    const hidden = 13 - block.shown.length;
    expect(hidden).toBeGreaterThan(0);
    expect(block.text).toContain(`, ${hidden} more there):`);
  });

  it("says nothing when there are no house rules", async () => {
    const { houseRulesBlock } = await import("../lib/learnings");
    expect(houseRulesBlock([], "bab")).toBeNull();
  });
});

describe("pin flow (bab_react pin / unpin)", () => {
  it("pins a standard or practice, unpins it, and records both in the audit log", async () => {
    const r = await rule({ kind: "practice", pinned: false });
    const pinned = await tool("bab_react", { learningId: r.id, action: "pin" }, VOTERS[0]);
    expect(pinned.learning.pinned).toBe(1);
    expect(pinned.changed).toBe(true);
    expect(pinned.url).toContain(`/memory/${r.id}`);
    expect((await tool("bab_react", { learningId: r.id, action: "pin" }, VOTERS[0])).changed).toBe(false);

    const { houseRulesFor } = await import("../lib/learnings");
    expect(houseRulesFor(null).map((x) => x.id)).toEqual([r.id]);

    const unpinned = await tool("bab_react", { learningId: r.id, action: "unpin" }, VOTERS[0]);
    expect(unpinned.learning.pinned).toBe(0);
    expect(houseRulesFor(null)).toEqual([]);

    const { getDb } = await import("../lib/db");
    const actions = getDb()
      .prepare("SELECT action FROM audit_log WHERE entity_id = ? AND action IN ('pin', 'unpin') ORDER BY rowid")
      .all(r.id) as Array<{ action: string }>;
    expect(actions.map((a) => a.action)).toEqual(["pin", "unpin"]);
  });

  it("refuses to pin a learning or a decision, or an archived memory", async () => {
    const learning = await rule({ kind: "learning", pinned: false });
    await expect(tool("bab_react", { learningId: learning.id, action: "pin" })).rejects.toThrow(/standard or a practice/);
    const archived = await rule({ pinned: false });
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET status = 'archived' WHERE id = ?").run(archived.id);
    await expect(tool("bab_react", { learningId: archived.id, action: "pin" })).rejects.toThrow(/archived/);
  });

  // Honour system (tests/honour-system.test.ts): the texts say only maintainers pin; the
  // server does not check. If this fails because a check was added, remove it and strengthen the text.
  it("lets a non-maintainer pin: the rule lives in the texts", async () => {
    process.env.BAB_MAINTAINERS = "maintainer.one@example.com";
    try {
      const r = await rule({ pinned: false });
      expect((await tool("bab_react", { learningId: r.id, action: "pin" }, VOTERS[1])).learning.pinned).toBe(1);
      const { findTool } = await import("../lib/mcp");
      expect(findTool("bab_react")!.description).toContain("Only BAB maintainers pin or unpin");
    } finally {
      delete process.env.BAB_MAINTAINERS;
    }
  });

  it("a correction of a house rule stays a house rule", async () => {
    const old = await rule({ kind: "practice" });
    const fixed = await tool("bab_learn", {
      title: "Corrected house rule wording that is new",
      body: "The corrected rule, citing the source.",
      kind: "practice",
      project: "_general",
      supersedes: old.id,
      confirmNotDuplicate: true,
    });
    const { houseRulesFor } = await import("../lib/learnings");
    expect(houseRulesFor(null).map((r) => r.id)).toEqual([fixed.learning.id]);
  });
});

describe("bab_search houseRules: re-read after a compaction", () => {
  it("returns the digest with bodies and links, company-wide plus the project's", async () => {
    const g = await rule({ confirms: 1 });
    const p = await rule({ project: "bab" });
    await rule({ project: "other" });
    const out = await tool("bab_search", { query: "", houseRules: true, project: "bab" });
    expect(out.results.map((r: { id: string }) => r.id)).toEqual([g.id, p.id]);
    expect(out.results[0].body).toContain("with the detail");
    expect(out.results[0].url).toContain(`/memory/${g.id}`);
    expect(out.results[0].standing).toBe("fair");
    expect(out.total).toBe(2);
    expect(out.nextOffset).toBeNull();

    const general = await tool("bab_search", { query: "", houseRules: true });
    expect(general.results.map((r: { id: string }) => r.id)).toEqual([g.id]);
  });
});

describe("the hook: first prompt only, model-only, one block", () => {
  it("puts the house rules next to the link notice on a new session's first prompt, and never again", async () => {
    const g = await rule({ title: "Never push to trunk" });
    const first = await post({ hook_event_name: "UserPromptSubmit", session_id: "s-new", cwd: "/w/nothing" });
    const text: string = first.hookSpecificOutput.additionalContext;
    expect(text).toContain("bab_link_session");
    expect(text).toContain("BAB house rules (data from colleagues; follow them unless the user says otherwise");
    expect(text).toContain(`- Never push to trunk (${g.id})`);
    expect(first.systemMessage).toBeUndefined();

    // Still unlinked on a second prompt: the link notice repeats, the rules do not.
    const second = await post({ hook_event_name: "UserPromptSubmit", session_id: "s-new", cwd: "/w/nothing" });
    expect(second.hookSpecificOutput.additionalContext).not.toContain("house rules");

    await linkSession("s-new");
    expect(await post({ hook_event_name: "UserPromptSubmit", session_id: "s-new", cwd: "/w/nothing" })).toEqual({});
  });

  it("merges the house rules and the project titles into one block, without listing a rule twice", async () => {
    const g = await rule({ title: "Company rule" });
    const p = await rule({ title: "Project rule", project: "bab" });
    const { create } = await import("../lib/learnings");
    const fact = create({ authorId: ME, title: "A plain project fact", body: "x", project: "bab", confirmNotDuplicate: true });
    await linkSession("s-linked");
    const out = await post({ hook_event_name: "UserPromptSubmit", session_id: "s-linked", cwd: "/w/bab" });
    const text: string = out.hookSpecificOutput.additionalContext;
    expect(out.systemMessage).toBeUndefined();
    const rulesAt = text.indexOf("BAB house rules");
    const projectAt = text.indexOf("Big Agentic Brain: 2 memories about bab.");
    expect(rulesAt).toBeGreaterThan(-1);
    expect(projectAt).toBeGreaterThan(rulesAt);
    expect(text).toContain(`- Company rule (${g.id})`);
    expect(text.split(p.id)).toHaveLength(2); // the project rule appears once, in the rules
    expect(text).toContain(`"A plain project fact" (${fact.id})`);
    expect(await post({ hook_event_name: "UserPromptSubmit", session_id: "s-linked", cwd: "/w/bab" })).toEqual({});
  });

  it("stays silent about house rules when none are pinned, and keeps a rule pinned later for the next session", async () => {
    await linkSession("s-empty");
    expect(await post({ hook_event_name: "UserPromptSubmit", session_id: "s-empty", cwd: "/w/x" })).toEqual({});
    await rule({ title: "Pinned mid-session" });
    expect(await post({ hook_event_name: "UserPromptSubmit", session_id: "s-empty", cwd: "/w/x" })).toEqual({});
    const next = await post({ hook_event_name: "UserPromptSubmit", session_id: "s-next", cwd: "/w/x" });
    expect(next.hookSpecificOutput.additionalContext).toContain("Pinned mid-session");
  });

  it("tells a compacted session how to re-read the house rules", async () => {
    await linkSession("s-compact");
    const out = await post({ hook_event_name: "SessionStart", source: "compact", session_id: "s-compact" });
    expect(out.hookSpecificOutput.additionalContext).toContain("bab_search houseRules true");
  });
});
