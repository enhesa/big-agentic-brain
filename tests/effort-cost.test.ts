import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Measured agent effort (docs/savings.md, "Measured savings"): the plugin attaches `cost` to
 * bab_learn (discovery) and to a helpful or kudos bab_react (reuse). The server validates it
 * tightly, stores numbers only, and keeps them out of every memory answer.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-effort-cost-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";
  vi.resetModules();
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

const ALICE = { email: "alice.example@example.com", name: "Alice Example" };
const CAROL = "carol.c@example.com";

async function call(name: string, args: Record<string, unknown>) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": ALICE.email, "x-bab-actor-name": ALICE.name }),
  }));
  const { POST } = await import("../app/mcp/route");
  const res = await POST(
    new Request("https://bab.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const out = (await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { isError: out.result.isError === true, text: out.result.content[0].text };
}

async function carolsMemory(title = "Carol's memory") {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: CAROL, email: CAROL, name: "Carol", roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId: CAROL, title, body: `${title}: the body text.` });
}

async function rows(sql: string, ...args: unknown[]) {
  const { getDb } = await import("../lib/db");
  return getDb().prepare(sql).all(...(args as never[])) as Array<Record<string, unknown>>;
}

describe("parseCost", () => {
  it("accepts minutes, whole tokens and optional usd, and stores milliseconds", async () => {
    const { parseCost } = await import("../lib/effort-cost");
    expect(parseCost(undefined)).toBeNull();
    expect(parseCost(null)).toBeNull();
    expect(parseCost({ activeMinutes: 1.5, tokens: 1200 })).toEqual({ activeMs: 90_000, tokens: 1200, usd: null });
    expect(parseCost({ activeMinutes: 0, tokens: 0, usd: 0.25 })).toEqual({ activeMs: 0, tokens: 0, usd: 0.25 });
    expect(parseCost({ activeMinutes: 240, tokens: 50_000_000, usd: 1000 })).toEqual({ activeMs: 14_400_000, tokens: 50_000_000, usd: 1000 });
  });

  it("refuses wrong shapes, unknown fields, negative, non-finite, fractional tokens and values over the caps", async () => {
    const { parseCost } = await import("../lib/effort-cost");
    for (const bad of [
      "1",
      [1, 2],
      {},
      { activeMinutes: 1 },
      { tokens: 1 },
      { activeMinutes: -1, tokens: 1 },
      { activeMinutes: Number.NaN, tokens: 1 },
      { activeMinutes: "5", tokens: 1 },
      { activeMinutes: 241, tokens: 1 },
      { activeMinutes: 1, tokens: 50_000_001 },
      { activeMinutes: 1, tokens: 1.5 },
      { activeMinutes: 1, tokens: 1, usd: -0.1 },
      { activeMinutes: 1, tokens: 1, usd: 1001 },
      { activeMinutes: 1, tokens: 1, prompt: "text" },
    ]) {
      expect(() => parseCost(bad), JSON.stringify(bad)).toThrow(/cost/);
    }
  });
});

describe("bab_learn with a measured cost", () => {
  it("stores the discovery cost on its own table, never in the memory's answer", async () => {
    const out = await call("bab_learn", { title: "Measured fix for the deploy step", body: "Run the step twice.", cost: { activeMinutes: 12.5, tokens: 340_000, usd: 1.2 } });
    expect(out.isError).toBe(false);
    const id = JSON.parse(out.text).learning.id as string;
    expect(out.text).not.toMatch(/active_ms|activeMinutes|cost/);
    expect(await rows("SELECT active_ms, tokens, usd FROM learning_costs WHERE learning_id = ?", id)).toEqual([{ active_ms: 750_000, tokens: 340_000, usd: 1.2 }]);
    const { discoveryCostOf } = await import("../lib/effort-cost");
    expect(discoveryCostOf(id)).toEqual({ activeMs: 750_000, tokens: 340_000, usd: 1.2 });
  });

  it("saves without a cost and stores none", async () => {
    const out = await call("bab_learn", { title: "Unmeasured fix for the deploy step", body: "Run the step twice." });
    expect(out.isError).toBe(false);
    expect(await rows("SELECT * FROM learning_costs")).toEqual([]);
  });

  it("refuses a bad cost before anything is written", async () => {
    const out = await call("bab_learn", { title: "Bad cost", body: "Body.", cost: { activeMinutes: 9999, tokens: 1 } });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/cost\.activeMinutes/);
    expect(await rows("SELECT id FROM learnings")).toEqual([]);
  });

  it("keeps cost out of the advertised schemas: only the plugin fills it in", async () => {
    const { findTool } = await import("../lib/mcp");
    for (const name of ["bab_learn", "bab_react"]) {
      const schema = findTool(name)!.inputSchema as { properties: Record<string, unknown>; additionalProperties?: unknown };
      expect(schema.properties.cost).toBeUndefined();
      // Hosts would refuse the plugin's extra argument if the schema closed itself.
      expect(schema.additionalProperties).toBeUndefined();
    }
  });
});

describe("bab_react with a measured cost", () => {
  it("stores the reuse cost on a helpful vote, and fills it in on a repeat helpful without replacing it", async () => {
    const m = await carolsMemory();
    expect((await call("bab_react", { learningId: m.id, action: "helpful" })).isError).toBe(false);
    expect(await rows("SELECT * FROM reuse_costs")).toEqual([]);
    expect((await call("bab_react", { learningId: m.id, action: "helpful", cost: { activeMinutes: 2, tokens: 5000 } })).isError).toBe(false);
    expect((await call("bab_react", { learningId: m.id, action: "helpful", cost: { activeMinutes: 9, tokens: 9 } })).isError).toBe(false);
    expect(await rows("SELECT kind, active_ms, tokens, usd FROM reuse_costs")).toEqual([{ kind: "helpful", active_ms: 120_000, tokens: 5000, usd: null }]);
  });

  it("stores it on kudos too", async () => {
    const m = await carolsMemory();
    expect((await call("bab_react", { learningId: m.id, action: "kudos", cost: { activeMinutes: 1, tokens: 10 } })).isError).toBe(false);
    expect(await rows("SELECT kind, tokens FROM reuse_costs")).toEqual([{ kind: "kudos", tokens: 10 }]);
  });

  it("drops the reuse cost when the helpful vote turns into not helpful", async () => {
    const m = await carolsMemory();
    await call("bab_react", { learningId: m.id, action: "helpful", cost: { activeMinutes: 1, tokens: 10 } });
    await call("bab_react", { learningId: m.id, action: "not_helpful" });
    expect(await rows("SELECT * FROM reuse_costs")).toEqual([]);
  });

  it("refuses a cost on any other reaction, and stores none for a refused vote", async () => {
    const m = await carolsMemory();
    const flag = await call("bab_react", { learningId: m.id, action: "flag", note: "wrong, checked 2026-10-27", cost: { activeMinutes: 1, tokens: 1 } });
    expect(flag.isError).toBe(true);
    expect(flag.text).toMatch(/cost is only for helpful and kudos/);
    const own = JSON.parse((await call("bab_learn", { title: "Alice's own note on caching", body: "Body." })).text).learning.id;
    expect((await call("bab_react", { learningId: own, action: "helpful", cost: { activeMinutes: 1, tokens: 1 } })).isError).toBe(true);
    expect(await rows("SELECT * FROM reuse_costs")).toEqual([]);
  });
});

describe("migration v49", () => {
  it("creates both cost tables again on a database rewound to v48", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.exec("DROP TABLE learning_costs; DROP TABLE reuse_costs;");
    db.prepare("DELETE FROM migrations WHERE version >= 49").run();
    _resetDbForTests();
    const again = getDb();
    const names = (again.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_costs'").all() as Array<{ name: string }>).map((r) => r.name).sort();
    expect(names).toEqual(["learning_costs", "reuse_costs"]);
    expect(again.prepare("SELECT 1 FROM migrations WHERE version = 49").get()).toBeTruthy();
  });
});
