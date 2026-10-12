import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The author's hook nudge from swarm garbage collection (POST /api/hook), and the maintainer's
 * line for protected memories colleagues marked not helpful. Model-only, never a verify hint.
 */

let dataDir: string;
const ME = "alice.example@example.com";
const MAINT = "mia.maint@example.com";
const VOTERS = ["v1@example.com", "v2@example.com", "v3@example.com"];
const ORIGIN = "https://bab.example.com";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-swarm-gc-hook-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_MAINTAINERS = MAINT;
  process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com"; // links in results are built from the configured origin
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  delete process.env.BAB_PUBLIC_ORIGIN;
  vi.resetModules();
});

async function prompt(sessionId: string) {
  const { POST } = await import("../app/api/hook/route");
  const res = await POST(
    new Request(`${ORIGIN}/api/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId }),
    }),
  );
  return (await res.json()) as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
}

const lines = (out: Awaited<ReturnType<typeof prompt>>) => (out.hookSpecificOutput?.additionalContext ?? "").split(/\r?\n/);
const downLines = (out: Awaited<ReturnType<typeof prompt>>) => lines(out).filter((l) => l.startsWith("BAB: colleagues marked your memory"));

async function linkSession(sessionId: string, ownerId: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ownerId, email: ownerId, name: ownerId, roles: [] });
  const { mintOrReuseLinkToken, redeemLinkToken } = await import("../lib/session-links");
  redeemLinkToken(mintOrReuseLinkToken(sessionId), ownerId);
}

async function seed(over: Record<string, unknown> = {}, authorId = ME) {
  const { upsertUser } = await import("../lib/users");
  for (const id of [authorId, MAINT, "kim@example.com", ...VOTERS]) upsertUser({ id, email: id, name: id.split("@")[0], roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId, title: "Deploys use the shared pipeline", body: "Unique body zqhook", confirmNotDuplicate: true, ...over });
}

async function downvote(id: string, voters = VOTERS) {
  const { vote } = await import("../lib/learnings");
  for (const v of voters) vote(id, v, "not_helpful", "mcp");
}

describe("downvoted-memory nudge for the author", () => {
  it("tells the author, with the title and the link, once, before anything is archived", async () => {
    await linkSession("sess-gc-1", ME);
    const l = await seed();
    await downvote(l.id);

    const out = await prompt("sess-gc-1");
    expect(downLines(out)).toEqual([
      `BAB: colleagues marked your memory "Deploys use the shared pipeline" not helpful; it will be archived if nobody reads or keeps it. (${ORIGIN}/memory/${l.id})`,
    ]);
    // Model-only, no expiry wording, and nobody is named.
    expect(out.systemMessage).toBeUndefined();
    expect(out.hookSpecificOutput!.additionalContext).not.toMatch(/expir/i);
    for (const v of VOTERS) expect(out.hookSpecificOutput!.additionalContext).not.toContain(v);

    expect(downLines(await prompt("sess-gc-1"))).toEqual([]);
    // The owner's other session does not hear it again.
    await linkSession("sess-gc-2", ME);
    expect(downLines(await prompt("sess-gc-2"))).toEqual([]);
  });

  it("says nothing to someone else, and nothing once the memory was kept; a new wave after the keep is told again", async () => {
    await linkSession("sess-gc-3", "kim@example.com");
    const l = await seed();
    await downvote(l.id, VOTERS.slice(0, 3));
    expect(downLines(await prompt("sess-gc-3"))).toEqual([]);

    await linkSession("sess-gc-4", ME);
    const { keepLearning } = await import("../lib/learnings");
    keepLearning(l.id, "kim@example.com", "mcp", "Checked azure-pipelines.yml, 2026-10-07");
    expect(downLines(await prompt("sess-gc-4"))).toEqual([]);

    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE votes SET created_at = datetime('now', '-1 day') WHERE learning_id = ? AND kind = 'keep'").run(l.id);
    await downvote(l.id, VOTERS.slice(3, 6));
    expect(downLines(await prompt("sess-gc-4"))).toHaveLength(1);
  });

  it("says nothing about a standard, a decision or a pinned house rule: those are never archived this way", async () => {
    await linkSession("sess-gc-7", ME);
    const s = await seed({ kind: "standard" });
    await downvote(s.id);
    expect(downLines(await prompt("sess-gc-7"))).toEqual([]);
  });

  it("never carries the verify hint: that is for search results only", async () => {
    await linkSession("sess-gc-5", ME);
    const l = await seed({ authorId: "kim@example.com" }, "kim@example.com");
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET created_at = datetime('now', '-200 days') WHERE id = ?").run(l.id);
    const text = (await prompt("sess-gc-5")).hookSpecificOutput?.additionalContext ?? "";
    expect(text).not.toMatch(/verify/i);
  });
});

describe("maintainer line for protected memories marked not helpful", () => {
  it("counts a pinned practice with 3 not-helpful votes as waiting for a maintainer, and the sweep leaves it", async () => {
    await linkSession("sess-gc-6", MAINT);
    const l = await seed({ kind: "practice" });
    const { setPinned } = await import("../lib/learnings");
    setPinned(l.id, MAINT, true, "ui");
    await downvote(l.id);
    const { sweepUnread } = await import("../lib/maintenance");
    const { getDb } = await import("../lib/db");
    expect(sweepUnread(getDb(), "2040-01-01 00:00:00")).toEqual({ inactive: 0, downvoted: 0 });
    const out = await prompt("sess-gc-6");
    expect(lines(out)).toContain("BAB: 1 flagged or not-helpful memory waits for a maintainer: bab_search flagged true.");
    expect(getDb().prepare("SELECT status FROM learnings WHERE id = ?").get(l.id)).toMatchObject({ status: "active" });
  });
});
