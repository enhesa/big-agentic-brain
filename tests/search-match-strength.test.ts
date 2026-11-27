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
    const { queryTerms, MATCH_TERMS_MAX } = await import("../lib/learnings");
    expect(queryTerms("how do the widget widget exports go")).toEqual(["widget", "exports"]);
    const many = Array.from({ length: 30 }, (_, i) => `term${i}x`).join(" ");
    expect(queryTerms(many)).toHaveLength(MATCH_TERMS_MAX);
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
