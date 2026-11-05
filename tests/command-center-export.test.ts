import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Command Center export (lib/command-center.ts ccExportOwn, ccGrantExport, ccExportForApp): the
 * person's own export and consent per report app (tool actions, owner only), and the app route that reads
 * only people who granted it, aggregated unless they allowed entries.
 */

let dataDir: string;
const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const CAROL = "carol.c@example.com";
const ORIGIN = "http://localhost:4310";
const NOW = Date.parse("2026-03-02T10:00:00Z");
// Built at runtime: no token-shaped literal in the source.
const APP_TOKEN = randomBytes(24).toString("hex");
const OTHER_TOKEN = randomBytes(24).toString("hex");
let current: Record<string, string> = {};

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-cc-export-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  process.env.BAB_COMMAND_CENTER_EXPORT_APPS = `reports=${APP_TOKEN},other=${OTHER_TOKEN}`;
  current = {};
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.doMock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:4310", ...current }) }));
  (await import("../lib/config"))._resetConfigForTests();
  (await import("../lib/command-center"))._resetCommandCenterForTests();
  (await import("../lib/rate-limit")).resetForTests();
  const { upsertUser } = await import("../lib/users");
  for (const [id, name] of [[ALICE, "Alice A"], [BOB, "Bob B"], [CAROL, "Carol C"]]) upsertUser({ id, email: id, name, roles: [] });
});

afterEach(async () => {
  vi.useRealTimers();
  (await import("../lib/command-center"))._resetCommandCenterForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  delete process.env.BAB_COMMAND_CENTER_EXPORT_APPS;
  delete process.env.BAB_COMMAND_CENTER;
  (await import("../lib/config"))._resetConfigForTests();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

const agent = (email: string) => ({ id: email, email, name: "Agent", roles: [], source: "device" as const, deviceId: "d1" });

async function seed(email: string, worked: string, id = "billing-export") {
  const cc = await import("../lib/command-center");
  cc.ccPublish(agent(email), email, { v: 1, id, title: "Billing export", key: "KEY-1", source: { machine: "m1", session: "sess-1" }, worked, size: "small" }, "mcp");
}

function appGet(query = "", token: string | null = APP_TOKEN) {
  return new Request(`${ORIGIN}/api/command-center/export${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

async function auditActions(): Promise<{ actor_id: string; action: string; entity_id: string; details: string | null }[]> {
  const { getDb } = await import("../lib/db");
  return getDb().prepare("SELECT actor_id, action, entity_id, details FROM audit_log WHERE action LIKE 'cc_%' ORDER BY id").all() as never;
}

describe("the person's own export and grants, as tool actions", () => {
  const run = async (email: string, args: Record<string, unknown>) => (await import("../lib/command-center")).runCommandCenter(agent(email), args, "mcp", ORIGIN) as Record<string, unknown>;

  it("export gives the caller their own log and the report apps, never anyone else's, audited", async () => {
    await seed(ALICE, "Alice wrote the parser");
    await seed(BOB, "Bob fixed the build");
    const body = await run(ALICE, { action: "export" });
    expect(body.person).toBe(ALICE);
    expect((body.entries as { text: string }[]).map((e) => e.text)).toContain("Alice wrote the parser");
    expect((body.entries as { source?: string }[]).every((e) => e.source === "live")).toBe(true);
    expect(body.exportApps).toEqual([
      { app: "other", grant: null },
      { app: "reports", grant: null },
    ]);
    expect(JSON.stringify(body)).not.toContain("Bob fixed the build");
    expect((await auditActions()).some((a) => a.action === "cc_export_own" && a.actor_id === ALICE)).toBe(true);
  });

  it("export is 404 when Command Center is switched off on the server", async () => {
    process.env.BAB_COMMAND_CENTER = "0";
    (await import("../lib/config"))._resetConfigForTests();
    await expect(run(ALICE, { action: "export" })).rejects.toMatchObject({ status: 404 });
  });

  it("grant_export and revoke_export act for the caller only, audited, with no opt-in first", async () => {
    const cc = await import("../lib/command-center");
    expect(await run(ALICE, { action: "grant_export", id: "reports", level: "entries" })).toMatchObject({ app: "reports", level: "entries" });
    expect(cc.ccGrantsOf(ALICE)).toMatchObject([{ app: "reports", level: "entries" }]);
    expect(cc.ccGrantsOf(BOB)).toEqual([]);
    expect(await run(BOB, { action: "revoke_export", id: "reports" })).toEqual({ revoked: false });
    expect(cc.ccGrantsOf(ALICE)).toHaveLength(1);
    expect(await run(ALICE, { action: "revoke_export", id: "reports" })).toEqual({ revoked: true });
    expect(cc.ccGrantsOf(ALICE)).toEqual([]);
    const actions = (await auditActions()).map((a) => `${a.action}:${a.entity_id}`);
    expect(actions).toContain("cc_export_grant:reports");
    expect(actions).toContain("cc_export_revoke:reports");
  });

  it("grant_export defaults the level to aggregate and takes it from record on the MCP path", async () => {
    const cc = await import("../lib/command-center");
    expect(await run(ALICE, { action: "grant_export", id: "reports" })).toMatchObject({ level: "aggregate" });
    const { findTool } = await import("../lib/mcp");
    const out = JSON.parse(String(await findTool("bab_command_center")!.run(agent(ALICE), { action: "grant_export", id: "reports", record: { level: "entries" } }, { origin: ORIGIN })));
    expect(out).toMatchObject({ app: "reports", level: "entries" });
    expect(cc.ccGrantsOf(ALICE)).toMatchObject([{ app: "reports", level: "entries" }]);
  });

  it("refuses an unknown app, a bad level and unknown fields", async () => {
    const cc = await import("../lib/command-center");
    await expect(run(ALICE, { action: "grant_export", id: "nope" })).rejects.toMatchObject({ status: 404 });
    await expect(run(ALICE, { action: "grant_export", id: "reports", level: "everything" })).rejects.toMatchObject({ status: 400 });
    await expect(run(ALICE, { action: "grant_export" })).rejects.toMatchObject({ status: 400 });
    await expect(run(ALICE, { action: "export", id: "x" })).rejects.toThrow(/unknown field 'id' for export/);
    await expect(run(ALICE, { action: "revoke_export", id: "reports", level: "entries" })).rejects.toThrow(/unknown field 'level' for revoke_export/);
    expect(cc.ccGrantsOf(ALICE)).toEqual([]);
  });

  it("delete_all also removes the grants", async () => {
    const cc = await import("../lib/command-center");
    await seed(ALICE, "Alice wrote the parser");
    cc.ccGrantExport(ALICE, "reports", "aggregate");
    await run(ALICE, { action: "delete_all", confirm: true });
    expect(cc.ccGrantsOf(ALICE)).toEqual([]);
    expect(cc.ccLogOf(ALICE)).toEqual([]);
  });
});

describe("GET /api/command-center/export for a report app", () => {
  it("is 401 without a token or with a wrong one, and never echoes the token", async () => {
    const { GET } = await import("../app/api/command-center/export/route");
    expect((await GET(appGet("", null))).status).toBe(401);
    const wrong = await GET(appGet("", APP_TOKEN + "x"));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(APP_TOKEN);
  });

  it("is 404 when no export apps are set up", async () => {
    delete process.env.BAB_COMMAND_CENTER_EXPORT_APPS;
    (await import("../lib/config"))._resetConfigForTests();
    const { GET } = await import("../app/api/command-center/export/route");
    expect((await GET(appGet())).status).toBe(404);
  });

  it("is a public path, so the API token gate lets it through", async () => {
    const { isPublicPath } = await import("../lib/public-paths");
    expect(isPublicPath("/api/command-center/export")).toBe(true);
    expect(isPublicPath("/api/command-center/billing-export")).toBe(false);
  });

  it("sees only people who granted this app, aggregated by default", async () => {
    const cc = await import("../lib/command-center");
    await seed(ALICE, "Alice wrote the parser");
    await seed(BOB, "Bob fixed the build");
    await seed(CAROL, "Carol tidied up");
    cc.ccGrantExport(ALICE, "reports", "aggregate");
    cc.ccGrantExport(BOB, "other", "entries");
    cc.ccGrantExport(CAROL, "reports", "entries");
    cc.ccRevokeExport(CAROL, "reports");
    const { GET } = await import("../app/api/command-center/export/route");
    const res = await GET(appGet());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await res.text();
    expect(raw).not.toContain(APP_TOKEN);
    const body = JSON.parse(raw);
    expect(body.app).toBe("reports");
    expect(body.people.map((p: { person: string }) => p.person)).toEqual([ALICE]);
    const rows = body.people[0].rows;
    expect(rows).toEqual([{ initiative: "billing-export", title: "Billing export", key: "KEY-1", day: "2026-03-02", entries: 1, worked: 1, backfilled: 0, sizes: { small: 1, medium: 0, large: 0 } }]);
    expect(raw).not.toContain("Alice wrote the parser");
    expect(raw).not.toContain("sess-1");
    expect(body.people[0].entries).toBeUndefined();
    const audit = (await auditActions()).find((a) => a.action === "cc_export_app");
    expect(audit?.actor_id).toBe("app:reports");
    expect(audit?.details).not.toContain(APP_TOKEN);
  });

  it("gives entries only when the person allowed them and the app asks for them", async () => {
    const cc = await import("../lib/command-center");
    await seed(ALICE, "Alice wrote the parser");
    await seed(BOB, "Bob fixed the build");
    cc.ccGrantExport(ALICE, "reports", "entries");
    cc.ccGrantExport(BOB, "reports", "aggregate");
    const { GET } = await import("../app/api/command-center/export/route");
    const aggregated = await (await GET(appGet())).json();
    expect(aggregated.people.every((p: { rows?: unknown }) => Array.isArray(p.rows))).toBe(true);
    const detailed = await (await GET(appGet("?detail=entries"))).json();
    const alice = detailed.people.find((p: { person: string }) => p.person === ALICE);
    const bob = detailed.people.find((p: { person: string }) => p.person === BOB);
    expect(alice.entries.map((e: { text: string }) => e.text)).toEqual(["Alice wrote the parser"]);
    expect(alice.entries.map((e: { source: string }) => e.source)).toEqual(["live"]);
    expect(bob.entries).toBeUndefined();
    expect(JSON.stringify(bob)).not.toContain("Bob fixed the build");
  });

  it("delete_all withdraws every grant: the app sees nobody", async () => {
    const cc = await import("../lib/command-center");
    await seed(ALICE, "Alice wrote the parser");
    cc.ccGrantExport(ALICE, "reports", "entries");
    cc.ccDeleteAll(ALICE);
    expect(cc.ccGrantsOf(ALICE)).toEqual([]);
    const { GET } = await import("../app/api/command-center/export/route");
    expect((await (await GET(appGet())).json()).people).toEqual([]);
  });

  it("serves a grant whose person never had the old switch on", async () => {
    const cc = await import("../lib/command-center");
    await seed(ALICE, "Alice wrote the parser");
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE users SET command_center_enabled_at = NULL WHERE id = ?").run(ALICE);
    cc.ccGrantExport(ALICE, "reports", "aggregate");
    const { GET } = await import("../app/api/command-center/export/route");
    expect((await (await GET(appGet())).json()).people.map((p: { person: string }) => p.person)).toEqual([ALICE]);
  });

  it("limits each address before the token is checked, with a 429 that says how long to wait", async () => {
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    try {
      (await import("../lib/config"))._resetConfigForTests();
      const { checkRateLimit, ANON_RATE_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
      for (let i = 0; i < ANON_RATE_LIMIT_PER_MINUTE; i++) checkRateLimit("cc-export-anon:203.0.113.7", ANON_RATE_LIMIT_PER_MINUTE);
      const { GET } = await import("../app/api/command-center/export/route");
      const from = (ip: string, token: string | null) =>
        new Request(`${ORIGIN}/api/command-center/export`, { headers: { "x-real-ip": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      const limited = await GET(from("203.0.113.7", APP_TOKEN));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect((await limited.json()).error).toContain("wait a minute");
      // Wrong tokens from that address are refused the same way, so it cannot keep guessing.
      expect((await GET(from("203.0.113.7", OTHER_TOKEN + "x"))).status).toBe(429);
      // Another address is not affected, nor is an address that spent the other public paths' budget.
      for (let i = 0; i < ANON_RATE_LIMIT_PER_MINUTE; i++) checkRateLimit("anon:203.0.113.8", ANON_RATE_LIMIT_PER_MINUTE);
      for (let i = 0; i < 3000; i++) checkRateLimit("anon-global", 3000);
      expect((await GET(from("203.0.113.8", APP_TOKEN))).status).toBe(200);
    } finally {
      delete process.env.BAB_CLIENT_IP_HEADER;
    }
  });

  it("counts only worked lines as worked, not imported notes", async () => {
    const cc = await import("../lib/command-center");
    const at = "2026-03-02T09:00:00.000Z";
    const base = { initiative: "a", title: "A", key: null, text: "x", size: null, session: null, machine: null, at };
    const rows = cc.aggregate([
      { ...base, id: "1", kind: "worked", source: "live" },
      { ...base, id: "2", kind: "note", source: "import" },
      { ...base, id: "3", kind: "task_done", source: "live" },
    ]);
    expect(rows).toEqual([{ initiative: "a", title: "A", key: null, day: "2026-03-02", entries: 3, worked: 1, backfilled: 0, sizes: { small: 0, medium: 0, large: 0 } }]);
  });

  it("counts backfilled entries per row, so reports can tell them from live work", async () => {
    const cc = await import("../lib/command-center");
    const at = "2026-03-02T09:00:00.000Z";
    const base = { initiative: "a", title: "A", key: null, text: "x", size: null, session: null, machine: null, at };
    const rows = cc.aggregate([
      { ...base, id: "1", kind: "worked", source: "live" },
      { ...base, id: "2", kind: "worked", source: "backfill" },
      { ...base, id: "3", kind: "worked", source: "backfill" },
    ]);
    expect(rows).toEqual([{ initiative: "a", title: "A", key: null, day: "2026-03-02", entries: 3, worked: 3, backfilled: 2, sizes: { small: 0, medium: 0, large: 0 } }]);
  });

  it("drops a person at once when they revoke", async () => {
    const cc = await import("../lib/command-center");
    await seed(ALICE, "Alice wrote the parser");
    cc.ccGrantExport(ALICE, "reports", "aggregate");
    cc.ccRevokeExport(ALICE, "reports");
    const { GET } = await import("../app/api/command-center/export/route");
    expect((await (await GET(appGet())).json()).people).toEqual([]);
  });

  it("filters by whole UTC days and refuses bad ranges", async () => {
    const cc = await import("../lib/command-center");
    await seed(ALICE, "Alice wrote the parser");
    cc.ccGrantExport(ALICE, "reports", "aggregate");
    const { GET } = await import("../app/api/command-center/export/route");
    expect((await (await GET(appGet("?from=2026-03-03&to=2026-03-10"))).json()).people[0].rows).toEqual([]);
    expect((await (await GET(appGet("?from=2026-03-02&to=2026-03-03"))).json()).people[0].rows).toHaveLength(1);
    expect((await GET(appGet("?from=2026-3-1"))).status).toBe(400);
    expect((await GET(appGet("?from=2026-03-05&to=2026-03-01"))).status).toBe(400);
    expect((await GET(appGet("?from=2024-01-01&to=2026-03-01"))).status).toBe(400);
    expect((await GET(appGet("?detail=all"))).status).toBe(400);
  });
});
