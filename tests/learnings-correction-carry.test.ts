import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A correction that replaces exactly one entry starts with half of that entry's positive points
 * (rounded down, capped at 4), so fixing a good memory does not reset what colleagues said about
 * it. Negative points never carry, and a consolidation of several entries carries nothing.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-carry-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
  for (let i = 1; i <= 8; i++) upsertUser({ id: `voter-${i}`, email: `v${i}@example.com`, name: `Voter ${i}`, roles: [] });
}

let seq = 0;
async function mk(authorId = "author-1") {
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({ authorId, title: `Fixture ${seq} zq${seq}`, body: `Body ${seq} about topic zq${seq}x`, confirmNotDuplicate: true });
}

async function react(id: string, helpful: number, confirms = 0, flags = 0) {
  const { vote, confirm, flag } = await import("../lib/learnings");
  let n = 1;
  for (let i = 0; i < helpful; i++) vote(id, `voter-${n++}`, "helpful");
  for (let i = 0; i < confirms; i++) confirm(id, `voter-${n++}`, "src/a.ts, 2026-10-02");
  for (let i = 0; i < flags; i++) flag(id, `voter-${n++}`, "ui", "outdated");
}

async function correct(oldIds: string[]) {
  const { createWithSupersedes } = await import("../lib/learnings");
  seq += 1;
  return createWithSupersedes(
    { authorId: "author-1", title: `Correction ${seq} zq${seq}`, body: `Fixed body ${seq} about zq${seq}y`, confirmNotDuplicate: true },
    oldIds,
  );
}

async function standingOf(id: string) {
  const { standingsFor, getById } = await import("../lib/learnings");
  return standingsFor([getById(id)!]).get(id)!;
}

describe("standingsFor carries standing across a one-entry correction", () => {
  it("half the old entry's positive points, rounded down: 5 points carry 2", async () => {
    await seedUsers();
    const old = await mk();
    await react(old.id, 1, 2); // helpful 1 + confirm 2*2 = 5
    const fixed = await correct([old.id]);
    const s = await standingOf(fixed.id);
    expect(s.points).toBe(2);
    expect(s.standingReason).toContain("carries 2 from the entry it replaces");
    expect(s.standing).toBe("fair");
  });

  it("caps at 4", async () => {
    await seedUsers();
    const old = await mk();
    await react(old.id, 0, 6); // 12 points
    const fixed = await correct([old.id]);
    const s = await standingOf(fixed.id);
    expect(s.points).toBe(4);
    expect(s.standingReason).toContain("carries 4 from the entry it replaces");
  });

  it("adds to the new entry's own reactions", async () => {
    await seedUsers();
    const old = await mk();
    await react(old.id, 0, 4); // 8 -> carries 4
    const fixed = await correct([old.id]);
    const { vote } = await import("../lib/learnings");
    vote(fixed.id, "voter-8", "helpful");
    expect((await standingOf(fixed.id)).points).toBe(5);
  });

  it("an old entry with 1 point carries nothing and says nothing", async () => {
    await seedUsers();
    const old = await mk();
    await react(old.id, 1);
    const fixed = await correct([old.id]);
    const s = await standingOf(fixed.id);
    expect(s.points).toBe(0);
    expect(s.standingReason).not.toContain("carries");
  });

  it("negative points never carry", async () => {
    await seedUsers();
    const old = await mk();
    await react(old.id, 0, 1, 1); // confirm 2 - flag 3 = -1 (one flag does not archive)
    const fixed = await correct([old.id]);
    const s = await standingOf(fixed.id);
    expect(s.points).toBe(0);
    expect(s.standingReason).not.toContain("carries");
  });

  it("a consolidation of several entries carries nothing", async () => {
    await seedUsers();
    const a = await mk();
    const b = await mk();
    await react(a.id, 0, 3);
    await react(b.id, 0, 3);
    const merged = await correct([a.id, b.id]);
    const s = await standingOf(merged.id);
    expect(s.points).toBe(0);
    expect(s.standingReason).not.toContain("carries");
  });

  it("an entry that replaces nothing carries nothing", async () => {
    await seedUsers();
    const l = await mk();
    await react(l.id, 0, 2);
    expect((await standingOf(l.id)).standingReason).not.toContain("carries");
  });

  it("the carry is shown on search results too, and works for a page of rows", async () => {
    await seedUsers();
    const old = await mk();
    await react(old.id, 0, 2); // 4 -> carries 2
    const fixed = await correct([old.id]);
    const other = await mk();
    const { standingsFor, getById } = await import("../lib/learnings");
    const map = standingsFor([getById(fixed.id)!, getById(other.id)!]);
    expect(map.get(fixed.id)!.points).toBe(2);
    expect(map.get(other.id)!.points).toBe(0);
  });

  it("the old entry keeps its own standing", async () => {
    await seedUsers();
    const old = await mk();
    await react(old.id, 0, 2);
    await correct([old.id]);
    expect((await standingOf(old.id)).points).toBe(4);
  });
});

/**
 * The carry survives a chain (owner review, 2026-10-02): what B passes on to C is half of B's own
 * points plus what B carried from A, capped at 4. Before, C got 0 whenever B had no votes of its
 * own, because only B's votes were counted.
 */
describe("standingsFor carries standing down a chain of corrections", () => {
  it("A -> B -> C: B has no votes of its own and still passes a share on to C", async () => {
    await seedUsers();
    const a = await mk();
    await react(a.id, 0, 4); // 8 points -> B carries 4
    const b = await correct([a.id]);
    const c = await correct([b.id]);
    expect((await standingOf(b.id)).points).toBe(4);
    const s = await standingOf(c.id);
    expect(s.points).toBe(2); // half of (0 own + 4 carried)
    expect(s.standingReason).toContain("carries 2 from the entry it replaces");
    expect(s.standing).toBe("fair");
  });

  it("B's own votes add to what it carried: half of the sum is passed on", async () => {
    await seedUsers();
    const a = await mk();
    await react(a.id, 0, 2); // 4 points -> B carries 2
    const b = await correct([a.id]);
    const { vote } = await import("../lib/learnings");
    vote(b.id, "voter-5", "helpful");
    vote(b.id, "voter-6", "helpful"); // B: 2 own + 2 carried = 4 points on its page
    expect((await standingOf(b.id)).points).toBe(4);
    expect((await standingOf((await correct([b.id])).id)).points).toBe(2); // half of 4
  });

  it("is still capped at 4 however much B has", async () => {
    await seedUsers();
    const a = await mk();
    await react(a.id, 0, 6); // 12 points -> B carries 4
    const b = await correct([a.id]);
    const { confirm } = await import("../lib/learnings");
    for (let i = 1; i <= 4; i++) confirm(b.id, `voter-${i}`, "src/a.ts, 2026-10-02"); // 8 own + 4 carried
    expect((await standingOf((await correct([b.id])).id)).points).toBe(4);
  });

  it("fades along a long chain: 4, 2, 1, then nothing", async () => {
    await seedUsers();
    const a = await mk();
    await react(a.id, 0, 4); // 8 points
    const b = await correct([a.id]);
    const c = await correct([b.id]);
    const d = await correct([c.id]);
    const e = await correct([d.id]);
    expect(await Promise.all([b, c, d, e].map(async (x) => (await standingOf(x.id)).points))).toEqual([4, 2, 1, 0]);
  });

  it("a flag on B is set against what it carried", async () => {
    await seedUsers();
    const a = await mk();
    await react(a.id, 0, 4); // B carries 4
    const b = await correct([a.id]);
    const { flag } = await import("../lib/learnings");
    flag(b.id, "voter-5", "ui", "outdated"); // B: -3 own + 4 carried = 1 point; one flag does not archive
    expect((await standingOf(b.id)).points).toBe(1);
    expect((await standingOf((await correct([b.id])).id)).points).toBe(0); // (-3 + 4) / 2 -> 0
  });

  it("a consolidation in the middle ends the chain", async () => {
    await seedUsers();
    const a = await mk();
    const x = await mk();
    await react(a.id, 0, 4);
    const b = await correct([a.id]); // carries 4
    const merged = await correct([b.id, x.id]); // a consolidation carries nothing
    expect((await standingOf(merged.id)).points).toBe(0);
    expect((await standingOf((await correct([merged.id])).id)).points).toBe(0);
  });

  it("one call gives every entry of a page its own value, chain members included", async () => {
    await seedUsers();
    const a = await mk();
    await react(a.id, 0, 4);
    const b = await correct([a.id]);
    const c = await correct([b.id]);
    const other = await mk();
    const { standingsFor, getById } = await import("../lib/learnings");
    const map = standingsFor([c, a, other, b].map((l) => getById(l.id)!));
    expect([a, b, c, other].map((l) => map.get(l.id)!.points)).toEqual([8, 4, 2, 0]);
  });

  it("search results show the chain carry too", async () => {
    await seedUsers();
    const a = await mk();
    await react(a.id, 0, 4);
    const b = await correct([a.id]);
    const c = await correct([b.id]);
    const { search } = await import("../lib/learnings");
    const hit = search("", { status: "all" }, 50).find((r) => r.id === c.id)!;
    expect(hit.standingReason).toContain("carries 2 from the entry it replaces");
  });

  it("a cycle written around create() does not hang or recurse forever", async () => {
    await seedUsers();
    const a = await mk();
    const b = await mk();
    const { getDb } = await import("../lib/db");
    getDb().prepare("INSERT INTO supersession_links (old_id, new_id) VALUES (?, ?)").run(a.id, b.id);
    getDb().prepare("INSERT INTO supersession_links (old_id, new_id) VALUES (?, ?)").run(b.id, a.id);
    expect((await standingOf(a.id)).points).toBe(0);
    expect((await standingOf(b.id)).points).toBe(0);
  });
});
