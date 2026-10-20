import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Search recall at org scale: stemming in the index, the any-term widening that fills a page
 * the strict match cannot, and identifier-aware terms for bare error strings.
 */

let dataDir: string;
const ME = "recall.user@example.com";

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-search-recall-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ME, email: ME, name: ME, roles: [] });
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

async function memory(title: string, body: string) {
  const { create } = await import("../lib/learnings");
  return create({ authorId: ME, title, body, confirmNotDuplicate: true });
}

async function titles(query: string, limit = 10, offset = 0) {
  const { search } = await import("../lib/learnings");
  return search(query, {}, limit, offset).map((r) => r.title);
}

describe("search recall", () => {
  it("matches word forms through the stemmer", async () => {
    await memory("Cache is cold after the worker restarts", "Entries live in process memory only.");
    expect(await titles("cache lookups missing when workers restart")).toContain("Cache is cold after the worker restarts");
  });

  it("fills the page with any-term matches after the strict ones", async () => {
    await memory("Retry budget for the billing client", "Use exponential backoff with jitter for the billing client.");
    await memory("Backoff jitter helps", "Spread retries over time.");
    const found = await titles("billing client backoff jitter timeouts");
    expect(found[0]).toBe("Retry budget for the billing client");
    expect(found).toContain("Backoff jitter helps");
  });

  it("pages the strict and widened matches as one list", async () => {
    await memory("Alpha gamma note", "alpha gamma");
    await memory("Alpha only note", "alpha");
    await memory("Gamma only note", "gamma");
    const all = await titles("alpha gamma", 10, 0);
    const first = await titles("alpha gamma", 1, 0);
    const rest = await titles("alpha gamma", 10, 1);
    expect(all).toHaveLength(3);
    expect([...first, ...rest]).toEqual(all);
    const { searchTotal } = await import("../lib/learnings");
    expect(searchTotal("alpha gamma")).toBe(3);
  });

  it("finds an entry from a bare identifier error string", async () => {
    await memory("Import fails on the first header", "KeyError for order_id although the column exists. The file has a BOM.");
    for (let i = 0; i < 30; i++) await memory(`Key rotation note ${i}`, "Rotate the error budget keys every quarter.");
    expect(await titles("KeyError: 'order_id'")).toContain("Import fails on the first header");
  });

  it("splits dotted names and does not split letter-digit names", async () => {
    await memory("Ledger import rejected", "The importer fails in invoice.line_item for a bad record.");
    await memory("Hash note", "Use sha256 for digests.");
    await memory("Another sha note", "The sha of a commit is its id.");
    expect(await titles("invoice.line_item")).toContain("Ledger import rejected");
    const { search } = await import("../lib/learnings");
    // "sha256" must not widen to every entry that mentions "sha".
    expect(search("sha256 digests", {}, 10).map((r) => r.title)).toEqual(["Hash note"]);
  });

  it("orders strict and loose hits once when a sort is given", async () => {
    const { getDb } = await import("../lib/db");
    const oldStrict = await memory("Alpha gamma strict", "alpha gamma");
    const newLoose = await memory("Alpha loose", "alpha");
    const midLoose = await memory("Gamma loose", "gamma");
    const db = getDb();
    const at = (id: string, d: string) => db.prepare("UPDATE learnings SET created_at = ? WHERE id = ?").run(d, id);
    at(oldStrict.id, "2026-01-01 00:00:00");
    at(midLoose.id, "2026-02-01 00:00:00");
    at(newLoose.id, "2026-03-01 00:00:00");
    const { search, searchTotal } = await import("../lib/learnings");
    const newest = search("alpha gamma", { sort: "newest" }, 10).map((r) => r.title);
    expect(newest).toEqual(["Alpha loose", "Gamma loose", "Alpha gamma strict"]);
    const oldest = search("alpha gamma", { sort: "oldest" }, 10).map((r) => r.title);
    expect(oldest).toEqual(["Alpha gamma strict", "Gamma loose", "Alpha loose"]);
    expect(searchTotal("alpha gamma", { sort: "newest" })).toBe(3);
    const p1 = search("alpha gamma", { sort: "newest" }, 2, 0).map((r) => r.title);
    const p2 = search("alpha gamma", { sort: "newest" }, 2, 2).map((r) => r.title);
    expect([...p1, ...p2]).toEqual(newest);
  });

  it("never lets query syntax reach MATCH", async () => {
    await memory("Plain note", "some text about things");
    await expect(titles('"unbalanced (paren * NEAR a_b.c-d')).resolves.toBeDefined();
  });

  it("migration v46 rebuilds the index with the stemmer and runs again safely", async () => {
    await memory("Workers restart often", "Entries live in process memory only.");
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.exec("DROP TABLE learnings_fts; CREATE VIRTUAL TABLE learnings_fts USING fts5(title, body, tags, content='learnings', content_rowid='rowid')");
    db.exec("INSERT INTO learnings_fts(learnings_fts) VALUES ('rebuild')");
    db.prepare("DELETE FROM migrations WHERE version >= 46").run();
    _resetDbForTests();
    expect(await titles("worker restarts")).toEqual(["Workers restart often"]);
    getDb().prepare("DELETE FROM migrations WHERE version >= 46").run();
    _resetDbForTests();
    expect(await titles("worker restarts")).toEqual(["Workers restart often"]);
  });
});
