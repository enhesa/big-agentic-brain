import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Issue #33: bab_search takes several phrasings (queries) and fuses them by rank, and bab_learn takes
 * aliases that are indexed, stored, carried over on a correction and shown as plain text.
 */

let dataDir: string;
const ME = "alias.author@example.com";
const OTHER = "alias.reader@example.com";
const ORIGIN = "https://bab.example.com";
let current: Record<string, string> = {};

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-multi-alias-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = ORIGIN;
  vi.resetModules();
  current = {};
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ME, email: ME, name: "Alias Author", roles: [] });
  upsertUser({ id: OTHER, email: OTHER, name: "Alias Reader", roles: [] });
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_PUBLIC_ORIGIN;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

async function make(title: string, body: string, extra: Record<string, unknown> = {}) {
  const { create } = await import("../lib/learnings");
  return create({ authorId: ME, title, body, confirmNotDuplicate: true, ...extra });
}

async function call(name: string, args: Record<string, unknown>, who = OTHER) {
  current = { "x-bab-actor-email": who, "x-bab-actor-name": who, host: "bab.example.com" };
  const { POST } = await import("../app/mcp/route");
  const res = await POST(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "bab.example.com", "x-bab-actor-email": who, "x-bab-actor-name": who },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const out = await res.json();
  const text: string = out.result.content[0].text;
  return { isError: out.result.isError === true, text, json: out.result.isError ? undefined : JSON.parse(text) };
}

const search = (args: Record<string, unknown>) => call("bab_search", args);

describe("fuseRankings (reciprocal rank fusion, k=60)", () => {
  it("sums 1/(60+rank) per list and de-duplicates by id", async () => {
    const { fuseRankings, RRF_K } = await import("../lib/learnings");
    expect(RRF_K).toBe(60);
    const a = [{ id: "x" }, { id: "y" }, { id: "z" }];
    const b = [{ id: "y" }, { id: "w" }];
    const fused = fuseRankings([a, b]);
    // y: 1/62 + 1/61; x: 1/61; w: 1/62; z: 1/63
    expect(fused.map((h) => h.id)).toEqual(["y", "x", "w", "z"]);
  });

  it("lets a hit two lists agree on beat a single first place", async () => {
    const { fuseRankings } = await import("../lib/learnings");
    const fused = fuseRankings([[{ id: "solo" }, { id: "both" }], [{ id: "other" }, { id: "both" }]]);
    expect(fused[0].id).toBe("both");
  });

  it("breaks a tie by best rank, then by the earlier list, and keeps one object per id", async () => {
    const { fuseRankings } = await import("../lib/learnings");
    const first = { id: "a", from: "list0" };
    const second = { id: "b", from: "list1" };
    expect(fuseRankings([[first], [second]]).map((h) => h.id)).toEqual(["a", "b"]);
    const dupe = { id: "a", from: "list1" };
    const fused = fuseRankings([[{ id: "q", from: "list0" }, first], [dupe]]);
    expect(fused.filter((h) => h.id === "a")).toHaveLength(1);
    // "a" ranked first in list1, so that object is the one kept.
    expect(fused.find((h) => h.id === "a")).toBe(dupe);
  });

  it("returns nothing for no lists and tolerates empty ones", async () => {
    const { fuseRankings } = await import("../lib/learnings");
    expect(fuseRankings([])).toEqual([]);
    expect(fuseRankings([[], []])).toEqual([]);
  });
});

describe("bab_search queries", () => {
  async function corpus() {
    const kafka = await make("Kafka consumer lag grows after rebalance", "Raise max.poll.interval.ms so the group stops rebalancing.", { tags: ["kafka"] });
    const nuget = await make("NuGet restore fails with 401", "Set ENH_NUGET_USER and ENH_NUGET_PASSWORD, and connect the VPN.", { tags: ["dotnet"] });
    const other = await make("Grafana dashboards need a folder", "Create the folder first.", { tags: ["grafana"] });
    return { kafka, nuget, other };
  }

  it("finds a memory through a rephrasing that the main query misses", async () => {
    const { kafka } = await corpus();
    const plain = await search({ query: "slow queue reader keeps falling behind" });
    expect(plain.json.results.map((r: { id: string }) => r.id)).not.toContain(kafka.id);
    const multi = await search({ query: "slow queue reader keeps falling behind", queries: ["kafka consumer lag"] });
    expect(multi.json.results.map((r: { id: string }) => r.id)).toContain(kafka.id);
  });

  it("works with queries alone, and fuses and de-duplicates across phrasings", async () => {
    const { kafka, nuget } = await corpus();
    const out = await search({ queries: ["kafka consumer lag", "kafka rebalance", "nuget restore 401"] });
    const ids: string[] = out.json.results.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 2).sort()).toEqual([kafka.id, nuget.id].sort());
    expect(ids[0]).toBe(kafka.id); // two phrasings agree on it
  });

  it("cuts to limit, reports total as the distinct ids among the first hits, and has no next page", async () => {
    await corpus();
    const out = await search({ query: "kafka", queries: ["nuget", "grafana"], limit: 2 });
    expect(out.json.results).toHaveLength(2);
    expect(out.json.total).toBe(3);
    expect(out.json.nextOffset).toBeNull();
  });

  it("applies the same filters to every phrasing", async () => {
    const { kafka } = await corpus();
    const out = await search({ query: "kafka", queries: ["nuget restore"], tag: "kafka" });
    expect(out.json.results.map((r: { id: string }) => r.id)).toEqual([kafka.id]);
    expect(out.json.total).toBe(1);
  });

  it("a single effective phrasing is an ordinary search that pages", async () => {
    for (let i = 0; i < 4; i++) await make(`Widget note ${i}`, `widget detail number ${i}`);
    const out = await search({ query: "", queries: ["widget"], limit: 2 });
    expect(out.json.nextOffset).toBe(2);
    const same = await search({ query: "widget", queries: ["widget", "  "], limit: 2 });
    expect(same.json.nextOffset).toBe(2);
  });

  it("records a read for every returned memory", async () => {
    const { kafka, nuget } = await corpus();
    await search({ query: "kafka consumer lag", queries: ["nuget restore 401"] });
    const { getById } = await import("../lib/learnings");
    expect(getById(kafka.id)!.last_accessed_at).not.toBeNull();
    expect(getById(nuget.id)!.last_accessed_at).not.toBeNull();
  });

  it("names contacts when no phrasing matches anything", async () => {
    const { addAreaContact } = await import("../lib/area-contacts");
    addAreaContact(ME, "zebrafish", null, "mcp");
    const out = await search({ query: "zebrafish enclosure", queries: ["zebrafish tank"] });
    expect(out.json.total).toBe(0);
    expect(out.json.contacts?.length).toBe(1);
  });

  it("refuses more than 3 phrasings, one over 300 characters, or a non-array", async () => {
    const tooMany = await search({ queries: ["a1", "b2", "c3", "d4"] });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toContain("3 phrasings");
    const tooLong = await search({ queries: ["x".repeat(301)] });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toContain("300 characters");
    const ok = await search({ queries: ["x".repeat(300)] });
    expect(ok.isError).toBe(false);
    const notArray = await search({ query: "a", queries: "kafka" });
    expect(notArray.isError).toBe(true);
    const notStrings = await search({ query: "a", queries: [1] });
    expect(notStrings.isError).toBe(true);
  });

  it("describes queries in the full and the lean tool lists", async () => {
    const { toolsFor } = await import("../lib/mcp");
    for (const set of ["full", "lean"] as const) {
      const tool = toolsFor(set).find((t) => t.name === "bab_search")!;
      expect(tool.description).toContain("queries");
      expect(tool.description).toContain("rephrasings");
      expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain("queries");
      const learn = toolsFor(set).find((t) => t.name === "bab_learn")!;
      expect(learn.description).toContain("aliases: 2 to 4");
      expect(Object.keys((learn.inputSchema as { properties: object }).properties)).toContain("aliases");
    }
  });
});

describe("aliases at save time", () => {
  it("stores them trimmed and de-duplicated, as JSON text", async () => {
    const m = await make("Queue lag", "Raise the poll interval.", { aliases: ["  consumer behind  ", "Consumer Behind", "", "rebalance loop"] });
    expect(JSON.parse(m.aliases)).toEqual(["consumer behind", "rebalance loop"]);
  });

  it("defaults to an empty list", async () => {
    const m = await make("No aliases", "Plain memory body.");
    expect(m.aliases).toBe("[]");
  });

  it("runs redact() on each alias", async () => {
    const m = await make("Key leak", "Rotate the key.", { aliases: ["error for sk-test-0123456789abcdef here"] });
    expect(m.aliases).not.toContain("sk-test-0123456789abcdef");
    expect(m.aliases).toContain("[redacted]");
  });

  it("refuses more than 5 aliases, one over 120 characters, and a non-array", async () => {
    const { ValidationError } = await import("../lib/errors");
    const six = ["a1", "b2", "c3", "d4", "e5", "f6"];
    await expect(make("Six", "body six", { aliases: six })).rejects.toBeInstanceOf(ValidationError);
    await expect(make("Long", "body long", { aliases: ["x".repeat(121)] })).rejects.toBeInstanceOf(ValidationError);
    await expect(make("Odd", "body odd", { aliases: "kafka" as never })).rejects.toBeInstanceOf(ValidationError);
    const fine = await make("Five", "body five", { aliases: [...six.slice(0, 4), "x".repeat(120)] });
    expect(JSON.parse(fine.aliases)).toHaveLength(5);
    // Repeats do not count against the limit.
    const repeats = await make("Repeats", "body repeats", { aliases: ["a1", "A1", "b2", "c3", "d4", "e5"] });
    expect(JSON.parse(repeats.aliases)).toHaveLength(5);
  });

  it("bab_learn takes aliases and returns them", async () => {
    const out = await call("bab_learn", { title: "Consumer lag", body: "Raise max.poll.interval.ms.", aliases: ["queue reader behind", "rebalance storm"] }, ME);
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.json.learning.aliases)).toEqual(["queue reader behind", "rebalance storm"]);
    const bad = await call("bab_learn", { title: "Bad aliases", body: "Some body text.", aliases: "nope" }, ME);
    expect(bad.isError).toBe(true);
  });

  it("carries the aliases of the one entry it supersedes when it passes none", async () => {
    const old = await make("Old lag note", "Raise the interval.", { aliases: ["consumer behind", "rebalance loop"] });
    const { createWithSupersedes } = await import("../lib/learnings");
    const fresh = createWithSupersedes({ authorId: ME, title: "Lag note corrected", body: "Raise the interval to 5 minutes.", confirmNotDuplicate: true }, [old.id]);
    expect(JSON.parse(fresh.aliases)).toEqual(["consumer behind", "rebalance loop"]);
  });

  it("does not carry them when it passes its own, or an empty list", async () => {
    const { createWithSupersedes } = await import("../lib/learnings");
    const a = await make("Lag note a", "Raise the interval a.", { aliases: ["alias one"] });
    const own = createWithSupersedes({ authorId: ME, title: "Lag note a2", body: "Raise it again.", aliases: ["alias two"], confirmNotDuplicate: true }, [a.id]);
    expect(JSON.parse(own.aliases)).toEqual(["alias two"]);
    const b = await make("Lag note b", "Raise the interval b.", { aliases: ["alias three"] });
    const none = createWithSupersedes({ authorId: ME, title: "Lag note b2", body: "Raise it once more.", aliases: [], confirmNotDuplicate: true }, [b.id]);
    expect(JSON.parse(none.aliases)).toEqual([]);
  });

  it("carries nothing over a consolidation of several entries", async () => {
    const { createWithSupersedes } = await import("../lib/learnings");
    const a = await make("Merge a", "First body about topic.", { aliases: ["alias a"] });
    const b = await make("Merge b", "Second body about topic.", { aliases: ["alias b"] });
    const merged = createWithSupersedes({ authorId: ME, title: "Merged", body: "Both facts together.", confirmNotDuplicate: true }, [a.id, b.id]);
    expect(JSON.parse(merged.aliases)).toEqual([]);
  });

  it("deleting a memory wipes its aliases", async () => {
    const m = await make("Delete me", "Some body to delete.", { aliases: ["secret wording"] });
    const { deleteOwn } = await import("../lib/learnings");
    expect(deleteOwn(m.id, ME).aliases).toBe("[]");
  });
});

describe("aliases in search", () => {
  it("finds a memory by its alias alone", async () => {
    const m = await make("Queue reader keeps restarting", "Raise the poll interval to five minutes.", { aliases: ["zxqv consumer stuck"] });
    const { search: run } = await import("../lib/learnings");
    expect(run("zxqv", {}, 5).map((r) => r.id)).toEqual([m.id]);
    const viaTool = await search({ query: "zxqv consumer stuck" });
    expect(viaTool.json.results.map((r: { id: string }) => r.id)).toEqual([m.id]);
  });

  it("does not find it by a word that no field holds", async () => {
    await make("Queue reader keeps restarting", "Raise the poll interval.", { aliases: ["zxqv consumer stuck"] });
    const { search: run } = await import("../lib/learnings");
    expect(run("qqqzzz", {}, 5).filter((r) => r.title.includes("Queue"))).toEqual([]);
  });

  it("ranks an alias hit like a tag hit, above a body-only mention", async () => {
    const bodyOnly = await make("Notes on deployment", "We once saw the plumbus error while deploying.");
    const aliased = await make("Release hiccup", "Restart the pipeline agent.", { aliases: ["plumbus error"] });
    const { search: run } = await import("../lib/learnings");
    expect(run("plumbus error", {}, 5).map((r) => r.id)).toEqual([aliased.id, bodyOnly.id]);
  });

  it("the duplicate guard ignores aliases", async () => {
    const { create } = await import("../lib/learnings");
    await make("Totally different subject", "Another body entirely about fish.", { aliases: ["kafka consumer lag after rebalance"] });
    const fresh = create({ authorId: ME, title: "kafka consumer lag after rebalance", body: "kafka consumer lag after rebalance", tags: [] });
    expect(fresh.id).toBeTruthy();
  });

  it("the REST read carries the field", async () => {
    const m = await make("Rest alias", "Body for the REST read.", { aliases: ["rest wording"] });
    const { GET } = await import("../app/api/learnings/[id]/route");
    current = { "x-bab-actor-email": OTHER, "x-bab-actor-name": OTHER };
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(`${ORIGIN}/api/learnings/${m.id}`), { params: Promise.resolve({ id: m.id }) });
    const body = await res.json();
    expect(JSON.parse(body.learning.aliases)).toEqual(["rest wording"]);
  });
});

describe("migration v47", () => {
  it("runs twice without harm, keeps stored aliases and still finds by alias", async () => {
    const m = await make("Queue reader keeps restarting", "Raise the poll interval.", { aliases: ["zxqv consumer stuck"] });
    const { getDb, _resetDbForTests } = await import("../lib/db");
    for (let i = 0; i < 2; i++) {
      getDb().prepare("DELETE FROM migrations WHERE version >= 47").run();
      _resetDbForTests();
      const db = getDb();
      expect((db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number }).v).toBe(47);
      expect(JSON.parse((db.prepare("SELECT aliases FROM learnings WHERE id = ?").get(m.id) as { aliases: string }).aliases)).toEqual(["zxqv consumer stuck"]);
    }
    const { search: run } = await import("../lib/learnings");
    expect(run("zxqv", {}, 5).map((r) => r.id)).toEqual([m.id]);
  });

  it("upgrades a database that has the old 3-column index and indexes the new column", async () => {
    const m = await make("Old index row", "Body text for the old index.");
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.exec("DROP TRIGGER learnings_ai; DROP TRIGGER learnings_ad; DROP TRIGGER learnings_au; DROP TABLE learnings_fts");
    db.exec("ALTER TABLE learnings DROP COLUMN aliases");
    db.exec("CREATE VIRTUAL TABLE learnings_fts USING fts5(title, body, tags, content='learnings', content_rowid='rowid', tokenize='porter unicode61')");
    db.exec("INSERT INTO learnings_fts(learnings_fts) VALUES ('rebuild')");
    db.prepare("DELETE FROM migrations WHERE version >= 47").run();
    _resetDbForTests();
    const again = getDb();
    expect((again.prepare("SELECT aliases FROM learnings WHERE id = ?").get(m.id) as { aliases: string }).aliases).toBe("[]");
    again.prepare("UPDATE learnings SET aliases = ? WHERE id = ?").run(JSON.stringify(["qwxz legacy wording"]), m.id);
    const { search: run } = await import("../lib/learnings");
    expect(run("qwxz", {}, 5).map((r) => r.id)).toEqual([m.id]);
    // Deleting the row keeps the index consistent (the trigger passes the aliases to the delete command).
    again.prepare("DELETE FROM learnings WHERE id = ?").run(m.id);
    expect(run("qwxz", {}, 5)).toEqual([]);
  });
});

describe("memory page", () => {
  async function renderDetail(id: string) {
    const { default: DetailPage } = await import("../app/memory/[id]/page");
    const { renderToReadableStream } = await import("react-dom/server.edge");
    return new Response(await renderToReadableStream((await DetailPage({ params: Promise.resolve({ id }) })) as never)).text();
  }

  it("shows aliases as plain text, escaping markup", async () => {
    const m = await make("Alias page", "Body of the page.", { aliases: ["first wording", "<b>bold</b> <script>alert(1)</script>"] });
    const html = await renderDetail(m.id);
    expect(html).toContain("Also searched as: ");
    expect(html).toContain("first wording");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>bold</b>");
  });

  it("shows nothing when there are no aliases", async () => {
    const m = await make("No alias page", "Body of the page.");
    expect(await renderDetail(m.id)).not.toContain("Also searched as");
  });
});
