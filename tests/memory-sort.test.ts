import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LearningSort } from "../lib/learnings";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-memory-sort-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

/** Three memories with distinct dates: created a < b < c, updated c < a < b, read only b then a. */
async function seed() {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "ada@example.com", email: "ada@example.com", name: "Ada", roles: [] });
  const { create } = await import("../lib/learnings");
  const { getDb } = await import("../lib/db");
  // The tag gives the page chip links, which must carry the sort.
  const mk = (title: string, body: string) => create({ authorId: "ada@example.com", title, body, tags: ["sales"], confirmNotDuplicate: true });
  const a = mk("Alpha kiosk drops sessions", "The kiosk drops sessions after a deploy. Restart the alpha pool.");
  const b = mk("Bravo invoice export misses VAT", "The invoice export skips VAT lines for the bravo region.");
  const c = mk("Charlie pricing sheet rounds down", "The pricing sheet rounds totals down for the charlie market.");
  const set = getDb().prepare("UPDATE learnings SET created_at = ?, updated_at = ?, last_accessed_at = ?, score = ? WHERE id = ?");
  set.run("2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z", "2026-09-01T00:00:00Z", 0, a.id);
  set.run("2026-02-01T00:00:00Z", "2026-06-01T00:00:00Z", "2026-10-01T00:00:00Z", 0, b.id);
  set.run("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", null, 5, c.id);
  return { a: a.id, b: b.id, c: c.id };
}

describe("list() and search() sort", () => {
  it("orders the list by each sort", async () => {
    const { a, b, c } = await seed();
    const { list } = await import("../lib/learnings");
    const ids = (sort?: LearningSort) => list({ sort }).map((r) => r.id);
    expect(ids()).toEqual([c, b, a]); // default: score, then newest
    expect(ids("top")).toEqual([c, b, a]);
    expect(ids("newest")).toEqual([c, b, a]);
    expect(ids("oldest")).toEqual([a, b, c]);
    expect(ids("updated")).toEqual([b, a, c]);
    expect(ids("used")).toEqual([b, a, c]); // never read goes last
  });

  it("keeps the search matches and only changes their order", async () => {
    const { a, b } = await seed();
    const { search } = await import("../lib/learnings");
    const hits = (sort?: LearningSort) => search("sessions invoice", { sort }, 20, 0).map((r) => r.id);
    expect(new Set(hits())).toEqual(new Set([a, b]));
    expect(hits("newest")).toEqual([b, a]);
    expect(hits("oldest")).toEqual([a, b]);
  });

  it("pages without overlap under a sort", async () => {
    const { a, b, c } = await seed();
    const { search } = await import("../lib/learnings");
    const page1 = search("", { sort: "oldest" }, 2, 0).map((r) => r.id);
    const page2 = search("", { sort: "oldest" }, 2, 2).map((r) => r.id);
    expect([...page1, ...page2]).toEqual([a, b, c]);
  });

  it("parseSort accepts only known sorts", async () => {
    const { parseSort } = await import("../lib/learnings");
    expect(parseSort("newest")).toBe("newest");
    expect(parseSort("score; DROP TABLE learnings")).toBeUndefined();
    expect(parseSort(undefined)).toBeUndefined();
  });
});

async function renderList(searchParams: Record<string, string>) {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const { default: MemoryPage } = await import("../app/memory/page");
  return new Response(await renderToReadableStream((await MemoryPage({ searchParams: Promise.resolve(searchParams) })) as never)).text();
}

describe("/memory sort", () => {
  it("?sort=oldest lists the oldest first and keeps the sort in page links", async () => {
    await seed();
    const html = await renderList({ sort: "oldest" });
    expect(html.indexOf("Alpha kiosk")).toBeLessThan(html.indexOf("Charlie pricing"));
    expect(html).toMatch(/<option value="oldest" selected="">Oldest<\/option>/);
    expect(html).toContain("/memory?tag=sales&amp;sort=oldest");
  });

  it("shows Top by default and Best match while searching", async () => {
    await seed();
    expect(await renderList({})).toMatch(/<option value="" selected="">Top<\/option>/);
    expect(await renderList({ q: "kiosk" })).toMatch(/<option value="" selected="">Best match<\/option>/);
  });

  it("an unknown ?sort= keeps the default order", async () => {
    await seed();
    const html = await renderList({ sort: "bogus" });
    expect(html.indexOf("Charlie pricing")).toBeLessThan(html.indexOf("Alpha kiosk"));
    expect(html).not.toContain("sort=bogus");
  });
});

describe("memoryHref sort", () => {
  it("adds sort only when set", async () => {
    const { memoryHref } = await import("../app/memory/memory-url");
    expect(memoryHref({ sort: "" })).toBe("/memory");
    expect(memoryHref({ q: "x", sort: "newest", page: 2 })).toBe("/memory?q=x&sort=newest&page=2");
  });
});
