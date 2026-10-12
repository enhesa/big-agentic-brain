import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-learnings-kind-test-"));
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

describe("create(): kind and source", () => {
  it("defaults to kind learning, source native, no url or version", async () => {
    await seedUsers();
    const l = await mk();
    expect(l).toMatchObject({ kind: "learning", source: "native", source_url: null, source_version: null });
  });

  it.each(["practice", "standard", "decision"] as const)("stores kind %s", async (kind) => {
    await seedUsers();
    expect((await mk({ kind })).kind).toBe(kind);
  });

  it.each(["rule", "", "Standard", "STANDARD", 7, null])("refuses kind %j", async (kind) => {
    await seedUsers();
    const { ValidationError } = await import("../lib/errors");
    await expect(mk({ kind })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses an unknown source", async () => {
    await seedUsers();
    await expect(mk({ source: "wiki" })).rejects.toThrow(/source/);
  });

  const URL_OK = "https://wiki.example.com/wiki/spaces/EHSARCH/pages/123/ADR+7#Decision";
  const mirror = (over: Record<string, unknown> = {}) =>
    mk({ kind: "decision", source: "confluence", sourceUrl: URL_OK, sourceVersion: 3, ...over });

  it("stores a confluence mirror with its link and version", async () => {
    await seedUsers();
    expect(await mirror()).toMatchObject({ source: "confluence", source_url: URL_OK, source_version: 3 });
  });

  it.each([
    ["missing url", { sourceUrl: undefined }],
    ["missing version", { sourceVersion: undefined }],
    ["version 0", { sourceVersion: 0 }],
    ["version 1.5", { sourceVersion: 1.5 }],
    ["version as a string", { sourceVersion: "3" }],
    ["version NaN", { sourceVersion: Number.NaN }],
  ])("source=confluence refuses %s", async (_n, over) => {
    await seedUsers();
    await expect(mirror(over)).rejects.toThrow();
  });

  it("source=native refuses source_url and source_version, and so does an omitted source", async () => {
    await seedUsers();
    await expect(mk({ source: "native", sourceUrl: URL_OK })).rejects.toThrow();
    await expect(mk({ source: "native", sourceVersion: 2 })).rejects.toThrow();
    await expect(mk({ sourceUrl: URL_OK, sourceVersion: 2 })).rejects.toThrow();
  });

  it.each([
    "http://wiki.example.com/wiki/x", // protocol
    "javascript:alert(1)",
    "not a url",
    "https://evil.com/wiki/x",
    "https://wiki.example.com.evil.com/wiki/x", // lookalike host
    "https://someone@wiki.example.com/wiki/x", // userinfo
    "https://wiki.example.com:8443/wiki/x", // port
    "https://wiki.example.com/browse/EHSARCH-1", // not /wiki/
    "https://wiki.example.com/wikipedia/x", // prefix without the slash
    "https://wiki.example.com/wiki/../admin", // normalizes to /admin
    `https://wiki.example.com/wiki/${"a".repeat(300)}`, // over 300
  ])("source_url %s is refused", async (u) => {
    await seedUsers();
    await expect(mirror({ sourceUrl: u })).rejects.toThrow();
  });

  it("source_url accepts any https host when BAB_SOURCE_HOSTS unset", async () => {
    await seedUsers();
    const prev = process.env.BAB_SOURCE_HOSTS;
    delete process.env.BAB_SOURCE_HOSTS;
    const { _resetConfigForTests } = await import("../lib/config");
    _resetConfigForTests();
    try {
      expect(await mirror({ sourceUrl: "https://docs.example.org/some/page" })).toMatchObject({ source_url: "https://docs.example.org/some/page" });
      await expect(mirror({ sourceUrl: "http://docs.example.org/x" })).rejects.toThrow(/https link/);
    } finally {
      process.env.BAB_SOURCE_HOSTS = prev;
      _resetConfigForTests();
    }
  });

  it("stores the normalized href, so what was validated is what is stored", async () => {
    await seedUsers();
    const l = await mirror({ sourceUrl: "https://WIKI.EXAMPLE.COM/wiki/spaces/A/pages/1#sec" });
    expect(l.source_url).toBe("https://wiki.example.com/wiki/spaces/A/pages/1#sec");
  });

  it("learning.created event payload kind is still the confidence, not the new kind", async () => {
    await seedUsers();
    const { subscribe } = await import("../lib/events");
    const seen: Array<{ kind?: string }> = [];
    subscribe((e) => { if (e.type === "learning.created") seen.push(e.payload ?? {}); });
    await mk({ kind: "standard", confidence: "high" });
    expect(seen[0].kind).toBe("high");
  });
});

describe("kind filter", () => {
  async function seedKinds() {
    await seedUsers();
    return {
      learning: await mk({ title: "Deploy gotcha red", body: "red kiosk deploy gotcha" }),
      standard: await mk({ kind: "standard", title: "Deploy rule blue", body: "blue kiosk deploy rule" }),
      decision: await mk({ kind: "decision", title: "Deploy choice green", body: "green kiosk deploy choice" }),
    };
  }

  it("list() filters by one kind and by several", async () => {
    const k = await seedKinds();
    const { list } = await import("../lib/learnings");
    expect(list({ kind: ["standard"] }).map((l) => l.id)).toEqual([k.standard.id]);
    expect(list({ kind: ["standard", "decision"] }).map((l) => l.id).sort()).toEqual([k.standard.id, k.decision.id].sort());
    expect(list({}).length).toBe(3);
  });

  it("an empty kind list means all kinds", async () => {
    await seedKinds();
    const { list } = await import("../lib/learnings");
    expect(list({ kind: [] }).length).toBe(3);
  });

  it("search() FTS path honours kind", async () => {
    const k = await seedKinds();
    const { search } = await import("../lib/learnings");
    expect(search("deploy kiosk", { kind: ["standard"] }).map((l) => l.id)).toEqual([k.standard.id]);
  });

  it("search() empty-query path honours kind", async () => {
    const k = await seedKinds();
    const { search } = await import("../lib/learnings");
    expect(search("", { kind: ["decision"] }).map((l) => l.id)).toEqual([k.decision.id]);
  });

  it("searchTotal() agrees with search() on both paths", async () => {
    await seedKinds();
    const { search, searchTotal } = await import("../lib/learnings");
    for (const q of ["deploy kiosk", ""]) {
      const f = { kind: ["standard" as const] };
      expect(searchTotal(q, f)).toBe(search(q, f, 20, 0).length);
      expect(searchTotal(q, f)).toBe(1);
    }
  });

  it("the any-term widening keeps the kind filter", async () => {
    const k = await seedKinds();
    const { search } = await import("../lib/learnings");
    // "blue nonexistentword" matches no row on all terms, so the any-term pass runs.
    expect(search("blue nonexistentword", { kind: ["learning"] })).toEqual([]);
    expect(search("blue nonexistentword", { kind: ["standard"] }).map((l) => l.id)).toEqual([k.standard.id]);
  });

  it("parseKindFilter accepts string, comma list and array, and refuses the rest", async () => {
    const { parseKindFilter } = await import("../lib/learnings");
    expect(parseKindFilter(undefined)).toBeUndefined();
    expect(parseKindFilter("")).toBeUndefined();
    expect(parseKindFilter("standard, decision")).toEqual(["standard", "decision"]);
    expect(parseKindFilter(["practice"])).toEqual(["practice"]);
    for (const bad of ["rule", "standard,", "standard,rule", ["standard", 3], 5, ["standard,decision"]])
      expect(() => parseKindFilter(bad)).toThrow();
  });
});

describe("supersede inheritance", () => {
  const URL_OK = "https://wiki.example.com/wiki/spaces/E/pages/5";
  it("a correction inherits kind and the source triple from the entry it replaces", async () => {
    await seedUsers();
    const old = await mk({ kind: "standard", source: "confluence", sourceUrl: URL_OK, sourceVersion: 2, expiresAt: null });
    const { createWithSupersedes } = await import("../lib/learnings");
    const next = createWithSupersedes({ authorId: "voter-1", title: "Corrected rule q1", body: "corrected body q1" }, [old.id]);
    expect(next).toMatchObject({ kind: "standard", source: "confluence", source_url: URL_OK, source_version: 2 });
  });

  it("passing any of the source fields stops the triple being inherited", async () => {
    await seedUsers();
    const old = await mk({ kind: "decision", source: "confluence", sourceUrl: URL_OK, sourceVersion: 2 });
    const { createWithSupersedes } = await import("../lib/learnings");
    const next = createWithSupersedes({ authorId: "voter-1", title: "Native take q2", body: "native body q2", source: "native" }, [old.id]);
    expect(next).toMatchObject({ kind: "decision", source: "native", source_url: null, source_version: null });
  });

  it("an explicit different kind on a single id is allowed and audited", async () => {
    await seedUsers();
    const old = await mk({ title: "House rule x1", body: "house rule body x1" });
    const { createWithSupersedes } = await import("../lib/learnings");
    const next = createWithSupersedes({ authorId: "voter-1", title: "House rule as practice x1", body: "same rule as a practice x1", kind: "practice" }, [old.id], "mcp");
    expect(next.kind).toBe("practice");
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT details FROM audit_log WHERE action = 'kind_change' AND entity_id = ?").get(next.id) as { details: string };
    expect(JSON.parse(row.details)).toMatchObject({ from: "learning", to: "practice", supersedes: old.id });
  });

  it("an explicit kind equal to the old one writes no kind_change audit row", async () => {
    await seedUsers();
    const old = await mk({ kind: "standard" });
    const { createWithSupersedes } = await import("../lib/learnings");
    createWithSupersedes({ authorId: "voter-1", title: "Same kind q3", body: "same kind body q3", kind: "standard" }, [old.id]);
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kind_change'").get()).toEqual({ n: 0 });
  });

  it("a consolidation of same-kind entries inherits that kind and is a native summary", async () => {
    await seedUsers();
    const a = await mk({ kind: "standard", source: "confluence", sourceUrl: URL_OK, sourceVersion: 2 });
    const b = await mk({ kind: "standard" });
    const { createWithSupersedes } = await import("../lib/learnings");
    const next = createWithSupersedes({ authorId: "voter-1", title: "Merged rules q4", body: "merged body q4" }, [a.id, b.id]);
    expect(next).toMatchObject({ kind: "standard", source: "native", source_url: null, source_version: null });
  });

  it("a consolidation of mixed kinds without an explicit kind is refused and archives nothing", async () => {
    await seedUsers();
    const a = await mk({ kind: "standard" });
    const b = await mk({ kind: "decision" });
    const { createWithSupersedes, getById, list } = await import("../lib/learnings");
    expect(() => createWithSupersedes({ authorId: "voter-1", title: "Mixed q5", body: "mixed body q5" }, [a.id, b.id])).toThrow(/different kinds/);
    expect(getById(a.id)!.status).toBe("active");
    expect(getById(b.id)!.status).toBe("active");
    expect(list({ status: "all" })).toHaveLength(2);
  });

  it("a consolidation with an explicit kind that differs from any old entry is refused", async () => {
    await seedUsers();
    const a = await mk({ kind: "standard" });
    const b = await mk({ kind: "standard" });
    const { createWithSupersedes, getById, list } = await import("../lib/learnings");
    expect(() => createWithSupersedes({ authorId: "voter-1", title: "Reclassified q6", body: "reclassified body q6", kind: "practice" }, [a.id, b.id])).toThrow(/keep the kind/);
    expect(getById(a.id)!.status).toBe("active");
    expect(getById(b.id)!.status).toBe("active");
    expect(list({ status: "all" })).toHaveLength(2);
  });

  it("a plain create (no supersedes) writes no kind_change audit row", async () => {
    await seedUsers();
    await mk({ kind: "standard" });
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kind_change'").get()).toEqual({ n: 0 });
  });
});

describe("A1 review fixes: provenance edge cases", () => {
  const URL_OK = "https://wiki.example.com/wiki/spaces/E/pages/5";

  it("readProvenance treats null kind, source, source_url and source_version as absent", async () => {
    const { readProvenance } = await import("../lib/learnings");
    const out = readProvenance({ kind: null, source: null, source_url: null, source_version: null });
    expect(out.kind).toBeUndefined();
    expect(out.source).toBeUndefined();
    expect(out.sourceUrl).toBeUndefined();
    expect(out.sourceVersion).toBeUndefined();
  });

  it("a correction of a mirror that sends source_url and source_version as null still inherits the triple", async () => {
    await seedUsers();
    const old = await mk({ kind: "standard", source: "confluence", sourceUrl: URL_OK, sourceVersion: 2, expiresAt: null });
    const { createWithSupersedes, readProvenance } = await import("../lib/learnings");
    const viaWire = createWithSupersedes(
      { authorId: "voter-1", title: "Corrected rule n1", body: "corrected body n1", ...readProvenance({ source_url: null, source_version: null }) },
      [old.id],
    );
    expect(viaWire).toMatchObject({ kind: "standard", source: "confluence", source_url: URL_OK, source_version: 2 });
    // The same at the lib level, for a caller that passes null itself.
    const direct = createWithSupersedes(
      { authorId: "voter-2", title: "Corrected again n2", body: "corrected body n2", sourceUrl: null, sourceVersion: null },
      [viaWire.id],
    );
    expect(direct).toMatchObject({ source: "confluence", source_url: URL_OK, source_version: 2 });
  });

  it("source_url: exactly 300 characters is accepted, 301 is refused", async () => {
    await seedUsers();
    const prefix = "https://wiki.example.com/wiki/";
    const exact = prefix + "a".repeat(300 - prefix.length);
    expect(exact.length).toBe(300);
    const mirror = (u: string) => mk({ kind: "decision", source: "confluence", sourceUrl: u, sourceVersion: 1 });
    expect((await mirror(exact)).source_url).toBe(exact);
    await expect(mirror(exact + "a")).rejects.toThrow(/300 characters/);
  });

  it("source_url: a raw string over 2000 characters is refused before it is parsed", async () => {
    const { assertSourceUrl } = await import("../lib/learnings");
    expect(() => assertSourceUrl("https://wiki.example.com/wiki/" + "a".repeat(2000))).toThrow(/characters or fewer/);
  });

  it.each([
    ["encoded dot segments", "https://wiki.example.com/wiki/%2e%2e/admin"],
    ["encoded dot segments, mixed case", "https://wiki.example.com/wiki/%2E./admin"],
    ["a backslash that moves the path", "https://wiki.example.com\\@evil.com/wiki/x"],
    ["a trailing-dot host", "https://wiki.example.com./wiki/x"],
  ])("source_url refuses %s", async (_n, u) => {
    const { assertSourceUrl } = await import("../lib/learnings");
    expect(() => assertSourceUrl(u)).toThrow();
  });

  it("source_url: the default port and backslash path separators normalise to the stored href", async () => {
    const { assertSourceUrl } = await import("../lib/learnings");
    expect(assertSourceUrl("https://wiki.example.com:443/wiki/spaces/A/pages/1")).toBe("https://wiki.example.com/wiki/spaces/A/pages/1");
    expect(assertSourceUrl("https://wiki.example.com\\wiki\\spaces")).toBe("https://wiki.example.com/wiki/spaces");
  });

  it.each([
    ["a value above the safe integer range", 2 ** 53],
    ["a string", "3"],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("source_version refuses %s", async (_n, v) => {
    await seedUsers();
    await expect(mk({ kind: "decision", source: "confluence", sourceUrl: URL_OK, sourceVersion: v })).rejects.toThrow(/source_version/);
  });
});
