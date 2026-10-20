import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

/**
 * Swarm garbage collection (docs/spec.md "Swarm garbage collection"): the votes agents already cast
 * keep the memory clean. Not-helpful votes from 3 distinct people that outnumber the support archive
 * a learning or practice once no agent has read it for 90 days (the second branch of the unread
 * sweep, lib/maintenance.ts sweepUnread), old memories nobody checked lately are marked
 * `verify: true` in search (lib/swarm-gc.ts), and the usage page counts the clean-up.
 */

let dataDir: string;
const AUTHOR = "ann.author@example.com";
const KEEPER = "kim.keeper@example.com";
const MAINT = "mia.maint@example.com";
const VOTERS = ["v1@example.com", "v2@example.com", "v3@example.com", "v4@example.com", "v5@example.com", "v6@example.com", "v7@example.com"];

/** SQLite's time string for `days` from now: the sweeps take a fixed "now", so the clocks can be tested without waiting. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}
/** Past 90 days without a read (and past INACTIVITY_CLOCK_START + 90), well inside the year: only the downvote rule fires. */
const LATER = inDays(120);
/** Under 90 days: nothing is unread long enough yet. */
const SOON = inDays(30);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-swarm-gc-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_MAINTAINERS = MAINT;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  for (const id of [AUTHOR, KEEPER, MAINT, ...VOTERS]) upsertUser({ id, email: id, name: id.split("@")[0], roles: [] });
}

let seq = 0;
async function mk(over: Record<string, unknown> = {}) {
  await seedUsers();
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({
    authorId: AUTHOR,
    title: `Swarm fixture ${seq} zq${seq}`,
    body: `Body ${seq} about topic zq${seq}x`,
    confirmNotDuplicate: true,
    ...over,
  });
}

async function down(id: string, people: string[]) {
  const { vote } = await import("../lib/learnings");
  for (const p of people) vote(id, p, "not_helpful", "mcp");
}

/** The unread sweep at a fixed time, so the 90-day clock can be tested without waiting for it. */
async function sweep(now = LATER) {
  const { sweepUnread } = await import("../lib/maintenance");
  const { getDb } = await import("../lib/db");
  return sweepUnread(getDb(), now);
}

async function row(id: string) {
  const { getDb } = await import("../lib/db");
  return getDb().prepare("SELECT status, expires_at, created_at, last_accessed_at FROM learnings WHERE id = ?").get(id) as {
    status: string;
    expires_at: string | null;
    created_at: string;
    last_accessed_at: string | null;
  };
}

async function setRow(id: string, sql: string) {
  const { getDb } = await import("../lib/db");
  getDb().prepare(`UPDATE learnings SET ${sql} WHERE id = ?`).run(id);
}

async function auditRows(action: string, id?: string) {
  const { getDb } = await import("../lib/db");
  return getDb()
    .prepare(
      `SELECT actor_id AS actor, entity_id AS id, details FROM audit_log WHERE action = ? ${id ? "AND entity_id = ?" : ""} ORDER BY id`,
    )
    .all(...(id ? [action, id] : [action])) as Array<{ actor: string; id: string; details: string | null }>;
}

/** Moves a memory's creation date back, which also keeps the search index in step (the update trigger). */
async function makeOld(id: string, days: number) {
  const { getDb } = await import("../lib/db");
  getDb().prepare("UPDATE learnings SET created_at = datetime('now', ?) WHERE id = ?").run(`-${days} days`, id);
}

async function ageVotes(id: string, kind: string, days: number) {
  const { getDb } = await import("../lib/db");
  getDb().prepare("UPDATE votes SET created_at = datetime('now', ?) WHERE learning_id = ? AND kind = ?").run(`-${days} days`, id, kind);
}

describe("not-helpful votes archive a memory no agent reads", () => {
  it("needs 3 distinct people: two do nothing, the third archives it once unread for 90 days, audited once", async () => {
    const m = await mk();
    await down(m.id, VOTERS.slice(0, 2));
    expect(await sweep()).toEqual({ inactive: 0, downvoted: 0 });
    expect((await row(m.id)).status).toBe("active");

    await down(m.id, [VOTERS[2]]);
    expect(await sweep()).toEqual({ inactive: 0, downvoted: 1 });
    expect((await row(m.id)).status).toBe("archived");
    const audits = await auditRows("downvote_archived", m.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].actor).toBe("system");
    expect(JSON.parse(audits[0].details!)).toEqual({ notHelpful: 3, support: 0 });
    // Not an inactivity archive: that one has its own row and reason.
    expect(await auditRows("auto-archive", m.id)).toHaveLength(0);

    // Idempotent: it is archived now, so the next sweep leaves it and writes nothing.
    expect(await sweep()).toEqual({ inactive: 0, downvoted: 0 });
    expect(await auditRows("downvote_archived", m.id)).toHaveLength(1);
  });

  it("waits for 90 days without a read, and a read restarts the clock", async () => {
    const m = await mk();
    await down(m.id, VOTERS.slice(0, 3));
    expect((await sweep(SOON)).downvoted).toBe(0);
    expect((await row(m.id)).status).toBe("active");

    // An agent read it 30 days before the sweep: not unread for 90 days.
    await setRow(m.id, `last_accessed_at = '${inDays(90)}'`);
    expect((await sweep(LATER)).downvoted).toBe(0);
    expect((await row(m.id)).status).toBe("active");
    expect((await sweep(inDays(181))).downvoted).toBe(1);
  });

  it("never starts the clock before reads were recorded, so nothing is archived on the day this ships", async () => {
    const m = await mk();
    await setRow(m.id, "created_at = '2020-01-01 00:00:00'");
    await down(m.id, VOTERS.slice(0, 3));
    expect((await sweep("2027-01-04 23:59:59")).downvoted).toBe(0);
    expect((await sweep("2027-01-06 00:00:00")).downvoted).toBe(1);

    // runMaintenance uses the real clock: it reports the count, and archives nothing yet.
    const n = await mk();
    await down(n.id, VOTERS.slice(0, 3));
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();
    expect(runMaintenance(true)).toMatchObject({ learningsInactive: 0, learningsDownvoted: 0 });
    expect((await row(n.id)).status).toBe("active");
  });

  it("counts people, not votes: a repeat by the same person adds nothing", async () => {
    const m = await mk();
    await down(m.id, [VOTERS[0], VOTERS[1], VOTERS[0], VOTERS[1]]);
    expect((await sweep()).downvoted).toBe(0);
    expect((await row(m.id)).status).toBe("active");
  });

  it("other reactions are not not-helpful votes: 2 not helpful plus a flag stays active", async () => {
    const m = await mk();
    const { flag } = await import("../lib/learnings");
    await down(m.id, VOTERS.slice(0, 2));
    flag(m.id, VOTERS[2], "mcp", "Moved to src/x.ts, 2026-10-01");
    await sweep();
    expect((await row(m.id)).status).toBe("active");
  });

  it("works for a practice like for a learning", async () => {
    const m = await mk({ kind: "practice" });
    await down(m.id, VOTERS.slice(0, 3));
    await sweep();
    expect((await row(m.id)).status).toBe("archived");
  });

  it("needs the not-helpful people to outnumber helpful, confirm and kudos: equal stays, one more archives", async () => {
    const m = await mk();
    const { vote, giveKudos } = await import("../lib/learnings");
    await down(m.id, VOTERS.slice(0, 3));
    vote(m.id, VOTERS[3], "helpful", "mcp");
    vote(m.id, VOTERS[4], "helpful", "mcp");
    giveKudos(m.id, VOTERS[5], "The user praised it", "mcp");
    // Those reactions were reads today; the sweep runs months later, so only the votes decide.
    await sweep();
    expect((await row(m.id)).status).toBe("active");

    await down(m.id, [VOTERS[6]]);
    await sweep();
    expect((await row(m.id)).status).toBe("archived");
    expect(JSON.parse((await auditRows("downvote_archived", m.id))[0].details!)).toEqual({ notHelpful: 4, support: 3 });
  });

  it("counts a memory that is also unread for a year as downvoted, and archives the rest as inactive", async () => {
    const voted = await mk();
    const quiet = await mk();
    await down(voted.id, VOTERS.slice(0, 3));
    expect(await sweep(inDays(400))).toEqual({ inactive: 1, downvoted: 1 });
    expect(await auditRows("downvote_archived", voted.id)).toHaveLength(1);
    expect((await auditRows("auto-archive", quiet.id)).map((r) => JSON.parse(r.details!))).toEqual([{ reason: "inactive" }]);
  });

  it("sweepInactive still reports one number, for both reasons", async () => {
    const m = await mk();
    await down(m.id, VOTERS.slice(0, 3));
    const { sweepInactive } = await import("../lib/maintenance");
    const { getDb } = await import("../lib/db");
    expect(sweepInactive(getDb(), LATER)).toBe(1);
  });

  it("leaves archived memories alone", async () => {
    const m = await mk();
    const { retire } = await import("../lib/learnings");
    await down(m.id, VOTERS.slice(0, 3));
    retire(m.id, KEEPER, "mcp", "Replaced by src/y.ts, 2026-10-01");
    await sweep();
    expect((await row(m.id)).status).toBe("archived");
    expect(await auditRows("downvote_archived", m.id)).toHaveLength(0);
  });

  it("the memory page says why it was archived", async () => {
    const m = await mk();
    await down(m.id, VOTERS.slice(0, 3));
    await sweep();
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: DetailPage } = await import("../app/memory/[id]/page");
    const html = await new Response(
      await renderToReadableStream((await DetailPage({ params: Promise.resolve({ id: m.id }) })) as never),
    ).text();
    expect(html).toContain("archived automatically: colleagues marked it not helpful and no agent read it for 90 days");
  });
});

describe("a keep or a confirm answers the not-helpful votes", () => {
  it("a keep with a note restores it and the next sweeps leave it; new votes after it count again", async () => {
    const m = await mk();
    const { keepLearning } = await import("../lib/learnings");
    await down(m.id, VOTERS.slice(0, 3));
    await sweep();
    expect((await row(m.id)).status).toBe("archived");

    keepLearning(m.id, KEEPER, "mcp", "Checked src/x.ts, 2026-10-07");
    expect((await row(m.id)).status).toBe("active");
    // The keep was a read today, but months later only the answered votes keep it.
    expect((await sweep()).downvoted).toBe(0);
    expect((await row(m.id)).status).toBe("active");

    // The keep (a restore, as the memory was archived) happened yesterday; three more people say it
    // is not helpful after it.
    await ageVotes(m.id, "keep", 1);
    await ageVotes(m.id, "restore", 1);
    await down(m.id, VOTERS.slice(3, 6));
    expect((await sweep()).downvoted).toBe(1);
    expect((await row(m.id)).status).toBe("archived");
    expect(await auditRows("downvote_archived", m.id)).toHaveLength(2);
  });

  it("a repeat confirm by the same person inside 30 days answers newer not-helpful votes too", async () => {
    const m = await mk();
    const { confirm } = await import("../lib/learnings");
    confirm(m.id, KEEPER, "Checked src/x.ts, 2026-10-01", "mcp");
    await ageVotes(m.id, "confirm", 5);
    await down(m.id, VOTERS.slice(0, 3));
    expect((await sweep()).downvoted).toBe(1);
    await setRow(m.id, "status = 'active'");
    confirm(m.id, KEEPER, "Checked src/x.ts again, 2026-10-08", "mcp");
    expect((await sweep()).downvoted).toBe(0);
    expect((await row(m.id)).status).toBe("active");
  });

  it("a confirm answers them too", async () => {
    const m = await mk();
    const { confirm } = await import("../lib/learnings");
    await down(m.id, VOTERS.slice(0, 3));
    confirm(m.id, KEEPER, "Checked src/x.ts, 2026-10-07", "mcp");
    expect((await sweep()).downvoted).toBe(0);
    expect((await row(m.id)).status).toBe("active");
  });
});

describe("standards, decisions and pinned house rules are never archived this way", () => {
  it("keeps their status, and only tells a maintainer they wait", async () => {
    const { flaggedStandardsWaitingIds, setPinned } = await import("../lib/learnings");
    const standard = await mk({ kind: "standard" });
    const decision = await mk({ kind: "decision" });
    const pinned = await mk({ kind: "practice" });
    setPinned(pinned.id, MAINT, true, "ui");
    // No valid-until date is not a protection any more: memories have none by default.
    const noDate = await mk({ expiresAt: null });
    const protectedOnes = [standard, decision, pinned];

    for (const m of [...protectedOnes, noDate]) await down(m.id, VOTERS.slice(0, 3));
    // Before the sweep, all four meet the condition; only the protected ones wait for a maintainer.
    expect(flaggedStandardsWaitingIds().sort()).toEqual(protectedOnes.map((m) => m.id).sort());
    await sweep(inDays(5000));

    for (const m of protectedOnes) {
      expect((await row(m.id)).status).toBe("active");
      expect(await auditRows("downvote_archived", m.id)).toHaveLength(0);
    }
    expect((await row(noDate.id)).status).toBe("archived");
    expect(flaggedStandardsWaitingIds().sort()).toEqual(protectedOnes.map((m) => m.id).sort());
  });

  it("two not-helpful votes, or votes that do not outnumber the support, are no signal", async () => {
    const { flaggedStandardsWaitingIds, vote } = await import("../lib/learnings");
    const two = await mk({ kind: "standard" });
    await down(two.id, VOTERS.slice(0, 2));
    const balanced = await mk({ kind: "decision" });
    await down(balanced.id, VOTERS.slice(0, 3));
    for (const v of VOTERS.slice(3, 6)) vote(balanced.id, v, "helpful", "mcp");
    expect(flaggedStandardsWaitingIds()).toEqual([]);
  });

  it("a keep answers the signal, and it is silent while BAB_MAINTAINERS is unset", async () => {
    const { flaggedStandardsWaitingIds, keepLearning } = await import("../lib/learnings");
    const s = await mk({ kind: "standard" });
    await down(s.id, VOTERS.slice(0, 3));
    expect(flaggedStandardsWaitingIds()).toEqual([s.id]);
    delete process.env.BAB_MAINTAINERS;
    expect(flaggedStandardsWaitingIds()).toEqual([]);
    process.env.BAB_MAINTAINERS = MAINT;
    keepLearning(s.id, MAINT, "mcp", "Still holds, checked 2026-10-07");
    expect(flaggedStandardsWaitingIds()).toEqual([]);
  });
});

describe("old memories are marked verify in search", () => {
  async function hit(query: string) {
    const { search } = await import("../lib/learnings");
    return search(query, {}, 20, 0);
  }

  it("marks a live memory older than 90 days with no recent confirm or keep, and nothing else", async () => {
    const old = await mk({ title: "Old gotcha about zqold", body: "Old body zqold" });
    const fresh = await mk({ title: "Fresh gotcha about zqold", body: "Fresh body zqold" });
    await makeOld(old.id, 100);
    await makeOld(fresh.id, 50);
    const hits = await hit("zqold");
    expect(hits.find((h) => h.id === old.id)?.verify).toBe(true);
    expect(hits.find((h) => h.id === fresh.id)?.verify).toBeUndefined();
    // The empty-query list path marks it too.
    expect((await hit("")).find((h) => h.id === old.id)?.verify).toBe(true);
  });

  it("clears after a confirm, a keep or a restore in the last 90 days, but not after an old one", async () => {
    const { confirm, keepLearning } = await import("../lib/learnings");
    const a = await mk({ title: "Confirmed gotcha zqclear", body: "Body zqclear a" });
    const b = await mk({ title: "Kept gotcha zqclear", body: "Body zqclear b" });
    const c = await mk({ title: "Long ago confirmed gotcha zqclear", body: "Body zqclear c" });
    for (const m of [a, b, c]) await makeOld(m.id, 200);

    expect((await hit("zqclear")).every((h) => h.verify === true)).toBe(true);
    confirm(a.id, KEEPER, "Checked src/a.ts, 2026-10-07", "mcp");
    keepLearning(b.id, KEEPER, "mcp", "Still true, 2026-10-07");
    confirm(c.id, KEEPER, "Checked src/c.ts, 2026-06-01", "mcp");
    await ageVotes(c.id, "confirm", 120);

    const hits = await hit("zqclear");
    expect(hits.find((h) => h.id === a.id)?.verify).toBeUndefined();
    expect(hits.find((h) => h.id === b.id)?.verify).toBeUndefined();
    expect(hits.find((h) => h.id === c.id)?.verify).toBe(true);
  });

  it("does not mark an archived memory, and a correction starts young", async () => {
    const { retire, createWithSupersedes } = await import("../lib/learnings");
    const old = await mk({ title: "Archived gotcha zqarch", body: "Body zqarch" });
    await makeOld(old.id, 200);
    retire(old.id, KEEPER, "mcp", "Replaced, 2026-10-01");
    const { search } = await import("../lib/learnings");
    expect(search("zqarch", { status: "archived" }, 20, 0)[0].verify).toBeUndefined();

    const target = await mk({ title: "Corrected gotcha zqcorr", body: "Body zqcorr" });
    await makeOld(target.id, 200);
    const fix = createWithSupersedes(
      { authorId: KEEPER, title: "Corrected gotcha zqcorr v2", body: "Better body zqcorr", confirmNotDuplicate: true },
      [target.id],
      "mcp",
    );
    expect((await hit("zqcorr")).find((h) => h.id === fix.id)?.verify).toBeUndefined();
  });

  it("a confirm on a memory that needed checking is audited as verified; on a fresh one it is not", async () => {
    const { confirm } = await import("../lib/learnings");
    const old = await mk();
    const fresh = await mk();
    await makeOld(old.id, 150);
    confirm(old.id, KEEPER, "Checked src/old.ts, 2026-10-07", "mcp");
    confirm(fresh.id, KEEPER, "Checked src/fresh.ts, 2026-10-07", "mcp");
    expect(JSON.parse((await auditRows("confirm", old.id))[0].details!)).toEqual({ verified: true });
    expect((await auditRows("confirm", fresh.id))[0].details).toBeNull();
  });

  it("bab_search and GET /api/learnings carry the hint only when a result is marked", async () => {
    await seedUsers();
    const { findTool } = await import("../lib/mcp");
    const { VERIFY_HINT } = await import("../lib/swarm-gc");
    const actor = { id: KEEPER, email: KEEPER, name: "Kim" } as never;
    const old = await mk({ title: "Hint gotcha zqhint", body: "Body zqhint" });
    const run = (q: string) => JSON.parse(findTool("bab_search")!.run(actor, { query: q }));

    expect(run("zqhint").verifyHint).toBeUndefined();
    expect(run("zqhint").results[0].stale).toBeUndefined();
    await makeOld(old.id, 100);
    const out = run("zqhint");
    expect(out.results[0].verify).toBe(true);
    expect(out.verifyHint).toBe(VERIFY_HINT);
    expect(out.verifyHint).toMatch(/confirm it.*correct it.*flag or retire it/);
    // #32: the warning sits on the result itself, right after its title.
    expect(Object.keys(out.results[0]).slice(0, 3)).toEqual(["id", "title", "stale"]);
    expect(out.results[0].stale).toMatch(/^Saved 3 months ago and not confirmed since: it may be out of date\. Check it at the source/);
    expect(run("zqhint").results.length).toBe(1);

    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": KEEPER, "x-bab-actor-name": "Kim" }),
      cookies: async () => ({ get: () => undefined }),
    }));
    const { GET } = await import("../app/api/learnings/route");
    const body = await (await GET(new NextRequest("http://x/api/learnings?q=zqhint"))).json();
    expect(body.results[0].verify).toBe(true);
    expect(body.verifyHint).toBe(VERIFY_HINT);
    const none = await (await GET(new NextRequest("http://x/api/learnings?q=zqnothing"))).json();
    expect(none.verifyHint).toBeUndefined();
  });

  it("the texts agents read say what to do with a verify result", async () => {
    const { TOOLS } = await import("../lib/mcp");
    const text = (name: string) => TOOLS.find((t) => t.name === name)!.description;
    expect(text("bab_search")).toContain("verify: true");
    expect(text("bab_search")).toContain("check it against code or docs in this task, then confirm it with where you checked, correct it with bab_learn supersedes, or flag or retire it");
    expect(text("bab_react")).toContain("A search result marked verify: true is over 90 days old");
    expect(text("bab_react")).toContain("Swarm clean-up: when 3 or more colleagues mark a learning or practice not_helpful");
    const { getInstructions } = await import("../lib/instructions");
    const skill = getInstructions("https://bab.example.com").skill.replace(/\*\*/g, "").replace(/\s+/g, " ");
    expect(skill).toContain("verify: true");
    expect(skill).toContain("check it against code or docs in this task, then confirm it");
    expect(skill).toContain("three or more colleagues mark a `learning` or `practice` not helpful");
    expect(skill).toContain("will be archived if nobody reads or keeps it");
  });
});

describe("clean-up numbers for /usage", () => {
  it("counts each kind of clean-up in its week", async () => {
    const { flag, retire, keepLearning, confirm } = await import("../lib/learnings");
    const { cleanupByWeek, lastWeeks, usageReport } = await import("../lib/usage");

    const downvoted = await mk();
    await down(downvoted.id, VOTERS.slice(0, 3));
    await sweep();
    const quiet = await mk();
    await sweep(inDays(400));
    expect((await row(quiet.id)).status).toBe("archived");

    const flagged = await mk();
    const retired = await mk();
    flag(flagged.id, VOTERS[0], "mcp", "Moved to src/x.ts, 2026-10-01");
    flag(flagged.id, VOTERS[1], "mcp", "Moved to src/x.ts, 2026-10-02");
    retire(retired.id, KEEPER, "mcp", "Replaced by src/y.ts, 2026-10-01");
    keepLearning(downvoted.id, KEEPER, "mcp", "Checked src/z.ts, 2026-10-07");
    keepLearning(retired.id, KEEPER, "mcp", "Retired by mistake, src/y.ts is gone");
    const old = await mk();
    await makeOld(old.id, 120);
    confirm(old.id, KEEPER, "Checked src/old.ts, 2026-10-07", "mcp");
    const young = await mk();
    confirm(young.id, KEEPER, "Checked src/young.ts, 2026-10-07", "mcp");

    const weeks = lastWeeks(new Date());
    const cleanup = cleanupByWeek(weeks);
    const { USAGE_WEEKS } = await import("../lib/usage");
    const last = USAGE_WEEKS - 1;
    expect(cleanup).toHaveLength(USAGE_WEEKS);
    expect(cleanup.slice(0, last).every((w) => Object.values(w).every((v) => typeof v === "string" || v === 0))).toBe(true);
    expect(cleanup[last]).toMatchObject({ week: weeks[last], inactive: 1, downvoted: 1, flagged: 1, retired: 1, kept: 2, verified: 1 });
    expect(usageReport(new Date()).cleanup).toEqual(cleanup);
  });
});
