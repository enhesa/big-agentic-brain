import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { carryOver, computeStanding, STANDING_CARRY_CAP, STANDING_FAIR_AT, STANDING_STALE_DAYS, STANDING_STRONG_AT } from "../lib/standing";
import type { StandingInput } from "../lib/standing";

const NOW = Date.parse("2026-10-01T00:00:00Z");

function v(over: Partial<StandingInput>): StandingInput {
  return { helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 0, lastConfirmAt: null, ...over };
}

const L = { source: "native" as const, created_at: "2026-09-20 00:00:00" };
// Provenance is a claim anyone can write, so only a maintainer's mirror earns the bonus (BAB_MAINTAINERS).
const M = { source: "confluence" as const, created_at: "2026-09-20 00:00:00", authorIsMaintainer: true };
const M_OTHER = { source: "confluence" as const, created_at: "2026-09-20 00:00:00", authorIsMaintainer: false };

describe("computeStanding", () => {
  it("exposes the thresholds", () => {
    expect([STANDING_STRONG_AT, STANDING_FAIR_AT, STANDING_STALE_DAYS]).toEqual([6, 2, 180]);
  });

  it("a new native entry is weak with 0 points", () => {
    expect(computeStanding(v({}), L, NOW)).toMatchObject({ standing: "weak", points: 0, standingReason: "no reactions yet" });
  });

  it("one confirm makes it fair", () => {
    expect(computeStanding(v({ confirm: 1, lastConfirmAt: "2026-09-29 00:00:00" }), L, NOW)).toMatchObject({ standing: "fair", points: 2 });
  });

  it("three confirms are strong; two confirms and a helpful vote are fair", () => {
    expect(computeStanding(v({ confirm: 3, lastConfirmAt: "2026-09-19 00:00:00" }), L, NOW).standing).toBe("strong"); // 6
    expect(computeStanding(v({ confirm: 2, helpful: 1, lastConfirmAt: "2026-09-29 00:00:00" }), L, NOW)).toMatchObject({ standing: "fair", points: 5 });
  });

  it("a confluence mirror by a maintainer starts fair, and strong with two confirms", () => {
    expect(computeStanding(v({}), M, NOW)).toMatchObject({ standing: "fair", points: 2 });
    expect(computeStanding(v({ confirm: 2, lastConfirmAt: "2026-09-29 00:00:00" }), M, NOW).standing).toBe("strong"); // 2+4
  });

  it("a confluence claim by anyone else gets no bonus and no mirror phrase", () => {
    expect(computeStanding(v({}), M_OTHER, NOW)).toMatchObject({ standing: "weak", points: 0, standingReason: "no reactions yet" });
    // An omitted flag fails closed, like a non-maintainer.
    expect(computeStanding(v({}), { source: "confluence", created_at: L.created_at }, NOW)).toMatchObject({ standing: "weak", points: 0 });
    expect(computeStanding(v({ confirm: 1, lastConfirmAt: "2026-09-29 00:00:00" }), M_OTHER, NOW)).toMatchObject({ standing: "fair", points: 2 });
  });

  it("kudos count 2, not_helpful subtracts 1, a flag subtracts 3", () => {
    expect(computeStanding(v({ kudos: 3 }), L, NOW).points).toBe(6);
    expect(computeStanding(v({ helpful: 2, not_helpful: 1 }), L, NOW).points).toBe(1);
    expect(computeStanding(v({ confirm: 3, lastConfirmAt: "2026-09-29 00:00:00", flag: 1 }), L, NOW)).toMatchObject({ points: 3, standing: "fair" });
  });

  it("a flagged mirror falls to weak (2 - 3)", () => {
    expect(computeStanding(v({ flag: 1 }), M, NOW)).toMatchObject({ points: -1, standing: "weak" });
  });

  it("boundaries: 5 points is fair, 6 is strong, 1 is weak, 2 is fair", () => {
    expect(computeStanding(v({ helpful: 5 }), L, NOW).standing).toBe("fair");
    expect(computeStanding(v({ helpful: 6 }), L, NOW).standing).toBe("strong");
    expect(computeStanding(v({ helpful: 1 }), L, NOW).standing).toBe("weak");
    expect(computeStanding(v({ helpful: 2 }), L, NOW).standing).toBe("fair");
  });

  describe("age", () => {
    const strong = { helpful: 6 };

    it("exactly 180 days since the newest of created_at and the last confirm is not stale", () => {
      const r = computeStanding(v(strong), { source: "native", created_at: "2026-04-04 00:00:00" }, NOW);
      expect(r.standing).toBe("strong");
      expect(r.standingReason).not.toContain("not refreshed");
    });

    it("one second over 180 days drops one level (strong to fair)", () => {
      const r = computeStanding(v(strong), { source: "native", created_at: "2026-04-03 23:59:59" }, NOW);
      expect(r.standing).toBe("fair");
      expect(r.standingReason).toContain("not refreshed in over 180 days");
    });

    it("the newest confirm resets the clock even when created_at is old", () => {
      const r = computeStanding(
        v({ confirm: 3, lastConfirmAt: "2026-09-21 00:00:00" }),
        { source: "native", created_at: "2025-08-27 00:00:00" },
        NOW,
      );
      expect(r.standing).toBe("strong");
    });

    it("an old entry with only an old confirm drops: strong to fair, fair to weak, weak stays weak", () => {
      const old = { source: "native" as const, created_at: "2025-12-01 00:00:00" };
      expect(computeStanding(v({ confirm: 3, lastConfirmAt: "2026-01-01 00:00:00" }), old, NOW).standing).toBe("fair");
      expect(computeStanding(v({ confirm: 1, lastConfirmAt: "2026-01-01 00:00:00" }), old, NOW).standing).toBe("weak");
      expect(computeStanding(v({}), old, NOW).standing).toBe("weak");
    });
  });

  describe("standingReason: counts and dates only", () => {
    it("3 confirmations, last 12 days ago", () => {
      expect(computeStanding(v({ confirm: 3, lastConfirmAt: "2026-09-19 00:00:00" }), L, NOW).standingReason).toBe("3 confirmations, last 12 days ago");
    });

    it("singular and zero-day wording", () => {
      expect(computeStanding(v({ confirm: 1, lastConfirmAt: "2026-10-01 00:00:00" }), L, NOW).standingReason).toBe("1 confirmation, last today");
      expect(computeStanding(v({ confirm: 1, lastConfirmAt: "2026-09-30 00:00:00" }), L, NOW).standingReason).toBe("1 confirmation, last 1 day ago");
    });

    it("joins parts with a comma: confirmations, flags, mirror, stale, replaced", () => {
      const r = computeStanding(
        v({ confirm: 2, lastConfirmAt: "2026-03-15 00:00:00", flag: 1, replaced: { entries: 1, confirmations: 3 } }),
        { source: "confluence", created_at: "2026-01-01 00:00:00", authorIsMaintainer: true },
        NOW,
      );
      expect(r.standingReason).toBe(
        "2 confirmations, last 200 days ago, 1 flag, mirrors a Confluence page, not refreshed in over 180 days, replaces an entry with 3 confirmations",
      );
    });

    it("replaces N entries wording", () => {
      expect(computeStanding(v({ replaced: { entries: 2, confirmations: 5 } }), L, NOW).standingReason).toBe("replaces 2 entries with 5 confirmations");
      expect(computeStanding(v({ replaced: { entries: 2, confirmations: 0 } }), L, NOW).standingReason).toBe("no reactions yet");
    });

    it("never contains note text", () => {
      // StandingInput has no note field, so a note cannot be passed in on purpose; an extra property
      // on the object is ignored too.
      const withNote = { ...v({ confirm: 1, lastConfirmAt: "2026-09-29 00:00:00" }), note: "NOTE-SENTINEL-4471" } as StandingInput;
      expect(computeStanding(withNote, L, NOW).standingReason).not.toContain("NOTE-SENTINEL-4471");
      expect(Object.keys(v({})).sort()).toEqual(["confirm", "flag", "helpful", "kudos", "lastConfirmAt", "not_helpful"]);
    });
  });
});

describe("carried standing (a correction keeps part of what it replaces)", () => {
  it("carryOver is half the positive points, rounded down, capped at 4", () => {
    const votes = (over: Partial<StandingInput>) => v(over);
    expect(STANDING_CARRY_CAP).toBe(4);
    expect(carryOver(votes({}))).toBe(0);
    expect(carryOver(votes({ helpful: 1 }))).toBe(0); // 1 -> 0
    expect(carryOver(votes({ confirm: 1 }))).toBe(1); // 2 -> 1
    expect(carryOver(votes({ confirm: 2, helpful: 1 }))).toBe(2); // 5 -> 2
    expect(carryOver(votes({ confirm: 4 }))).toBe(4); // 8 -> 4
    expect(carryOver(votes({ confirm: 20 }))).toBe(4); // capped
  });

  it("negative points never carry", () => {
    expect(carryOver(v({ not_helpful: 3 }))).toBe(0);
    expect(carryOver(v({ confirm: 1, flag: 1 }))).toBe(0); // 2 - 3 < 0
  });

  it("what the old entry carried itself counts as its points, so standing survives a chain", () => {
    expect(carryOver(v({}), 4)).toBe(2); // no votes of its own, 4 carried -> 2
    expect(carryOver(v({ confirm: 1 }), 3)).toBe(2); // (2 + 3) / 2 -> 2
    expect(carryOver(v({ confirm: 20 }), 4)).toBe(4); // still capped at 4
    expect(carryOver(v({}), 1)).toBe(0); // 1 -> 0
  });

  it("the old entry's own negative points are set against what it carried", () => {
    expect(carryOver(v({ flag: 1 }), 4)).toBe(0); // (-3 + 4) / 2 -> 0
    expect(carryOver(v({ confirm: 1, flag: 1 }), 4)).toBe(1); // (-1 + 4) / 2 -> 1
    expect(carryOver(v({ not_helpful: 5 }), 4)).toBe(0); // -1 never carries
  });

  it("computeStanding adds carried points, can lift the level, and says so", () => {
    const r = computeStanding(v({ carried: 2 }), L, NOW);
    expect(r).toMatchObject({ points: 2, standing: "fair", standingReason: "carries 2 from the entry it replaces" });
  });

  it("carried adds to the entry's own points and sits after the replaces phrase", () => {
    const r = computeStanding(
      v({ confirm: 1, lastConfirmAt: "2026-09-29 00:00:00", carried: 4, replaced: { entries: 1, confirmations: 4 } }),
      L,
      NOW,
    );
    expect(r.points).toBe(6);
    expect(r.standing).toBe("strong");
    expect(r.standingReason).toBe("1 confirmation, last 2 days ago, replaces an entry with 4 confirmations, carries 4 from the entry it replaces");
  });

  it("carried 0 or absent adds nothing", () => {
    expect(computeStanding(v({ carried: 0 }), L, NOW)).toMatchObject({ points: 0, standingReason: "no reactions yet" });
    expect(computeStanding(v({}), L, NOW).points).toBe(0);
  });
});

describe("standing on results (integration)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "bab-standing-test-"));
    process.env.DATA_DIR = dataDir;
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
    upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
    upsertUser({ id: "voter-1", email: "b@example.com", name: "Bob", roles: [] });
    upsertUser({ id: "voter-2", email: "c@example.com", name: "Cid", roles: [] });
  }
  let seq = 0;
  // confirmNotDuplicate: the dedup guard (similarity >= 0.55) must not fire between unrelated fixtures.
  async function mk(over: Record<string, unknown> = {}) {
    const { create } = await import("../lib/learnings");
    seq += 1;
    return create({ authorId: "author-1", title: `Fixture ${seq} zq${seq}`, body: `Body ${seq} about topic zq${seq}x`, confirmNotDuplicate: true, ...over });
  }

  it("search() results carry standing and standingReason on the FTS and the empty-query path", async () => {
    await seedUsers();
    const checked = await mk({ title: "Kiosk gotcha checked", body: "checked kiosk gotcha" });
    const plain = await mk({ title: "Kiosk gotcha plain", body: "plain kiosk gotcha" });
    const { confirm, search } = await import("../lib/learnings");
    confirm(checked.id, "voter-1", "src/kiosk.ts, 2026-10-01");
    for (const q of ["kiosk gotcha", ""]) {
      const hits = search(q);
      expect(hits.find((h) => h.id === checked.id)).toMatchObject({ standing: "fair", standingReason: "1 confirmation, last today" });
      expect(hits.find((h) => h.id === plain.id)).toMatchObject({ standing: "weak", standingReason: "no reactions yet" });
      expect(hits[0]).not.toHaveProperty("points");
    }
  });

  it("standingsFor runs a bounded number of queries regardless of row count", async () => {
    await seedUsers();
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(await mk());
    const { standingsFor } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const proto = Object.getPrototypeOf(getDb());
    const spy = vi.spyOn(proto, "prepare");
    try {
      const map = standingsFor(rows);
      expect(map.size).toBe(30);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("a correction's reason says it replaces an entry with N confirmations and carries half of its points", async () => {
    await seedUsers();
    const old = await mk({ kind: "standard" });
    const { confirm, createWithSupersedes, standingsFor } = await import("../lib/learnings");
    confirm(old.id, "voter-1", "src/a.ts, 2026-10-01");
    confirm(old.id, "voter-2", "src/b.ts, 2026-10-01");
    const next = createWithSupersedes({ authorId: "voter-1", title: "Corrected rule q9", body: "corrected body q9" }, [old.id]);
    const s = standingsFor([next]).get(next.id)!;
    // 2 confirmations are 4 points; the correction inherits half, rounded down (lib/standing.ts carryOver).
    expect(s.points).toBe(2);
    expect(s.standing).toBe("fair");
    expect(s.standingReason).toContain("replaces an entry with 2 confirmations");
    expect(s.standingReason).toContain("carries 2 from the entry it replaces");
  });

  it("note text never appears in standingReason, in search results, or in the FTS index", async () => {
    await seedUsers();
    // No word of the fixture may appear in the sentinels: search() widens to any-term matches.
    const l = await mk({ title: "Kiosk gotcha entry", body: "kiosk gotcha body" });
    const { confirm, flag, search } = await import("../lib/learnings");
    confirm(l.id, "voter-1", "NOTE-SENTINEL-4471 src/x.ts 2026-10-01");
    flag(l.id, "voter-2", "ui", "FLAGNOTE-SENTINEL-9902 stale");
    const hits = search("kiosk gotcha");
    expect(hits).toHaveLength(1);
    const json = JSON.stringify(hits);
    expect(json).not.toContain("NOTE-SENTINEL-4471");
    expect(json).not.toContain("FLAGNOTE-SENTINEL-9902");
    expect(search("NOTE-SENTINEL-4471")).toEqual([]);
    expect(search("FLAGNOTE-SENTINEL-9902")).toEqual([]);
  });

  it("the Confluence bonus needs a maintainer author: the same mirror is fair for one, weak for another", async () => {
    await seedUsers();
    const url = "https://wiki.example.com/wiki/spaces/E/pages/5";
    const byOwner = await mk({ kind: "decision", source: "confluence", sourceUrl: url, sourceVersion: 1, expiresAt: null });
    const { create, standingsFor } = await import("../lib/learnings");
    const byOther = create({
      authorId: "voter-1",
      title: "Claimed mirror zz",
      body: "Some other topic zzz",
      kind: "decision",
      source: "confluence",
      sourceUrl: url,
      sourceVersion: 1,
      confirmNotDuplicate: true,
    });
    process.env.BAB_MAINTAINERS = "author-1";
    const map = standingsFor([byOwner, byOther]);
    expect(map.get(byOwner.id)).toMatchObject({ standing: "fair", points: 2 });
    expect(map.get(byOther.id)).toMatchObject({ standing: "weak", points: 0 });
    delete process.env.BAB_MAINTAINERS;
    expect(standingsFor([byOwner]).get(byOwner.id)).toMatchObject({ standing: "weak", points: 0 });
  });
});
