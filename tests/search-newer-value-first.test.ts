import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-newer-value-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seed() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
  return import("../lib/learnings");
}

const value = (n: string) => ({
  authorId: "author-1",
  title: `The linter assumes Python ${n} when no target version is set`,
  body: `With no target version in the config the linter parses files as Python ${n}.`,
  tags: ["python", "linter"],
});

describe("search puts the newer of two values first", () => {
  it("orders a saved changed value above the old one, also when both were written in the same second", async () => {
    const { create, search } = await seed();
    const old = create(value("3.10"));
    const next = create(value("3.11"));
    const hits = search("which Python does the linter assume with no target version");
    expect(hits.map((h) => h.id)).toEqual([next.id, old.id]);
  });

  it("uses the write date when the two were written at different times", async () => {
    const { create, search } = await seed();
    const { getDb } = await import("../lib/db");
    const old = create(value("3.10"));
    const next = create(value("3.11"));
    // The later row is the older memory here: the date decides, not the row order.
    getDb().prepare("UPDATE learnings SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(next.id);
    const hits = search("which Python does the linter assume with no target version");
    expect(hits.map((h) => h.id)).toEqual([old.id, next.id]);
  });

  it("ends a chain of three values newest first and leaves other results where they were", async () => {
    const { create, search, newerValueFirst } = await seed();
    const v1 = create(value("3.10"));
    const v2 = create(value("3.11"));
    const v3 = create(value("3.12"));
    const other = create({
      authorId: "author-1",
      title: "The formatter keeps the line length of the linter",
      body: "Set the line length once; the formatter and the linter both read it.",
      tags: ["python", "linter"],
    });
    const hits = search("linter Python target version", {}, 20);
    const ids = hits.map((h) => h.id);
    expect(ids.filter((id) => id !== other.id)).toEqual([v3.id, v2.id, v1.id]);

    // Whatever order the ranking gave: the values come out newest first, the unrelated row stays put.
    const byId = new Map(hits.map((h) => [h.id, h]));
    const shuffled = [v1.id, other.id, v3.id, v2.id].map((id) => byId.get(id)!);
    expect(newerValueFirst(shuffled, ["linter Python target version"]).map((h) => h.id)).toEqual([v3.id, v2.id, v1.id, other.id]);
  });

  it("does not move look-alikes that state no other number, or rows across stack groups", async () => {
    const { create, search, newerValueFirst } = await seed();
    const junior = create({
      authorId: "author-1",
      title: "A junior hire is expected to reach the senior level within four years",
      body: "Promotion from junior to senior is expected within four years of joining.",
      tags: ["hr"],
    });
    const mid = create({
      authorId: "author-1",
      title: "A mid-level hire is expected to reach the senior level within two years",
      body: "Promotion from mid-level to senior is expected within two years of joining.",
      tags: ["hr"],
      confirmNotDuplicate: true,
    });
    const hits = search("junior hire senior level four years");
    expect(hits[0].id).toBe(junior.id);
    expect(hits.map((h) => h.id)).toContain(mid.id);

    const old = create(value("3.10"));
    const next = create(value("3.11"));
    const pair = search("which Python does the linter assume with no target version");
    const olderMatched = { ...pair.find((h) => h.id === old.id)! };
    const newerOtherStack = { ...pair.find((h) => h.id === next.id)!, stackMismatch: true as const };
    expect(newerValueFirst([olderMatched, newerOtherStack], ["which Python does the linter assume"]).map((h) => h.id)).toEqual([old.id, next.id]);
  });

  it("keeps the ranking when the query names something only the older one has", async () => {
    const { create, search, newerValueFirst } = await seed();
    const tier3 = create({
      authorId: "author-1",
      title: "A new tier 3 target needs approval from a single compiler team member",
      body: "One member of the compiler team can approve a tier 3 target.",
      tags: ["compiler"],
    });
    const tier2 = create({
      authorId: "author-1",
      title: "A new tier 2 target needs approval from the compiler team as a whole",
      body: "The compiler team as a whole approves a tier 2 target.",
      tags: ["compiler"],
    });
    const hits = search("who approves a new target, compiler team approval");
    const older = hits.find((h) => h.id === tier3.id)!;
    const newer = hits.find((h) => h.id === tier2.id)!;
    // A question about tier 3 is about the older memory: the two are different facts.
    expect(newerValueFirst([older, newer], ["who approves a tier 3 target"]).map((h) => h.id)).toEqual([tier3.id, tier2.id]);
    expect(newerValueFirst([older, newer], ["who approves a new target", "tier 3 approval"]).map((h) => h.id)).toEqual([tier3.id, tier2.id]);
    // With nothing in the query to tell them apart, the later one goes first.
    expect(newerValueFirst([older, newer], ["who approves a new target"]).map((h) => h.id)).toEqual([tier2.id, tier3.id]);
    expect(search("a new tier 3 target approval")[0].id).toBe(tier3.id);
  });

  it("leaves an explicit sort alone", async () => {
    const { create, search } = await seed();
    const old = create(value("3.10"));
    const next = create(value("3.11"));
    const hits = search("linter Python target version", { sort: "oldest" });
    expect(hits.map((h) => h.id)).toEqual([old.id, next.id]);
  });

  it("orders the fused result of several phrasings too", async () => {
    const { create, searchFused } = await seed();
    const old = create(value("3.10"));
    const next = create(value("3.11"));
    const { results } = searchFused(["linter Python target version", "which Python is assumed by default"]);
    expect(results.map((h) => h.id)).toEqual([next.id, old.id]);
  });
});
