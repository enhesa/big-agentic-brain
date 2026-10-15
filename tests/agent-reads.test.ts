import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * Memories do not expire; unread ones are archived (docs/spec.md "Memories do not
 * expire; unread ones are archived"). An AGENT read (a search result, a fetch by id, a reaction that
 * says the memory was used) is recorded per memory; a person opening a web page is not. The hourly
 * sweep archives a learning or practice no agent has read for a year, never a standard, a decision
 * or a pinned house rule, and never before a year after the day reads started being recorded.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-agent-reads-test-"));
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

const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";

type Row = {
  status: string;
  last_accessed_at: string | null;
  access_days: number;
  updated_at: string;
  expires_at: string | null;
};

async function db() {
  return (await import("../lib/db")).getDb();
}

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  for (const id of [ALICE, BOB]) upsertUser({ id, email: id, name: id.split(".")[0], roles: [] });
}

let seq = 0;
async function mk(over: Record<string, unknown> = {}) {
  await seedUsers();
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({
    authorId: ALICE,
    title: `Read fixture ${seq} zr${seq}`,
    body: `Fixture body ${seq} about topic zr${seq}x zrshared`,
    confirmNotDuplicate: true,
    ...over,
  });
}

async function row(id: string): Promise<Row> {
  return (await db())
    .prepare("SELECT status, last_accessed_at, access_days, updated_at, expires_at FROM learnings WHERE id = ?")
    .get(id) as unknown as Row;
}

async function setRow(id: string, set: string, ...params: Array<string | number | null>) {
  (await db()).prepare(`UPDATE learnings SET ${set} WHERE id = ?`).run(...params, id);
}

async function audits(id: string, action: string) {
  const rows = (await db())
    .prepare("SELECT actor_id, details FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id")
    .all(action, id) as Array<{ actor_id: string; details: string | null }>;
  return rows.map((r) => ({ actor: r.actor_id, details: r.details ? JSON.parse(r.details) : null }));
}

function mockIdentity(email: string, name = "Agent") {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": name }),
    cookies: async () => ({ get: () => undefined }),
  }));
}

async function tool(name: string, args: Record<string, unknown>, as = BOB) {
  mockIdentity(as);
  const { POST } = await import("../app/mcp/route");
  const res = await POST(
    new Request("https://bab.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const out = await res.json();
  const text: string | undefined = out.result?.content?.[0]?.text;
  // A tool error is plain text, a result is JSON.
  let body: unknown = out;
  if (text !== undefined) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { isError: !!out.result?.isError, body: body as any };
}

describe("touchRead: what one agent read writes", () => {
  it("records the first read of a day, once, without touching updated_at", async () => {
    const m = await mk();
    const before = await row(m.id);
    expect(before.last_accessed_at).toBeNull();
    expect(before.access_days).toBe(0);

    const { touchRead } = await import("../lib/learnings");
    touchRead(await db(), [m.id]);
    const first = await row(m.id);
    expect(first.last_accessed_at).not.toBeNull();
    expect(first.access_days).toBe(1);
    expect(first.updated_at).toBe(before.updated_at);

    touchRead(await db(), [m.id]);
    expect((await row(m.id)).access_days).toBe(1);

    await setRow(m.id, "last_accessed_at = datetime('now', '-1 day')");
    touchRead(await db(), [m.id]);
    const next = await row(m.id);
    expect(next.access_days).toBe(2);
    expect(next.last_accessed_at!.slice(0, 10)).toBe(first.last_accessed_at!.slice(0, 10));
  });

  it("ignores an archived memory: only keep brings it back", async () => {
    const m = await mk();
    await setRow(m.id, "status = 'archived'");
    const { touchRead } = await import("../lib/learnings");
    touchRead(await db(), [m.id]);
    const r = await row(m.id);
    expect(r.last_accessed_at).toBeNull();
    expect(r.access_days).toBe(0);
  });
});

describe("which paths count as an agent read", () => {
  it("bab_search records the page of results it returned, and nothing past the limit", async () => {
    const a = await mk();
    const b = await mk();
    const c = await mk();
    const { body } = await tool("bab_search", { query: "zrshared", limit: 2 });
    const returned = (body.results as Array<{ id: string }>).map((r) => r.id);
    expect(returned).toHaveLength(2);
    const reads = await Promise.all([a, b, c].map((m) => row(m.id)));
    for (const m of [a, b, c]) {
      const r = reads[[a, b, c].indexOf(m)];
      expect(r.access_days).toBe(returned.includes(m.id) ? 1 : 0);
    }
  });

  it("a plain listing by kind or project counts: that is how agents read the rules", async () => {
    const m = await mk({ kind: "practice", project: "bab" });
    await tool("bab_search", { query: "", kind: "practice", project: "bab" });
    expect((await row(m.id)).access_days).toBe(1);
  });

  it("the review views do not count: house rules digest, flagged queue, archived and all", async () => {
    process.env.BAB_MAINTAINERS = "maint.m@example.com";
    try {
      const { upsertUser } = await import("../lib/users");
      upsertUser({ id: "maint.m@example.com", email: "maint.m@example.com", name: "Mia", roles: [] });
      const rule = await mk({ kind: "practice" });
      const { setPinned, flag } = await import("../lib/learnings");
      setPinned(rule.id, "maint.m@example.com", true, "mcp"); // a maintainer, now that pinning is restricted when BAB_MAINTAINERS is set
      const flagged = await mk({ kind: "standard" });
      flag(flagged.id, BOB, "mcp", "Moved to src/x.ts, 2026-10-07");
      const archived = await mk();
      await setRow(archived.id, "status = 'archived'");

      // The views must really return the memories, or "nothing recorded" would prove nothing.
      const rules = await tool("bab_search", { query: "", houseRules: true });
      expect(rules.body.results.map((r: { id: string }) => r.id)).toContain(rule.id);
      const queue = await tool("bab_search", { query: "", flagged: true });
      expect(queue.body.results.map((r: { id: string }) => r.id)).toContain(flagged.id);
      const wide = await tool("bab_search", { query: "zrshared", status: "all" });
      expect(wide.body.results.length).toBeGreaterThan(0);
      await tool("bab_search", { query: "zrshared", status: "archived" });

      for (const m of [rule, flagged, archived]) expect((await row(m.id)).access_days).toBe(0);
    } finally {
      delete process.env.BAB_MAINTAINERS;
    }
  });

  it("the lib reads that the web pages and the session digests use never record", async () => {
    const m = await mk({ kind: "practice", project: "bab" });
    const lib = await import("../lib/learnings");
    lib.setPinned(m.id, ALICE, true, "mcp");
    expect(lib.search("zrshared").length).toBeGreaterThan(0);
    expect(lib.list({}).length).toBeGreaterThan(0);
    expect(lib.houseRulesFor("bab").length).toBeGreaterThan(0);
    expect((await row(m.id)).access_days).toBe(0);
  });

  it("GET /api/learnings and GET /api/learnings/:id record a read", async () => {
    const a = await mk();
    const b = await mk();
    mockIdentity(BOB);
    const { GET: list } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    await list(new NextRequest(`http://x/api/learnings?q=${encodeURIComponent(`zr${seq - 1}x`)}`));
    expect((await row(a.id)).access_days).toBe(1);
    expect((await row(b.id)).access_days).toBe(0);

    const { GET: one } = await import("../app/api/learnings/[id]/route");
    await one(new NextRequest(`http://x/api/learnings/${b.id}`), { params: Promise.resolve({ id: b.id }) });
    expect((await row(b.id)).access_days).toBe(1);

    // An archived memory fetched by id stays unread: it is not live.
    await setRow(a.id, "status = 'archived', access_days = 0, last_accessed_at = NULL");
    await one(new NextRequest(`http://x/api/learnings/${a.id}`), { params: Promise.resolve({ id: a.id }) });
    expect((await row(a.id)).access_days).toBe(0);
  });

  it("a person opening the /memory pages is not an agent: nothing is recorded", async () => {
    const m = await mk({ title: "Kiosk gotcha for readers zrui", body: "The red kiosk drops sessions zruix" });
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const html = async (node: unknown) => new Response(await renderToReadableStream(node as never)).text();

    const { default: MemoryPage } = await import("../app/memory/page");
    const list = await html(MemoryPage({ searchParams: Promise.resolve({ q: "kiosk" }) }));
    expect(list).toContain("Kiosk gotcha for readers");
    const { default: DetailPage } = await import("../app/memory/[id]/page");
    const detail = await html(await DetailPage({ params: Promise.resolve({ id: m.id }) }));
    expect(detail).toContain("Last read by an agent");
    expect(detail).toContain("not yet");

    const r = await row(m.id);
    expect(r.last_accessed_at).toBeNull();
    expect(r.access_days).toBe(0);
  });

  it("reactions that say a memory was used count: helpful, confirm, kudos and keep; not_helpful and flag do not", async () => {
    const lib = await import("../lib/learnings");
    const cases: Array<[string, (id: string) => unknown, number]> = [
      ["helpful", (id) => lib.vote(id, BOB, "helpful", "mcp"), 1],
      ["not_helpful", (id) => lib.vote(id, BOB, "not_helpful", "mcp"), 0],
      ["kudos", (id) => lib.giveKudos(id, BOB, null, "mcp"), 1],
      ["confirm", (id) => lib.confirm(id, BOB, "src/lib/db.ts, 2026-10-07", "mcp"), 1],
      ["keep", (id) => lib.keepLearning(id, BOB, "mcp"), 1],
      ["flag", (id) => lib.flag(id, BOB, "mcp", "moved to src/x.ts, 2026-10-07"), 0],
    ];
    for (const [name, react, days] of cases) {
      const m = await mk();
      react(m.id);
      expect(`${name}: ${(await row(m.id)).access_days}`).toBe(`${name}: ${days}`);
    }
  });

  it("a repeat helpful on another day still counts as a read", async () => {
    const m = await mk();
    const { vote } = await import("../lib/learnings");
    vote(m.id, BOB, "helpful", "mcp");
    await setRow(m.id, "last_accessed_at = datetime('now', '-3 days')");
    const again = vote(m.id, BOB, "helpful", "mcp");
    expect(again.changed).toBe(false);
    expect((await row(m.id)).access_days).toBe(2);
  });
});

describe("the removed expiring status is refused, not read as an empty page", () => {
  it("bab_search and GET /api/learnings answer a clear error for status expiring, and accept the real ones", async () => {
    await mk();
    const bad = await tool("bab_search", { query: "zrshared", status: "expiring" });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.body)).toMatch(/status must be one of active, archived, deleted, all/);

    mockIdentity(BOB);
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://x/api/learnings?status=expiring"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no expiring status/);

    for (const status of ["active", "archived", "deleted", "all", "ALL", ""]) {
      const ok = await tool("bab_search", { query: "zrshared", status });
      expect(ok.isError).toBe(false);
    }
  });
});

describe("no default expiry, and the author's own valid-until date", () => {
  it("a new memory has no date, and \"never\" through bab_learn is no date either", async () => {
    const plain = await mk();
    expect((await row(plain.id)).expires_at).toBeNull();
    await seedUsers();
    const never = await tool("bab_learn", { title: "No date zrnever", body: "Body zrneverx", expiresAt: "never" }, ALICE);
    expect(never.body.learning.expires_at).toBeNull();
    const dated = await tool("bab_learn", { title: "Freeze zrfreeze", body: "Code freeze zrfreezex", expiresAt: "2099-01-31" }, ALICE);
    expect(dated.body.learning.expires_at).toBe("2099-01-31");
  });

  it("the sweep archives a memory once its own date has passed, with an auto-archive row saying why", async () => {
    const dated = await mk({ expiresAt: "2099-01-31" });
    const undated = await mk();
    await setRow(dated.id, "expires_at = date('now', '-1 day')");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();
    const result = runMaintenance(true);
    expect(result?.learningsExpired).toBe(1);
    expect((await row(dated.id)).status).toBe("archived");
    expect((await row(undated.id)).status).toBe("active");
    expect(await audits(dated.id, "auto-archive")).toEqual([{ actor: "system", details: { reason: "valid-until" } }]);
  });

  it("a keep leaves the date alone and says so; a memory past its date cannot be restored", async () => {
    const m = await mk({ expiresAt: "2099-01-31" });
    const { keepLearning } = await import("../lib/learnings");
    const kept = keepLearning(m.id, BOB, "mcp");
    expect(kept.changed).toBe(false);
    expect(kept.message).toMatch(/valid-until date \(2099-01-31\)/);
    expect((await row(m.id)).expires_at).toBe("2099-01-31");

    await setRow(m.id, "status = 'archived', expires_at = date('now', '-2 days')");
    expect(() => keepLearning(m.id, ALICE, "mcp")).toThrow(/valid-until date/);
    expect((await row(m.id)).status).toBe("archived");
  });
});

describe("the inactivity sweep", () => {
  async function sweep(now: string) {
    const { sweepInactive } = await import("../lib/maintenance");
    return sweepInactive(await db(), now);
  }

  it("archives a learning or practice no agent read for a year, with an auto-archive row", async () => {
    const m = await mk();
    const p = await mk({ kind: "practice" });
    expect(await sweep("2028-01-01 00:00:00")).toBe(2);
    for (const x of [m, p]) {
      expect((await row(x.id)).status).toBe("archived");
      expect(await audits(x.id, "auto-archive")).toEqual([{ actor: "system", details: { reason: "inactive" } }]);
    }
    expect(await sweep("2028-01-01 00:00:00")).toBe(0);
  });

  it("keeps a memory an agent read inside the year", async () => {
    const m = await mk();
    await setRow(m.id, "last_accessed_at = '2027-06-01 12:00:00'");
    expect(await sweep("2028-01-01 00:00:00")).toBe(0);
    expect(await sweep("2028-06-02 00:00:00")).toBe(1);
  });

  it("never archives a standard, a decision or a pinned house rule", async () => {
    const standard = await mk({ kind: "standard" });
    const decision = await mk({ kind: "decision" });
    const pinned = await mk({ kind: "practice" });
    await setRow(pinned.id, "pinned = 1");
    expect(await sweep("2040-01-01 00:00:00")).toBe(0);
    for (const x of [standard, decision, pinned]) expect((await row(x.id)).status).toBe("active");
  });

  it("starts every clock on the day reads began, whatever the age of the memory", async () => {
    const m = await mk();
    await setRow(m.id, "created_at = '2020-01-01 00:00:00'");
    const { INACTIVITY_CLOCK_START, INACTIVITY_ARCHIVE_DAYS } = await import("../lib/learnings");
    expect(INACTIVITY_CLOCK_START).toBe("2026-10-07");
    expect(INACTIVITY_ARCHIVE_DAYS).toBe(365);
    expect(await sweep("2027-10-06 23:59:59")).toBe(0);
    expect(await sweep("2027-10-08 00:00:00")).toBe(1);
  });

  it("a restore restarts the clock, so the next sweep does not archive the memory again", async () => {
    const m = await mk();
    await sweep("2028-01-01 00:00:00");
    expect((await row(m.id)).status).toBe("archived");
    const { keepLearning } = await import("../lib/learnings");
    const { todayUtc } = await import("../lib/dates");
    const restored = keepLearning(m.id, BOB, "mcp", "Checked against src/lib/db.ts, 2026-10-07");
    expect(restored.changed).toBe(true);
    const r = await row(m.id);
    expect(r.status).toBe("active");
    expect(r.last_accessed_at!.slice(0, 10)).toBe(todayUtc());
    expect(await sweep("now")).toBe(0);
  });

  it("runMaintenance runs both sweeps and reports them", async () => {
    await mk();
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();
    const result = runMaintenance(true);
    expect(result).toMatchObject({ learningsExpired: 0, learningsInactive: 0 });
  });
});

describe("the memory page says why a sweep archived a memory", () => {
  it("names inactivity, and says nothing special once someone else archived it later", async () => {
    const m = await mk({ title: "Quiet fact zrwhy", body: "A quiet fact zrwhyx" });
    const { sweepInactive } = await import("../lib/maintenance");
    sweepInactive(await db(), "2028-01-01 00:00:00");
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: DetailPage } = await import("../app/memory/[id]/page");
    const render = async () =>
      new Response(await renderToReadableStream((await DetailPage({ params: Promise.resolve({ id: m.id }) })) as never)).text();
    expect(await render()).toContain("archived automatically: no agent read it for a year");

    // Restored, then archived again by hand later: the old audit row is no longer the reason.
    await setRow(m.id, "updated_at = datetime('now', '+1 hour')");
    const html = await render();
    expect(html).not.toContain("archived automatically");
    expect(html).toContain("This memory is archived.");
  });
});

describe("migration v40", () => {
  it("clears the default expiry on live memories, keeps the author's own dates, and drops the expiring status", async () => {
    await seedUsers();
    const database = await db();
    const add = (id: string, status: string, expires: string | null, explicit: number) =>
      database
        .prepare(
          "INSERT INTO learnings (id, author_id, title, body, status, expires_at, expires_explicit) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, ALICE, `Title ${id}`, `Body ${id}`, status, expires, explicit);
    add("m-default", "active", "2027-03-01", 0);
    add("m-explicit", "active", "2027-03-01", 1);
    add("m-expiring-default", "expiring", "2026-10-10", 0);
    add("m-expiring-explicit", "expiring", "2026-10-10", 1);
    add("m-archived-default", "archived", "2026-01-01", 0);

    database.prepare("DELETE FROM migrations WHERE version >= 40").run();
    const { _resetDbForTests, getDb } = await import("../lib/db");
    _resetDbForTests();
    const after = getDb();
    const get = (id: string) =>
      after.prepare("SELECT status, expires_at FROM learnings WHERE id = ?").get(id) as { status: string; expires_at: string | null };

    expect(get("m-default")).toEqual({ status: "active", expires_at: null });
    expect(get("m-explicit")).toEqual({ status: "active", expires_at: "2027-03-01" });
    expect(get("m-expiring-default")).toEqual({ status: "active", expires_at: null });
    expect(get("m-expiring-explicit")).toEqual({ status: "active", expires_at: "2026-10-10" });
    expect(get("m-archived-default")).toEqual({ status: "archived", expires_at: null });
    expect(after.prepare("SELECT 1 FROM migrations WHERE version = 40").get()).toBeTruthy();
    const cols = (after.prepare("PRAGMA table_info(learnings)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["last_accessed_at", "access_days"]));
  });
});

describe("migration v40 run again", () => {
  it("never clears a date an author chose through create()", async () => {
    const m = await mk({ expiresAt: "2099-01-31" });
    const plain = await mk();
    const database = await db();
    expect((database.prepare("SELECT expires_explicit AS e FROM learnings WHERE id = ?").get(m.id) as { e: number }).e).toBe(1);
    expect((database.prepare("SELECT expires_explicit AS e FROM learnings WHERE id = ?").get(plain.id) as { e: number }).e).toBe(0);

    database.prepare("DELETE FROM migrations WHERE version >= 40").run();
    const { _resetDbForTests, getDb } = await import("../lib/db");
    _resetDbForTests();
    const after = getDb();
    const get = (id: string) => (after.prepare("SELECT expires_at FROM learnings WHERE id = ?").get(id) as { expires_at: string | null }).expires_at;
    expect(get(m.id)).toBe("2099-01-31");
    expect(get(plain.id)).toBeNull();
  });

  it("a memory archived under the old default date can be restored once v40 has cleared that date", async () => {
    await seedUsers();
    const database = await db();
    database
      .prepare(
        "INSERT INTO learnings (id, author_id, title, body, status, expires_at, expires_explicit) VALUES ('m-old', ?, 'Old title', 'Old body', 'archived', '2026-01-01', 0)",
      )
      .run(ALICE);
    database.prepare("DELETE FROM migrations WHERE version >= 40").run();
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    const { keepLearning } = await import("../lib/learnings");
    const kept = keepLearning("m-old", BOB, "mcp", "Checked against src/lib/db.ts, 2026-10-08");
    expect(kept.changed).toBe(true);
    expect(kept.learning.status).toBe("active");
    expect(kept.learning.expires_at).toBeNull();
  });
});

describe("usage upkeep", () => {
  it("counts quiet memories and those the sweep archived unread, and leaves pinned, standards and read ones out", async () => {
    const { upkeep } = await import("../lib/usage");
    const now = new Date("2027-09-01T12:00:00Z");
    const quiet = await mk();
    await setRow(quiet.id, "created_at = '2026-10-20 00:00:00'");
    const read = await mk();
    await setRow(read.id, "created_at = '2026-10-20 00:00:00', last_accessed_at = '2027-08-30 00:00:00'");
    const pinned = await mk({ kind: "practice" });
    await setRow(pinned.id, "created_at = '2026-10-20 00:00:00', pinned = 1");
    const standard = await mk({ kind: "standard" });
    await setRow(standard.id, "created_at = '2026-10-20 00:00:00'");

    const database = await db();
    const { audit } = await import("../lib/audit");
    audit(database, "system", "auto-archive", "learning", "gone-1", "ui", { details: { reason: "inactive" } });
    audit(database, "system", "auto-archive", "learning", "gone-2", "ui", { details: { reason: "valid-until" } });
    database.prepare("UPDATE audit_log SET at = '2027-08-25 00:00:00' WHERE entity_id IN ('gone-1', 'gone-2')").run();

    expect(upkeep(now)).toMatchObject({ quiet: 1, archivedUnread: 1 });
  });
});
