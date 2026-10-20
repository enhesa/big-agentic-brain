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

  it("splits error codes with letters and digits", async () => {
    await memory("Ledger import rejected", "The importer answers E-104 for an invalid record.");
    await memory("Other note", "Nothing relevant.");
    expect(await titles("E104 invalid")).toContain("Ledger import rejected");
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
