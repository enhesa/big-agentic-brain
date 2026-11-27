import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Match strength: each text search result says how many of the query's terms it holds
 * (matchedTerms, "3/7"), and a first page where no result holds half the terms is weak (weak,
 * weakHint, and the area contacts). Ranking does not change.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-match-strength-test-"));
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

const ME = "sam.searcher@example.com";
const AUTHOR = "ada.author@example.com";
const EXPERT = "eve.expert@example.com";

async function users() {
  const { upsertUser } = await import("../lib/users");
  for (const id of [ME, AUTHOR, EXPERT]) upsertUser({ id, email: id, name: id, roles: [] });
}

async function memory(title: string, body: string) {
  const { create } = await import("../lib/learnings");
  return create({ authorId: AUTHOR, title, body, confirmNotDuplicate: true });
}

async function babSearch(query: string, extra: Record<string, unknown> = {}) {
  const { findTool } = await import("../lib/mcp");
  return JSON.parse(findTool("bab_search")!.run({ id: ME } as never, { query, ...extra }) as string);
}

async function seed() {
  await users();
  const full = await memory("Widget export retries on timeout", "The widget export job retries three times when the upstream times out.");
  const part = await memory("Widget colors", "Widgets come in blue and green.");
  return { full, part };
}

describe("matchedTerms", () => {
  it("counts every term a memory holds, with stemming that agrees with search", async () => {
    const { full } = await seed();
    // "retrying" and "timeouts" stem to the same terms as the body's "retries" and "timeout".
    const answer = await babSearch("widget export retrying timeouts");
    const hit = answer.results.find((r: { id: string }) => r.id === full.id);
    expect(hit.matchedTerms).toBe("4/4");
    expect(answer.weak).toBeUndefined();
    expect(answer.weakHint).toBeUndefined();
  });

  it("counts some terms on a partial match, from title and body alike", async () => {
    const { full, part } = await seed();
    const answer = await babSearch("widget export colors", { limit: 10 });
    const byId = new Map<string, { matchedTerms: string }>(answer.results.map((r: { id: string; matchedTerms: string }) => [r.id, r]));
    expect(byId.get(full.id)!.matchedTerms).toBe("2/3");
    expect(byId.get(part.id)!.matchedTerms).toBe("2/3");
    expect(answer.weak).toBeUndefined();
  });

  it("drops stop words, short tokens and repeats, and caps the terms counted", async () => {
    const { matchTerms, MATCH_TERMS_MAX } = await import("../lib/learnings");
    expect(matchTerms("how do the widget widget exports go")).toEqual(['"widget"', '"exports"']);
    const many = Array.from({ length: 30 }, (_, i) => `term${i}x`).join(" ");
    expect(matchTerms(many)).toHaveLength(MATCH_TERMS_MAX);
    // Near-duplicates are separate terms: de-duplicated as written, not on the stem.
    expect(matchTerms("retry retries")).toHaveLength(2);
  });

  it("counts only the first MATCH_TERMS_MAX terms, in both numbers", async () => {
    await seed();
    const extra = Array.from({ length: 20 }, (_, i) => `zz${i}qq`).join(" ");
    const answer = await babSearch(`widget export ${extra} timeout`);
    // "timeout" is term 23: past the cap, so it counts in neither number.
    expect(answer.results[0].matchedTerms).toBe("2/16");
  });

  it("counts an identifier as one term held in either form", async () => {
    await users();
    const apart = await memory("Python key error and value error handling", "Catch the key error before the value error.");
    const joined = await memory("Lookup fails with KeyError", "The KeyError comes from a missing dict key.");
    const snake = await memory("Order table naming", "Use order_id and parse_config in the orders module.");
    const camelApart = await memory("Parse the config once", "We parse config at start and keep the order id per row.");
    const version = await memory("Upgrade to release 2.67", "Release 2.67 fixes the export bug.");

    // CamelCase written apart in the body: each identifier is held, never 0.
    let answer = await babSearch("KeyError ValueError", { limit: 10 });
    expect(answer.results.find((r: { id: string }) => r.id === apart.id).matchedTerms).toBe("2/2");
    expect(answer.weak).toBeUndefined();
    // Written as one token: the plain form holds it.
    expect(answer.results.find((r: { id: string }) => r.id === joined.id).matchedTerms).toBe("1/2");

    answer = await babSearch("order_id parse_config", { limit: 10 });
    expect(answer.results.find((r: { id: string }) => r.id === snake.id).matchedTerms).toBe("2/2");
    // The parts written apart as words also hold both terms.
    expect(answer.results.find((r: { id: string }) => r.id === camelApart.id).matchedTerms).toBe("2/2");

    answer = await babSearch("parseConfig orderId", { limit: 10 });
    expect(answer.results.find((r: { id: string }) => r.id === camelApart.id).matchedTerms).toBe("2/2");

    // A version string is a term although its tokens are short; it matches as the phrase "2 67".
    answer = await babSearch("release 2.67", { limit: 10 });
    expect(answer.results.find((r: { id: string }) => r.id === version.id).matchedTerms).toBe("2/2");
    answer = await babSearch("release 3.14", { limit: 10 });
    expect(answer.results.find((r: { id: string }) => r.id === version.id).matchedTerms).toBe("1/2");
  });

  it("carries matchedTerms with sort, stack and status all", async () => {
    const { full } = await seed();
    const { search, retire } = await import("../lib/learnings");
    const gone = await memory("Widget export archive", "Old widget export notes.");
    retire(gone.id, AUTHOR, "mcp", "Replaced by the export doc 2026-11-01");

    const sorted = search("widget export timeout", { sort: "newest" }, 10);
    expect(sorted.length).toBeGreaterThan(0);
    expect(sorted.find((r) => r.id === full.id)!.matchedTerms).toBe("3/3");
    expect(sorted.every((r) => /^\d+\/3$/.test(r.matchedTerms ?? ""))).toBe(true);

    const stacked = await babSearch("widget export timeout", { stack: ["dotnet"], limit: 10 });
    expect(stacked.results.find((r: { id: string }) => r.id === full.id).matchedTerms).toBe("3/3");

    const all = await babSearch("widget export timeout", { status: "all", limit: 10 });
    expect(all.results.find((r: { id: string }) => r.id === gone.id).matchedTerms).toBe("2/3");
    expect(all.results.find((r: { id: string }) => r.id === full.id).matchedTerms).toBe("3/3");
    expect(all.weak).toBeUndefined();
  });

  it("counts in an attached in-memory database, never in the TEMP schema (a read-only container has no temp folder)", async () => {
    const { full } = await seed();
    const answer = await babSearch("widget export retrying timeouts");
    expect(answer.results.find((r: { id: string }) => r.id === full.id).matchedTerms).toBe("4/4");
    const { getDb } = await import("../lib/db");
    const { MATCH_PAGE_SCHEMA } = await import("../lib/learnings");
    const schemas = (getDb().prepare("PRAGMA database_list").all() as Array<{ name: string }>).map((d) => d.name);
    expect(schemas).toContain(MATCH_PAGE_SCHEMA);
    const temp = getDb().prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master").get() as { n: number };
    expect(Number(temp.n)).toBe(0);
    // The page copy is emptied after each count.
    const left = getDb().prepare(`SELECT COUNT(*) AS n FROM ${MATCH_PAGE_SCHEMA}.match_page`).get() as { n: number };
    expect(Number(left.n)).toBe(0);
  });

  it("never fails a search when counting fails: results go out without matchedTerms and are not weak", async () => {
    await seed();
    const { getDb } = await import("../lib/db");
    const { MATCH_PAGE_SCHEMA } = await import("../lib/learnings");
    // A table of the wrong shape in the counting database makes every count throw.
    getDb().exec(`ATTACH DATABASE ':memory:' AS ${MATCH_PAGE_SCHEMA}`);
    getDb().exec(`CREATE TABLE ${MATCH_PAGE_SCHEMA}.match_page(x)`);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const answer = await babSearch("payroll rounding quarterly widget ledger");
      expect(answer.results.length).toBeGreaterThan(0);
      expect(answer.results.every((r: { matchedTerms?: string }) => r.matchedTerms === undefined)).toBe(true);
      expect(answer.weak).toBeUndefined();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("is absent on a listing with no text and on the house rules digest", async () => {
    await seed();
    const listing = await babSearch("");
    expect(listing.results.length).toBeGreaterThan(0);
    expect(listing.results.every((r: { matchedTerms?: string }) => r.matchedTerms === undefined)).toBe(true);
    expect(listing.weak).toBeUndefined();
    const rules = await babSearch("", { houseRules: true });
    expect(rules.weak).toBeUndefined();
  });

  it("does not change the ranking", async () => {
    await seed();
    const { search } = await import("../lib/learnings");
    const before = search("widget export colors", {}, 10).map((r) => r.id);
    const answer = await babSearch("widget export colors", { limit: 10 });
    expect(answer.results.map((r: { id: string }) => r.id)).toEqual(before);
  });
});

describe("weak answers", () => {
  it("flags a first page where no result holds half the terms, and names the area contacts", async () => {
    await seed();
    const { addAreaContact } = await import("../lib/area-contacts");
    addAreaContact(EXPERT, "payroll", "ask me about payroll", "mcp");
    // One of five terms ("widget") matches; the rest are about something BAB does not know.
    const answer = await babSearch("payroll rounding quarterly widget ledger");
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.results.every((r: { matchedTerms: string }) => r.matchedTerms === "1/5")).toBe(true);
    const { WEAK_SEARCH_HINT } = await import("../lib/learnings");
    expect(answer.weak).toBe(true);
    expect(answer.weakHint).toBe(WEAK_SEARCH_HINT);
    expect(answer.contacts.map((c: { id: string }) => c.id)).toEqual([EXPERT]);
  });

  it("is not weak when a result holds exactly half the terms", async () => {
    await seed();
    const answer = await babSearch("widget export payroll ledger");
    expect(answer.results[0].matchedTerms).toBe("2/4");
    expect(answer.weak).toBeUndefined();
  });

  it("is never weak for a one-term query", async () => {
    await seed();
    const answer = await babSearch("widget");
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.results[0].matchedTerms).toBe("1/1");
    expect(answer.weak).toBeUndefined();
    const { searchIsWeak } = await import("../lib/learnings");
    // A one-term phrasing whose hit came through an identifier part holds 0 of 1: still not weak.
    expect(searchIsWeak([{ matchedTerms: "0/1" }])).toBe(false);
  });

  it("sets no weak flag on a later page", async () => {
    await seed();
    const first = await babSearch("payroll rounding quarterly widget ledger", { limit: 1 });
    expect(first.weak).toBe(true);
    const later = await babSearch("payroll rounding quarterly widget ledger", { limit: 1, offset: 1 });
    expect(later.results.length).toBe(1);
    expect(later.results[0].matchedTerms).toBe("1/5");
    expect(later.weak).toBeUndefined();
    expect(later.contacts).toBeUndefined();
  });

  it("with several phrasings, shows each result's best ratio and is weak only when no phrasing matched well", async () => {
    const { full } = await seed();
    const strong = await babSearch("payroll rounding quarterly widget ledger", { queries: ["widget export timeout"] });
    const hit = strong.results.find((r: { id: string }) => r.id === full.id);
    expect(hit.matchedTerms).toBe("3/3");
    expect(strong.weak).toBeUndefined();
    const weak = await babSearch("payroll rounding quarterly widget ledger", { queries: ["invoice ledger widget archive"] });
    expect(weak.results.length).toBeGreaterThan(0);
    expect(weak.weak).toBe(true);
    // The better of 1/5 and 1/4.
    expect(weak.results.every((r: { matchedTerms: string }) => r.matchedTerms === "1/4")).toBe(true);
  });

  it("keeps a hit of a one-term phrasing good, though a longer phrasing holds a smaller share", async () => {
    const { full } = await seed();
    // "export" alone is 1/1 (good); the long phrasing gives the same row 1/5. Good wins over ratio.
    const answer = await babSearch("payroll ledger quarterly rounding export", { queries: ["export"] });
    const hit = answer.results.find((r: { id: string }) => r.id === full.id);
    expect(hit.matchedTerms).toBe("1/1");
    expect(answer.weak).toBeUndefined();
  });

  it("ignores a stop-word-only phrasing: still weak, every result counted", async () => {
    await seed();
    const answer = await babSearch("payroll rounding quarterly widget ledger", { queries: ["how is it"] });
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.results.every((r: { matchedTerms?: string }) => r.matchedTerms === "1/5")).toBe(true);
    expect(answer.weak).toBe(true);
    // Only stop words everywhere: a listing, never weak.
    const listing = await babSearch("how is it", { queries: ["what are they"] });
    expect(listing.weak).toBeUndefined();
  });

  it("is not weak on an empty answer (that one has no results)", async () => {
    await seed();
    const answer = await babSearch("qqzzyy nothingmatches");
    expect(answer.results).toHaveLength(0);
    expect(answer.weak).toBeUndefined();
  });
});

describe("GET /api/learnings", () => {
  async function get(q: string) {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": ME, "x-bab-actor-name": "Searcher" }),
      cookies: async () => ({ get: () => undefined }),
    }));
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(`http://x/api/learnings?q=${encodeURIComponent(q)}`));
    return res.json();
  }

  it("carries matchedTerms, and weak with its hint on a weak answer, and records it on the audit row", async () => {
    const { full } = await seed();
    const strong = await get("widget export timeout");
    expect(strong.results.find((r: { id: string }) => r.id === full.id).matchedTerms).toBe("3/3");
    expect(strong.weak).toBeUndefined();
    const weak = await get("payroll rounding quarterly widget ledger");
    expect(weak.weak).toBe(true);
    expect(typeof weak.weakHint).toBe("string");
    const { getDb } = await import("../lib/db");
    const rows = getDb().prepare("SELECT details FROM audit_log WHERE path = '/api/learnings' ORDER BY id").all() as Array<{ details: string }>;
    const [a, b] = rows.map((r) => JSON.parse(r.details));
    expect(a).toMatchObject({ weak: 0 });
    expect(a.q).toBeUndefined();
    expect(b).toMatchObject({ weak: 1, q: "payroll rounding quarterly widget ledger" });
  });
});
