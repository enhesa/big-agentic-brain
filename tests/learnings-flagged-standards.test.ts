import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * "A maintainer decides" made real: others flag a standard or decision
 * with their evidence, and flaggedStandardsWaiting says how many are still waiting for a
 * maintainer. Waiting means: live (active), flagged, and the newest flag is newer than
 * any confirm by a maintainer, or keep or restore by a maintainer, after it. A supersede or retire
 * takes the entry out of the live statuses. Maintainers come from BAB_MAINTAINERS.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-flagged-standards-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_MAINTAINERS = "maint-1@example.com, Maint-2@example.com";
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  for (const id of ["author-1", "flagger-1", "flagger-2", "maint-1@example.com", "maint-2@example.com", "agent-1"]) {
    upsertUser({ id, email: `${id}@example.com`, name: id, roles: [] });
  }
}

let seq = 0;
async function mk(kind: "learning" | "practice" | "standard" | "decision" = "standard", over: Record<string, unknown> = {}) {
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({
    authorId: "author-1",
    title: `Fixture ${seq} zq${seq}`,
    body: `Body ${seq} about topic zq${seq}x`,
    confirmNotDuplicate: true,
    kind,
    ...over,
  });
}

/** Flags it as `voter`, then moves every flag on it `days` back so a later answer is clearly later. */
async function flagAged(id: string, voter: string, days: number) {
  const { flag } = await import("../lib/learnings");
  const { getDb } = await import("../lib/db");
  flag(id, voter, "mcp", "Moved to src/lib/x.ts, 2026-10-01");
  getDb()
    .prepare("UPDATE votes SET created_at = datetime('now', ?) WHERE learning_id = ? AND voter_id = ? AND kind = 'flag'")
    .run(`-${days} days`, id, voter);
}

async function age(id: string, voter: string, kind: string, days: number) {
  const { getDb } = await import("../lib/db");
  getDb()
    .prepare("UPDATE votes SET created_at = datetime('now', ?) WHERE learning_id = ? AND voter_id = ? AND kind = ?")
    .run(`-${days} days`, id, voter, kind);
}

async function waiting() {
  const { flaggedStandardsWaiting } = await import("../lib/learnings");
  return flaggedStandardsWaiting();
}

describe("what waits", () => {
  it("a flagged standard and a flagged decision wait; nothing else does", async () => {
    await seedUsers();
    const standard = await mk("standard");
    const decision = await mk("decision");
    const learning = await mk("learning");
    const practice = await mk("practice");
    const unflagged = await mk("standard");
    expect(await waiting()).toBe(0);
    await flagAged(standard.id, "flagger-1", 2);
    expect(await waiting()).toBe(1);
    await flagAged(decision.id, "flagger-1", 2);
    expect(await waiting()).toBe(2);
    // A learning or practice is the fleet's: it is archived by two flags, not decided by a maintainer.
    await flagAged(learning.id, "flagger-1", 2);
    await flagAged(practice.id, "flagger-1", 2);
    expect(unflagged.kind).toBe("standard");
    expect(await waiting()).toBe(2);
  });

  it("two flags on one entry are one waiting entry", async () => {
    await seedUsers();
    const s = await mk("standard");
    await flagAged(s.id, "flagger-1", 3);
    await flagAged(s.id, "flagger-2", 2);
    expect(await waiting()).toBe(1);
  });

  it("is 0 while BAB_MAINTAINERS is unset: nobody could decide", async () => {
    await seedUsers();
    await flagAged((await mk("standard")).id, "flagger-1", 2);
    delete process.env.BAB_MAINTAINERS;
    expect(await waiting()).toBe(0);
  });
});

describe("what ends the wait", () => {
  it("a maintainer's confirm after the newest flag does; a non-maintainer's does not", async () => {
    await seedUsers();
    const s = await mk("standard");
    await flagAged(s.id, "flagger-1", 2);
    const { confirm } = await import("../lib/learnings");
    confirm(s.id, "agent-1", "src/lib/x.ts, 2026-10-02");
    expect(await waiting()).toBe(1);
    confirm(s.id, "maint-1@example.com", "Checked src/lib/x.ts, still holds, 2026-10-02", "mcp");
    expect(await waiting()).toBe(0);
  });

  it("a maintainer's keep after the newest flag does, and it moves nothing on the memory itself", async () => {
    await seedUsers();
    const s = await mk("decision");
    await flagAged(s.id, "flagger-1", 2);
    const { keepLearning, getById } = await import("../lib/learnings");
    keepLearning(s.id, "agent-1", "mcp");
    expect(await waiting()).toBe(1);
    const kept = keepLearning(s.id, "maint-2@example.com", "mcp");
    expect(kept.changed).toBe(false);
    expect(getById(s.id)!.expires_at).toBeNull(); // nothing moved, and the keep still counts
    expect(await waiting()).toBe(0);
  });

  it("a retire or a correction takes the entry out, a restore by a maintainer answers the flag", async () => {
    await seedUsers();
    const retired = await mk("standard");
    const corrected = await mk("decision");
    const restored = await mk("standard");
    for (const l of [retired, corrected, restored]) await flagAged(l.id, "flagger-1", 3);
    expect(await waiting()).toBe(3);

    const { retire, createWithSupersedes, keepLearning } = await import("../lib/learnings");
    retire(retired.id, "maint-1@example.com", "mcp", "Replaced by the new pipeline, 2026-10-02");
    expect(await waiting()).toBe(2);

    const fixed = createWithSupersedes(
      { authorId: "maint-1@example.com", title: "Corrected decision zq", body: "Corrected body about zqy", kind: "decision", confirmNotDuplicate: true },
      [corrected.id],
    );
    expect(fixed.kind).toBe("decision");
    expect(await waiting()).toBe(1); // the correction has no flags of its own

    retire(restored.id, "agent-1", "mcp", "Looked stale in the old pipeline");
    expect(await waiting()).toBe(0);
    keepLearning(restored.id, "maint-1@example.com", "mcp", "Checked, still holds");
    expect(await waiting()).toBe(0); // live again, but a maintainer answered after the flag
  });
});

describe("a maintainer's answer outlives the audit purge", () => {
  it("a keep and a restore are read from votes, so maintenance past the audit retention does not reopen the entry", async () => {
    await seedUsers();
    const kept = await mk("standard");
    const restored = await mk("decision");
    await flagAged(kept.id, "flagger-1", 200);
    await flagAged(restored.id, "flagger-1", 200);
    const { keepLearning, retire } = await import("../lib/learnings");
    keepLearning(kept.id, "maint-1@example.com", "mcp");
    retire(restored.id, "agent-1", "mcp", "Looked stale in the old pipeline");
    keepLearning(restored.id, "maint-2@example.com", "mcp", "Checked, still holds");
    expect(await waiting()).toBe(0);

    // Age every trace of the answers past the audit retention (365 days by default), then sweep.
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare("UPDATE votes SET created_at = datetime('now', '-190 days') WHERE kind IN ('keep', 'restore', 'retire')").run();
    db.prepare("UPDATE audit_log SET at = datetime('now', '-400 days')").run();
    const { runMaintenance } = await import("../lib/maintenance");
    runMaintenance(true);
    const left = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('keep', 'restored')").get() as { n: number };
    expect(left.n).toBe(0);
    expect(await waiting()).toBe(0);
  });
});

describe("the flagged filter finds exactly what the nudge counts", () => {
  it("search and searchTotal with flagged match flaggedStandardsWaiting, even when page one of a kind search omits it", async () => {
    await seedUsers();
    const { search, searchTotal } = await import("../lib/learnings");
    const flaggedOne = await mk("standard");
    const flaggedTwo = await mk("decision");
    await flagAged(flaggedOne.id, "flagger-1", 2);
    await flagAged(flaggedTwo.id, "flagger-1", 2);
    // Newer, unflagged standards and decisions push the flagged ones off page one of a kind search.
    for (let i = 0; i < 6; i++) await mk(i % 2 ? "standard" : "decision");
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET created_at = datetime('now', '-3 days') WHERE id IN (?, ?)").run(flaggedOne.id, flaggedTwo.id);

    const byKind = search("", { kind: ["standard", "decision"] }, 5).map((r) => r.id);
    expect(byKind).not.toContain(flaggedOne.id);

    const hits = search("", { flagged: true }, 5).map((r) => r.id).sort();
    expect(hits).toEqual([flaggedOne.id, flaggedTwo.id].sort());
    expect(searchTotal("", { flagged: true })).toBe(await waiting());
    expect(await waiting()).toBe(2);

    // Also with a text query, and an answered entry drops out of both.
    expect(search("zq", { flagged: true }, 5)).toHaveLength(2);
    expect(searchTotal("zq", { flagged: true })).toBe(2);
    const { confirm } = await import("../lib/learnings");
    confirm(flaggedOne.id, "maint-1@example.com", "Checked src/lib/x.ts, 2026-10-02", "mcp");
    expect(search("", { flagged: true }, 5).map((r) => r.id)).toEqual([flaggedTwo.id]);
    expect(searchTotal("", { flagged: true })).toBe(await waiting());
  });

  it("is empty while BAB_MAINTAINERS is unset, like the count", async () => {
    await seedUsers();
    await flagAged((await mk("standard")).id, "flagger-1", 2);
    delete process.env.BAB_MAINTAINERS;
    const { search, searchTotal } = await import("../lib/learnings");
    expect(search("", { flagged: true })).toEqual([]);
    expect(searchTotal("", { flagged: true })).toBe(0);
  });

  it("parseFlaggedFilter accepts true, 'true' and '1', ignores false, and refuses the rest", async () => {
    const { parseFlaggedFilter } = await import("../lib/learnings");
    expect([true, "true", "1"].map(parseFlaggedFilter)).toEqual([true, true, true]);
    expect([undefined, null, "", false, "false", "0"].map(parseFlaggedFilter)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(() => parseFlaggedFilter("yes")).toThrow(/flagged/);
  });
});

describe("what reopens it", () => {
  it("a flag by someone else after the maintainer's answer", async () => {
    await seedUsers();
    const s = await mk("standard");
    await flagAged(s.id, "flagger-1", 3);
    const { confirm } = await import("../lib/learnings");
    confirm(s.id, "maint-1@example.com", "Checked src/lib/x.ts, 2026-10-01", "mcp");
    await age(s.id, "maint-1@example.com", "confirm", 2);
    expect(await waiting()).toBe(0);

    await flagAged(s.id, "flagger-2", 0); // now, after the confirm
    expect(await waiting()).toBe(1);
  });

  it("not a repeat flag by the same person: it keeps its date and only replaces the note", async () => {
    await seedUsers();
    const s = await mk("standard");
    await flagAged(s.id, "flagger-1", 3);
    const { confirm, flag } = await import("../lib/learnings");
    confirm(s.id, "maint-1@example.com", "Checked src/lib/x.ts, 2026-10-01", "mcp");
    await age(s.id, "maint-1@example.com", "confirm", 2);
    flag(s.id, "flagger-1", "mcp", "New evidence: the file moved again, 2026-10-02");
    expect(await waiting()).toBe(0);
  });

  it("a maintainer who confirmed recently answers a newer flag by confirming again", async () => {
    await seedUsers();
    const s = await mk("standard");
    const { confirm } = await import("../lib/learnings");
    confirm(s.id, "maint-1@example.com", "Checked src/lib/x.ts, 2026-09-30", "mcp");
    await age(s.id, "maint-1@example.com", "confirm", 3);
    await flagAged(s.id, "flagger-1", 2); // after the confirm
    expect(await waiting()).toBe(1);

    // Inside the 30-day window a repeat is normally a no-op; after a newer flag it is an answer.
    const again = confirm(s.id, "maint-1@example.com", "Rechecked src/lib/x.ts after the flag, 2026-10-02", "mcp");
    expect(again.changed).toBe(true);
    expect(await waiting()).toBe(0);
  });
});
