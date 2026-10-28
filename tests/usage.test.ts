import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * The queries behind /usage (lib/usage.ts) and the page itself: weekly activity, growth, what is in
 * BAB, the most helpful memories, models, upkeep, the health numbers, the 5-minute cache, and what
 * a maintainer sees that others do not.
 */

let dataDir: string;
const MAINT = "mia.maint@example.com";
const A = "ann.a@example.com";
const B = "bob.b@example.com";
const LEARN = "/mcp#tools/call:bab_learn";
// A Tuesday: the current ISO week starts Monday 2026-10-05, the first of the 52 on 2025-10-13.
const NOW = new Date("2026-10-06T12:00:00Z");

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-usage-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_MAINTAINERS = MAINT;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  vi.doUnmock("next/headers");
  vi.doUnmock("next/navigation");
  vi.doUnmock("@/app/components/shell/Shell");
  vi.restoreAllMocks();
  vi.resetModules();
});

async function row(
  actor: string,
  action: string,
  at: string,
  over: { path?: string; entity?: string; entityId?: string; details?: unknown; via?: "mcp" | "ui" } = {},
) {
  const { getDb } = await import("../lib/db");
  getDb()
    .prepare("INSERT INTO audit_log (actor_id, action, entity, entity_id, via, at, path, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(actor, action, over.entity ?? "request", over.entityId ?? "x", over.via ?? "mcp", at, over.path ?? null, over.details === undefined ? null : JSON.stringify(over.details));
}
const learnCall = (actor: string, at: string, cx?: string) => row(actor, "POST", at, { path: LEARN, details: cx ? { cx } : undefined });

describe("week helpers", () => {
  it("finds the Monday and the ISO label, across the year end", async () => {
    const { weekStart, isoWeekLabel, lastWeeks, USAGE_WEEKS } = await import("../lib/usage");
    expect(weekStart(new Date("2026-10-04T23:59:00Z"))).toBe("2026-09-28"); // Sunday
    expect(weekStart(new Date("2026-10-05T00:00:00Z"))).toBe("2026-10-05"); // Monday
    expect(isoWeekLabel("2026-10-05")).toBe("2026-W41");
    expect(isoWeekLabel("2026-12-28")).toBe("2026-W53");
    expect(isoWeekLabel("2027-01-04")).toBe("2027-W01");
    const weeks = lastWeeks(NOW);
    expect(USAGE_WEEKS).toBe(52); // the last 12 months
    expect(weeks).toHaveLength(52);
    expect(weeks[0]).toBe("2025-10-13");
    expect(weeks[51]).toBe("2026-10-05");
  });
});

describe("capture", () => {
  it("counts bab_learn calls, distinct sessions and people per week, and ignores rows older than 12 months", async () => {
    await learnCall(A, "2026-10-05 08:00:00", "c:1");
    await learnCall(A, "2026-10-06 08:00:00", "c:1");
    await learnCall(B, "2026-10-07 08:00:00", "d:dev");
    await learnCall(B, "2026-09-28 08:00:00"); // previous week, an old row without cx
    await learnCall(B, "2025-10-12 08:00:00", "c:old"); // before the window
    await row(A, "POST", "2026-10-06 08:00:00", { path: "/mcp#tools/call:bab_search" });
    const { usageReport } = await import("../lib/usage");
    const weeks = usageReport(NOW).capture;
    expect(weeks.find((w) => w.week === "2026-10-05")).toMatchObject({ learnCalls: 3, sessions: 2, people: 2 });
    expect(weeks.find((w) => w.week === "2026-09-28")).toMatchObject({ learnCalls: 1, sessions: 0, people: 1 });
    expect(weeks.reduce((n, w) => n + w.learnCalls, 0)).toBe(4);
  });

  it("counts a Stop nudge as followed only by a bab_learn from the same person within 10 minutes", async () => {
    await row(A, "stop_nudge", "2026-10-06 09:00:00", { entity: "session" });
    await learnCall(A, "2026-10-06 09:10:00"); // exactly 10 minutes: followed
    await row(B, "stop_nudge", "2026-10-06 10:00:00", { entity: "session" });
    await learnCall(B, "2026-10-06 10:11:00"); // too late
    await row(A, "stop_nudge", "2026-10-06 11:00:00", { entity: "session" });
    await learnCall(B, "2026-10-06 11:01:00"); // someone else
    await row(B, "stop_nudge", "2026-10-06 12:00:00", { entity: "session" });
    await learnCall(B, "2026-10-06 11:59:00"); // before the nudge
    const { usageReport } = await import("../lib/usage");
    const cur = usageReport(NOW).capture.find((w) => w.week === "2026-10-05")!;
    expect(cur.nudges).toBe(4);
    expect(cur.followed).toBe(1);
  });

  it("the Stop hook writes one stop_nudge audit row per nudge", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: A, email: A, name: "Ann", roles: [] });
    const { mintOrReuseLinkToken, redeemLinkToken } = await import("../lib/session-links");
    redeemLinkToken(mintOrReuseLinkToken("sess-u1"), A);
    const { POST } = await import("../app/api/hook/route");
    const send = (body: unknown) =>
      POST(
        new Request("https://bab.example.com/api/hook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    for (let i = 0; i < 8; i++) await send({ hook_event_name: "UserPromptSubmit", session_id: "sess-u1" });
    const ending =
      "I fixed the flaky test. Root cause was a shared static clock that two fixtures mutated. " +
      "The fix isolates the clock per fixture, all tests pass locally and the PR is merged. " +
      "Nothing else is needed from you on this one, the pipeline is green and the change is deployed.";
    const first = await (await send({ hook_event_name: "Stop", session_id: "sess-u1", last_assistant_message: ending })).json();
    expect(first.decision).toBe("block");
    await send({ hook_event_name: "Stop", session_id: "sess-u1", last_assistant_message: ending }); // cooldown: no second row
    const { getDb } = await import("../lib/db");
    const rows = getDb().prepare("SELECT actor_id, entity_id FROM audit_log WHERE action = 'stop_nudge'").all();
    expect(rows).toEqual([{ actor_id: A, entity_id: "sess-u1" }]);
  });
});

describe("identify", () => {
  const identifyRow = (actor: string, at: string, source: string, cx: string) =>
    row(actor, "identify", at, { entity: "user", details: { source, cx } });

  it("lists a device or connection with more than 3 identifies on one day, and the remembered-none share", async () => {
    for (let i = 0; i < 4; i++) await identifyRow(A, `2026-10-06 0${i}:00:00`, "none", "c:loop");
    for (let i = 0; i < 3; i++) await identifyRow(B, `2026-10-06 0${i}:30:00`, "device", "d:fine"); // 3 is not a loop
    for (let i = 0; i < 2; i++) await identifyRow(B, `2026-10-05 0${i}:30:00`, "connection", "c:two");
    // An older row without cx falls back to the device id.
    await row(B, "identify", "2026-10-06 05:00:00", { entity: "user", details: { source: "device", deviceId: "legacy" } });
    const { usageReport } = await import("../lib/usage");
    const report = usageReport(NOW);
    expect(report.identifyLoops).toEqual([{ day: "2026-10-06", by: "connection", who: "c:loop", calls: 4 }]);
    expect(report.identify.find((w) => w.week === "2026-10-05")).toMatchObject({ identifies: 10, none: 4 });
  });

  it("audits a refusal with its reason and stores no address", async () => {
    const { identify } = await import("../lib/identify");
    const ctx = { deviceHash: null, deviceLabel: "x", connectionId: null, ip: "9.9.9.9" };
    expect(() => identify({ email: "alice@example.com" }, ctx)).toThrow(/long address/);
    expect(() => identify({ email: "someone@gmail.com" }, ctx)).toThrow();
    expect(() => identify({ email: "other@gmail.com" }, ctx)).toThrow();
    expect(() => identify({}, ctx)).toThrow();
    const { refusalsByReason, identifyByWeek, lastWeeks } = await import("../lib/usage");
    const weeks = lastWeeks(new Date());
    const reasons = refusalsByReason(weeks);
    expect(reasons[0]).toEqual({ reason: "not-allowed", n: 2 });
    expect(reasons.slice(1).sort((x, y) => x.reason.localeCompare(y.reason))).toEqual([
      { reason: "missing-email", n: 1 },
      { reason: "wrong-form", n: 1 },
    ]);
    expect(identifyByWeek(weeks).at(-1)!.refused).toBe(4);
    const { getDb } = await import("../lib/db");
    const stored = getDb().prepare("SELECT actor_id, details FROM audit_log WHERE action = 'identify_refused'").all();
    expect(JSON.stringify(stored)).not.toContain("gmail");
    expect(stored.every((r) => r.actor_id === "anonymous")).toBe(true);
  });
});

describe("the cx detail", () => {
  it("a bab_learn tools/call row names the connection by a short hash, never the id", async () => {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": A, "x-bab-actor-name": "Ann A", "mcp-session-id": "s".repeat(43) }),
    }));
    const { POST } = await import("../app/mcp/route");
    const res = await POST(
      new Request("https://bab.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", host: "bab.example.com", "mcp-session-id": "s".repeat(43) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bab_learn", arguments: {} } }),
      }),
    );
    await res.json();
    const { getDb } = await import("../lib/db");
    const r = getDb().prepare("SELECT details FROM audit_log WHERE path = ?").get(LEARN) as { details: string };
    expect(JSON.parse(r.details).cx).toMatch(/^c:[0-9a-f]{8}$/);
    expect(r.details).not.toContain("sssss");
  });
});

describe("duplicates, teams and flags", () => {
  async function seed() {
    const { upsertUser } = await import("../lib/users");
    for (const id of [A, B, MAINT]) upsertUser({ id, email: id, name: id, roles: [] });
  }

  it("counts the 409 duplicate rate and distinct authors per team tag this week", async () => {
    await seed();
    const { create } = await import("../lib/learnings");
    const base = { title: "Kafka consumers must be idempotent zq1", body: "Every consumer retries; a repeated message must not double write zq1x." };
    create({ authorId: A, ...base, tags: ["engineering", "kafka"] });
    expect(() => create({ authorId: B, ...base, tags: ["engineering"] })).toThrow();
    create({ authorId: B, title: "Sales kickoff checklist zq2", body: "Book the room two weeks ahead zq2x.", tags: ["sales", "engineering"] });
    create({ authorId: B, title: "Untagged thing zq3", body: "Nothing about teams zq3x.", tags: ["misc"] });
    const { usageReport, lastWeeks } = await import("../lib/usage");
    const now = new Date();
    const cur = lastWeeks(now).at(-1)!;
    const report = usageReport(now);
    expect(report.quality.find((w) => w.week === cur)).toMatchObject({ created: 3, duplicateRejected: 1 });
    const team = report.teams.find((w) => w.week === cur)!;
    expect(team.byTeam).toEqual({ engineering: 2, sales: 1 });
    expect(team.noTeamTag).toBe(1);
  });

  it("lists the flagged standards and decisions that wait, with the same count as the maintainer nudge", async () => {
    await seed();
    const { create, flag, flaggedStandardsWaiting } = await import("../lib/learnings");
    const s = create({ authorId: A, title: "Standard one zq4", body: "Body zq4x.", kind: "standard", confirmNotDuplicate: true });
    const d = create({ authorId: A, title: "Decision one zq5", body: "Body zq5x.", kind: "decision", confirmNotDuplicate: true });
    create({ authorId: A, title: "Unflagged standard zq6", body: "Body zq6x.", kind: "standard", confirmNotDuplicate: true });
    flag(s.id, B, "mcp", "Moved to src/x.ts, 2026-10-01");
    flag(d.id, B, "mcp", "Replaced, 2026-10-01");
    const { flaggedWaiting } = await import("../lib/usage");
    const items = flaggedWaiting();
    expect(items).toHaveLength(flaggedStandardsWaiting());
    expect(items.map((i) => i.id).sort()).toEqual([s.id, d.id].sort());
    expect(items.find((i) => i.id === s.id)).toMatchObject({ title: "Standard one zq4", kind: "standard", authorId: A, flaggers: 1 });
  });
});

describe("performance at 50k audit rows", () => {
  it("builds the whole report fast and uses the audit indexes", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const insert = db.prepare(
      "INSERT INTO audit_log (actor_id, action, entity, entity_id, via, at, path, details) VALUES (?, ?, 'request', 'x', 'mcp', datetime('2026-10-06 12:00:00', ?), ?, ?)",
    );
    db.exec("BEGIN");
    for (let i = 0; i < 50_000; i++) {
      const bucket = i % 10;
      insert.run(
        `user${i % 40}@example.com`,
        bucket === 0 ? "identify" : bucket === 1 ? "stop_nudge" : "POST",
        `-${i % 90000} seconds`,
        bucket === 2 ? LEARN : bucket === 3 ? "/mcp#tools/call:bab_search" : "/mcp#tools/call:bab_inbox",
        bucket === 0 ? JSON.stringify({ source: "none", cx: `c:${i % 50}` }) : null,
      );
    }
    db.exec("COMMIT");
    const { usageReport, lastWeeks } = await import("../lib/usage");
    const started = performance.now();
    const report = usageReport(NOW);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(report.capture.reduce((n, w) => n + w.learnCalls, 0)).toBeGreaterThan(0);

    const since = `${lastWeeks(NOW)[0]} 00:00:00`;
    const plan = (sql: string, ...p: string[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as Array<{ detail: string }>).map((r) => r.detail).join("\n");
    expect(plan("SELECT COUNT(*) FROM audit_log WHERE path = ? AND at >= ?", LEARN, since)).toContain("idx_audit_path_at");
    expect(plan("SELECT COUNT(*) FROM audit_log WHERE action IN ('identify','identify_refused') AND at >= ?", since)).toContain("idx_audit_action_at");
    expect(plan("SELECT 1 FROM audit_log a WHERE a.actor_id = ? AND a.path = ? AND a.at >= ? AND a.at <= ?", "u", LEARN, since, since)).toMatch(
      /idx_audit_(actor_at|path_at)/,
    );
    // The /usage activity shapes: saves and reactions, searches, people, and the month's top memories.
    const end = "9999-12-31 23:59:59";
    expect(
      plan(
        "SELECT COUNT(*) FROM audit_log WHERE action IN ('create','helpful','kudos','confirm') AND at >= ? AND at < ? AND +entity = 'learning'",
        since,
        end,
      ),
    ).toContain("idx_audit_action_at");
    expect(plan("SELECT COUNT(*) FROM audit_log WHERE path IN (?, ?) AND at >= ? AND at < ?", "a", "b", since, end)).toContain("idx_audit_path_at");
    expect(plan("SELECT COUNT(DISTINCT actor_id) FROM audit_log WHERE at >= ? AND at < ? AND actor_id NOT IN ('anonymous','system')", since, end)).toMatch(
      /USING (COVERING )?INDEX idx_audit_(at|actor_at)/,
    );
    const top = plan(
      `SELECT l.id, COUNT(*) FROM audit_log a JOIN learnings l ON l.id = a.entity_id
       WHERE a.action IN ('helpful','kudos','confirm') AND a.at >= ? AND +a.entity = 'learning' AND l.status != 'deleted' GROUP BY l.id`,
      since,
    );
    expect(top).toContain("idx_audit_action_at");
    expect(top).not.toMatch(/SCAN (TABLE )?audit_log(?! USING)/);
    // The upkeep tiles: memories the sweep archived unread, and the keeps, restores and retires, over the last 12 months.
    expect(
      plan(
        "SELECT COUNT(*) FROM audit_log WHERE action = 'auto-archive' AND at >= ? AND +entity = 'learning' AND json_extract(details, '$.reason') = 'inactive'",
        since,
      ),
    ).toContain("idx_audit_action_at");
    expect(
      plan(
        "SELECT action, COUNT(*) FROM audit_log WHERE action IN ('keep', 'restored', 'retire') AND at >= ? AND +entity = 'learning' GROUP BY action",
        since,
      ),
    ).toContain("idx_audit_action_at");
    // The quiet count reads the live learnings and practices through the status index, never the whole table.
    expect(
      plan(
        "SELECT COUNT(*) FROM learnings WHERE status = 'active' AND kind IN ('learning', 'practice') AND pinned = 0 AND max(COALESCE(last_accessed_at, created_at), ?) < ?",
        "2026-10-07",
        since,
      ),
    ).toMatch(/idx_learnings_(status_created_at|kind_status)/);
    // Found nothing: the searches with a recorded count, on the path index.
    const outcomes = plan(
      `SELECT COUNT(*), SUM(json_extract(details, '$.results') = 0) FROM audit_log
       WHERE path IN (?, ?) AND at >= ? AND (path = ? OR action = 'GET') AND json_extract(details, '$.results') IS NOT NULL`,
      "/mcp#tools/call:bab_search",
      "/api/learnings",
      since,
      "/mcp#tools/call:bab_search",
    );
    expect(outcomes).toContain("idx_audit_path_at");
    expect(outcomes).not.toMatch(/SCAN (TABLE )?audit_log(?! USING)/);
    // Never used: live learnings through their status index, votes by learning.
    const unused = plan(
      `SELECT COUNT(*), SUM(l.last_accessed_at IS NULL AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.learning_id = l.id AND v.kind IN ('helpful', 'kudos', 'confirm') AND lower(v.voter_id) != lower(l.author_id)))
       FROM learnings l WHERE l.status = 'active' AND l.kind IN ('learning', 'practice') AND l.pinned = 0 AND l.created_at < ?`,
      since,
    );
    expect(unused).toMatch(/idx_learnings_/);
    expect(unused).toMatch(/idx_votes_learning_kind|sqlite_autoindex_votes/);
  });
});


/* ------------------------------------------------------------------ helpers */

async function people(...ids: string[]) {
  const { upsertUser } = await import("../lib/users");
  for (const id of ids) upsertUser({ id, email: id, name: id.split("@")[0], roles: [] });
}

let seq = 0;
/** A memory with its dates and status set directly, so tests can place it in any week. */
async function memory(
  author: string,
  over: {
    kind?: "learning" | "practice" | "standard" | "decision";
    tags?: string[];
    model?: string;
    createdAt?: string;
    status?: string;
    title?: string;
  } = {},
) {
  const { create } = await import("../lib/learnings");
  seq++;
  const m = create({
    authorId: author,
    title: over.title ?? `Usage memory number ${seq} about topic q${seq}x${seq}`,
    body: `Body for usage memory ${seq}, unique words z${seq}y${seq}w.`,
    tags: over.tags ?? [],
    kind: over.kind,
    model: over.model,
    confirmNotDuplicate: true,
  });
  const { getDb } = await import("../lib/db");
  if (over.createdAt) getDb().prepare("UPDATE learnings SET created_at = ? WHERE id = ?").run(over.createdAt, m.id);
  if (over.status) getDb().prepare("UPDATE learnings SET status = ? WHERE id = ?").run(over.status, m.id);
  return m.id;
}

async function vote(learningId: string, voter: string, kind: string) {
  const { getDb } = await import("../lib/db");
  getDb().prepare("INSERT INTO votes (learning_id, voter_id, kind) VALUES (?, ?, ?)").run(learningId, voter, kind);
}

/** Every number in the report is finite: no NaN, no Infinity. */
function allFinite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allFinite);
  if (value && typeof value === "object") return Object.values(value).every(allFinite);
  return true;
}

/* ----------------------------------------------------------------- activity */

describe("activity per week and the hero tiles", () => {
  it("is all zeros, with nothing to divide by zero, on an empty database", async () => {
    const { usageReport } = await import("../lib/usage");
    const r = usageReport(NOW);
    expect(r.activity).toHaveLength(52);
    expect(r.activity.every((w) => w.saves + w.searches + w.reactions + w.people + w.newPeople === 0)).toBe(true);
    expect(r.totals).toEqual({ saves: 0, searches: 0, reactions: 0, helpedSearches: 0, people: 0 });
    expect(r.growth).toEqual({ points: [], live: 0, lastMonth: 0 });
    expect(r.contents.byKind.map((k) => k.n)).toEqual([0, 0, 0, 0]);
    expect(r.contents.standing).toEqual({ strong: 0, fair: 0, weak: 0 });
    expect(r.topHelpful).toEqual([]);
    expect(r.models).toEqual([]);
    expect(r.upkeep).toEqual({ quiet: 0, archivedUnread: 0, kept: 0, restored: 0, retired: 0, comments: 0 });
    expect(r.dataSince).toBeNull();
    expect(allFinite(r)).toBe(true);
  });

  it("counts one week: saves, searches, helpful reactions and the people behind any call", async () => {
    await row(A, "create", "2026-10-05 08:00:00", { entity: "learning" });
    await row(B, "create", "2026-10-06 08:00:00", { entity: "learning" });
    await row(A, "create", "2026-10-06 08:00:00", { entity: "feedback" }); // not a memory
    for (let i = 0; i < 3; i++) await row(A, "POST", `2026-10-06 09:0${i}:00`, { path: "/mcp#tools/call:bab_search" });
    await row(B, "GET", "2026-10-06 09:10:00", { path: "/api/learnings" });
    await row(B, "GET", "2026-10-06 09:11:00", { path: "/api/learnings" });
    await row(B, "POST", "2026-10-06 09:12:00", { path: "/api/learnings" }); // a save, not a search
    for (const action of ["helpful", "kudos", "confirm"]) await row(B, action, "2026-10-06 10:00:00", { entity: "learning" });
    await row(B, "not_helpful", "2026-10-06 10:00:00", { entity: "learning" });
    await row(B, "flag", "2026-10-06 10:00:00", { entity: "learning" });
    await row("anonymous", "GET", "2026-10-06 10:00:00", { path: "/memory" });
    await row("system", "device-expire", "2026-10-06 10:00:00", { entity: "device" });
    const { usageReport } = await import("../lib/usage");
    const r = usageReport(NOW);
    expect(r.activity.at(-1)).toMatchObject({ week: "2026-10-05", saves: 2, searches: 5, reactions: 3, people: 2 });
    expect(r.activity.slice(0, -1).every((w) => w.saves + w.searches + w.reactions + w.people === 0)).toBe(true);
    // One week in the window: the totals are that week.
    expect(r.totals).toEqual({ saves: 2, searches: 5, reactions: 3, helpedSearches: 0, people: 2 }); // B reacted 49 minutes after searching
  });

  it("credits a helpful reaction to the same person's last search within 30 minutes, once per search", async () => {
    // A rephrases twice, then marks two memories helpful: only the last search counts, once.
    for (const m of ["00", "01", "02"]) await row(A, "POST", `2026-10-06 09:${m}:00`, { path: "/mcp#tools/call:bab_search" });
    await row(A, "helpful", "2026-10-06 09:10:00", { entity: "learning" });
    await row(A, "kudos", "2026-10-06 09:12:00", { entity: "learning" });
    // B: a confirm says "still true", not "helped"; a helpful 40 minutes later is too late.
    await row(B, "GET", "2026-10-06 10:00:00", { path: "/api/learnings" });
    await row(B, "confirm", "2026-10-06 10:05:00", { entity: "learning" });
    await row(B, "GET", "2026-10-06 11:00:00", { path: "/api/learnings" });
    await row(B, "helpful", "2026-10-06 11:40:00", { entity: "learning" });
    // Someone else's reaction never credits A's search.
    await row(A, "POST", "2026-10-06 12:00:00", { path: "/mcp#tools/call:bab_search" });
    await row(B, "helpful", "2026-10-06 12:01:00", { entity: "learning" });
    const { usageReport } = await import("../lib/usage");
    const r = usageReport(NOW);
    expect(r.activity.at(-1)).toMatchObject({ searches: 6, helpedSearches: 1 });
    expect(r.totals.helpedSearches).toBe(1);
  });

  it("never credits a search with a reaction from the memory page, but counts it as found helpful", async () => {
    await row(A, "POST", "2026-10-06 09:00:00", { path: "/mcp#tools/call:bab_search" });
    await row(A, "helpful", "2026-10-06 09:05:00", { entity: "learning", via: "ui" });
    await row(A, "kudos", "2026-10-06 09:06:00", { entity: "learning", via: "ui" });
    const { usageReport } = await import("../lib/usage");
    const r = usageReport(NOW);
    expect(r.totals.helpedSearches).toBe(0);
    expect(r.totals.reactions).toBe(2);
  });

  it("counts a search exactly 30 minutes before the reaction", async () => {
    await row(A, "POST", "2026-10-06 09:00:00", { path: "/mcp#tools/call:bab_search" });
    await row(A, "helpful", "2026-10-06 09:30:00", { entity: "learning" });
    const { usageReport } = await import("../lib/usage");
    expect(usageReport(NOW).totals.helpedSearches).toBe(1);
  });

  it("still in BAB: live memories saved inside the window only", async () => {
    await people(A);
    await memory(A, { createdAt: "2026-10-05 09:00:00" });
    await memory(A, { createdAt: "2026-10-05 10:00:00", status: "archived" });
    await memory(A, { createdAt: "2024-01-01 09:00:00" }); // live, but saved before the window
    const { usageReport } = await import("../lib/usage");
    const r = usageReport(NOW);
    expect(r.savedStillLive).toBe(1);
    expect(r.growth.live).toBe(2);
  });

  it("spreads a typical year and totals it: sums for the counts, distinct people for people", async () => {
    // Saves in five of the last eight weeks, oldest first.
    const plan: Array<[string, number]> = [
      ["2026-08-18", 1],
      ["2026-09-01", 2],
      ["2026-09-15", 4],
      ["2026-09-29", 3],
      ["2026-10-05", 5],
    ];
    for (const [day, n] of plan) for (let i = 0; i < n; i++) await row(A, "create", `${day} 0${i}:00:00`, { entity: "learning" });
    await row(A, "create", "2025-10-12 08:00:00", { entity: "learning" }); // the Sunday before the window
    await row(A, "create", "2025-10-13 00:00:00", { entity: "learning" }); // the first second of the window
    await row(B, "POST", "2026-09-28 08:00:00", { path: "/mcp#tools/call:bab_search" });
    await row(B, "POST", "2026-10-06 08:00:00", { path: "/mcp#tools/call:bab_search" });
    await row(B, "helpful", "2026-09-29 11:59:00", { entity: "learning" });
    await row(MAINT, "GET", "2026-09-29 12:30:00", { path: "/usage" });
    const { usageReport } = await import("../lib/usage");
    const r = usageReport(NOW);
    expect(r.activity[0]).toMatchObject({ week: "2025-10-13", saves: 1 });
    expect(r.activity.slice(-8).map((w) => w.saves)).toEqual([1, 0, 2, 0, 4, 0, 3, 5]);
    expect(r.activity.slice(-8).map((w) => w.label.slice(5))).toEqual(["W34", "W35", "W36", "W37", "W38", "W39", "W40", "W41"]);
    expect(r.activity.at(-2)).toMatchObject({ saves: 3, searches: 1, reactions: 1, people: 3 });
    // The tiles: 1 + 1 + 2 + 4 + 3 + 5 saves, 2 searches, 1 reaction.
    expect(r.totals).toMatchObject({ saves: 16, searches: 2, reactions: 1 });
    // Three different people in the year (A, B, MAINT), though the weekly people counts add up to more.
    expect(r.totals.people).toBe(3);
    expect(r.activity.reduce((n, w) => n + w.people, 0)).toBeGreaterThan(3);
    // Each person is new in exactly one week: A in the first, B and MAINT on 2026-09-28.
    expect(r.activity[0].newPeople).toBe(1);
    expect(r.activity.at(-2)!.newPeople).toBe(2);
    expect(r.activity.at(-1)!.newPeople).toBe(0);
    expect(r.activity.reduce((n, w) => n + w.newPeople, 0)).toBe(r.totals.people);
  });

  it("totals the same definitions as the weekly counts", async () => {
    await row(A, "create", "2026-10-06 08:00:00", { entity: "learning" });
    await row(A, "create", "2026-10-06 08:00:00", { entity: "feedback" }); // not a memory
    await row(B, "GET", "2026-10-06 09:00:00", { path: "/api/learnings" });
    await row(B, "POST", "2026-10-06 09:00:00", { path: "/api/learnings" }); // a save, not a search
    await row("anonymous", "GET", "2026-10-06 10:00:00", { path: "/memory" });
    await row("system", "device-expire", "2026-10-06 10:00:00", { entity: "device" });
    const { usageReport, activityTotals } = await import("../lib/usage");
    const r = usageReport(NOW);
    expect(r.totals).toEqual({ saves: 1, searches: 1, reactions: 0, helpedSearches: 0, people: 2 });
    expect(activityTotals(r.activity)).toEqual(r.totals);
  });
});

/* ------------------------------------------------------------------- growth */

describe("growth", () => {
  it("adds up live memories by the week they were saved, from the first week to now", async () => {
    await people(A);
    await memory(A, { createdAt: "2026-08-20 10:00:00" });
    await memory(A, { createdAt: "2026-09-15 10:00:00" });
    await memory(A, { createdAt: "2026-09-29 10:00:00" });
    await memory(A, { createdAt: "2026-10-06 09:00:00" });
    await memory(A, { createdAt: "2026-09-22 10:00:00", status: "archived" }); // not live
    await memory(A, { createdAt: "2026-09-22 10:00:00", status: "deleted" }); // not live
    const { growth } = await import("../lib/usage");
    const g = growth(NOW);
    expect(g.points.map((p) => p.week)).toEqual([
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
    ]);
    expect(g.points.map((p) => p.total)).toEqual([1, 1, 1, 1, 2, 2, 3, 4]);
    expect(g.live).toBe(4);
    expect(g.lastMonth).toBe(3); // since 6 Sep, 12:00
  });

  it("is a single point when every memory is from this week", async () => {
    await people(A);
    await memory(A, { createdAt: "2026-10-06 08:00:00" });
    const { growth } = await import("../lib/usage");
    expect(growth(NOW)).toEqual({ points: [{ week: "2026-10-05", total: 1 }], live: 1, lastMonth: 1 });
  });
});

/* ------------------------------------------------------------ what's in BAB */

describe("what is in BAB", () => {
  it("counts live memories by kind and team tag, with untagged and unreadable tags as no team", async () => {
    await people(A);
    await memory(A, { kind: "standard", tags: ["engineering", "kafka"] });
    await memory(A, { kind: "practice", tags: ["Engineering", "sales"] });
    await memory(A, { tags: ["misc"] });
    const broken = await memory(A, { tags: ["legal"] });
    await memory(A, { kind: "decision", tags: ["legal"], status: "archived" }); // not live
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET tags = 'not json' WHERE id = ?").run(broken);
    const { contents } = await import("../lib/usage");
    const c = contents();
    expect(c.byKind).toEqual([
      { key: "learning", n: 2 },
      { key: "practice", n: 1 },
      { key: "standard", n: 1 },
      { key: "decision", n: 0 },
    ]);
    expect(c.byTeam).toEqual([
      { key: "engineering", n: 2 },
      { key: "sales", n: 1 },
    ]);
    expect(c.noTeamTag).toBe(2);
  });

  it("groups by the configured teams, including a slug with a hyphen", async () => {
    process.env.BAB_TEAM_TAGS = "engineering,expert-services";
    try {
      await people(A);
      await memory(A, { tags: ["expert-services", "kafka"] });
      await memory(A, { tags: ["Engineering"] });
      await memory(A, { tags: ["sales"] }); // not a configured team here
      const { contents } = await import("../lib/usage");
      const c = contents();
      expect(c.byTeam).toEqual([
        { key: "engineering", n: 1 },
        { key: "expert-services", n: 1 },
      ]);
      expect(c.noTeamTag).toBe(1);
    } finally {
      delete process.env.BAB_TEAM_TAGS;
    }
  });

  it("sorts live memories into strong, fair and weak standing from their votes", async () => {
    const C = "cy.c@example.com";
    await people(A, B, MAINT, C);
    const strong = await memory(A);
    const fair = await memory(A);
    await memory(A);
    for (const voter of [B, MAINT, C]) await vote(strong, voter, "confirm"); // 6 points
    await vote(fair, B, "kudos"); // 2 points
    const { contents } = await import("../lib/usage");
    const c = contents();
    expect(c.standing).toEqual({ strong: 1, fair: 1, weak: 1 });
    expect(c.standingRead).toBe(3);
  });
});

/* ------------------------------------------------------------- most helpful */

describe("most helpful in the last 12 months", () => {
  it("ranks memories by helpful, kudos and confirm in the last 12 months, without deleted ones", async () => {
    await people(A);
    const top = await memory(A, { title: "Kafka retries need idempotent consumers" });
    const second = await memory(A, { title: "Board deck cut-off is Thursday" });
    const old = await memory(A);
    const gone = await memory(A, { status: "deleted" });
    const at = (d: string) => `${d} 10:00:00`;
    for (const action of ["helpful", "helpful", "kudos", "confirm"]) await row(B, action, at("2026-10-01"), { entity: "learning", entityId: top });
    await row(B, "not_helpful", at("2026-10-01"), { entity: "learning", entityId: top });
    for (const action of ["helpful", "confirm"]) await row(B, action, at("2026-09-20"), { entity: "learning", entityId: second });
    // NOW is 2026-10-06 12:00 and the window is WINDOW_DAYS (364) days: it starts 2025-10-07 12:00.
    await row(B, "helpful", "2025-10-07 12:30:00", { entity: "learning", entityId: second }); // just inside
    for (let i = 0; i < 6; i++) await row(B, "helpful", "2025-10-07 11:30:00", { entity: "learning", entityId: old }); // just outside
    for (let i = 0; i < 6; i++) await row(B, "helpful", at("2026-10-02"), { entity: "learning", entityId: gone });
    const { topHelpful } = await import("../lib/usage");
    expect(topHelpful(NOW)).toEqual([
      { id: top, title: "Kafka retries need idempotent consumers", kind: "learning", helpful: 2, kudos: 1, confirm: 1, total: 4 },
      { id: second, title: "Board deck cut-off is Thursday", kind: "learning", helpful: 2, kudos: 0, confirm: 1, total: 3 },
    ]);
  });

  it("returns at most five", async () => {
    await people(A);
    for (let i = 0; i < 7; i++) {
      const id = await memory(A);
      await row(B, "helpful", "2026-10-05 10:00:00", { entity: "learning", entityId: id });
    }
    const { topHelpful } = await import("../lib/usage");
    expect(topHelpful(NOW)).toHaveLength(5);
  });
});

/* ------------------------------------------------------------------- models */

describe("models", () => {
  it("counts memories saved since 6 Oct by model, not stated last, old and deleted ones left out", async () => {
    await people(A);
    await memory(A, { model: "claude-opus-5-5", createdAt: "2026-10-06 09:00:00" });
    await memory(A, { model: "claude-opus-5-5", createdAt: "2026-10-07 09:00:00" });
    await memory(A, { model: "claude-sonnet-5", createdAt: "2026-10-06 09:00:00", status: "archived" });
    await memory(A, { createdAt: "2026-10-06 10:00:00" });
    await memory(A, { model: "claude-fable-5-1", createdAt: "2026-10-05 23:00:00" }); // before
    await memory(A, { model: "claude-haiku-5", createdAt: "2026-10-06 09:00:00", status: "deleted" });
    const { modelsUsed } = await import("../lib/usage");
    expect(modelsUsed()).toEqual([
      { key: "claude-opus-5-5", n: 2 },
      { key: "claude-sonnet-5", n: 1 },
      { key: "", n: 1 },
    ]);
  });

  it("folds models past the sixth into other", async () => {
    await people(A);
    for (let i = 1; i <= 8; i++) await memory(A, { model: `model-${i}`, createdAt: "2026-10-06 09:00:00" });
    const { modelsUsed, MODELS_SHOWN } = await import("../lib/usage");
    const m = modelsUsed();
    expect(m).toHaveLength(MODELS_SHOWN + 1);
    expect(m.at(-1)).toEqual({ key: "other", n: 2 });
  });
});

/* ------------------------------------------------------------------- upkeep */

// The quiet and archived-unread numbers are checked with their sweep in tests/agent-reads.test.ts;
// these pin the windows and the day reads began, and the keeps, restores and retires.
describe("upkeep", () => {
  it("counts the keeps, restores and retires of the last 12 months", async () => {
    await people(A);
    await memory(A); // saved just now: not quiet
    await row(A, "keep", "2026-10-03 10:00:00", { entity: "learning" });
    await row(A, "keep", "2026-10-01 10:00:00", { entity: "learning" });
    await row(A, "keep", "2026-09-30 10:00:00", { entity: "learning" });
    await row(A, "keep", "2025-10-07 12:30:00", { entity: "learning" }); // just inside the window (WINDOW_DAYS)
    await row(A, "keep", "2025-10-07 11:30:00", { entity: "learning" }); // just outside
    await row(A, "restored", "2026-10-02 10:00:00", { entity: "learning" });
    await row(A, "retire", "2026-09-20 10:00:00", { entity: "learning" });
    await row(A, "retire", "2026-09-10 10:00:00", { entity: "learning" });
    await row(A, "retire", "2026-08-20 10:00:00", { entity: "learning" }); // 6 weeks ago: inside now
    await row(A, "retire", "2025-10-07 11:30:00", { entity: "learning" }); // just outside
    const { upkeep } = await import("../lib/usage");
    expect(upkeep(NOW)).toEqual({ quiet: 0, archivedUnread: 0, kept: 4, restored: 1, retired: 3, comments: 0 });
  });

  it("counts a live learning or practice as quiet 270 days after its last agent read, else its save day, never from before reads began", async () => {
    await people(A);
    const { QUIET_DAYS } = await import("../lib/usage");
    const { INACTIVITY_CLOCK_START } = await import("../lib/learnings");
    expect(QUIET_DAYS).toBe(270);
    expect(INACTIVITY_CLOCK_START).toBe("2026-10-07");
    // Saved before reads were recorded: its clock starts on 2026-10-07, not on the day it was saved.
    await memory(A, { createdAt: "2026-01-15 09:00:00" });
    // Saved after, never read: the clock is the day it was saved.
    await memory(A, { kind: "practice", createdAt: "2026-11-01 09:00:00" });
    // Read since: the clock is that read.
    const read = await memory(A, { createdAt: "2026-11-01 09:00:00" });
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET last_accessed_at = '2027-06-01 09:00:00' WHERE id = ?").run(read);
    await memory(A, { createdAt: "2026-11-01 09:00:00", status: "archived" }); // not live
    const { upkeep } = await import("../lib/usage");
    const quietAt = (iso: string) => upkeep(new Date(iso)).quiet;
    expect(quietAt("2027-07-03T12:00:00Z")).toBe(0); // under 270 days after 2026-10-07
    expect(quietAt("2027-07-05T12:00:00Z")).toBe(1); // over 270 days: the memory saved before reads began
    expect(quietAt("2027-07-28T12:00:00Z")).toBe(1); // the practice, saved on 1 November, is under 270 days
    expect(quietAt("2027-07-30T12:00:00Z")).toBe(2); // and over it two days later
    expect(quietAt("2028-03-01T12:00:00Z")).toBe(3); // the read memory, 274 days after its last read
  });

  it("counts the memories the sweep archived unread in the last 12 months, not those archived for their date, by flags or long ago", async () => {
    const gone = (at: string, reason: string) => row("system", "auto-archive", at, { entity: "learning", details: { reason } });
    await gone("2026-10-01 10:00:00", "inactive");
    await gone("2026-09-10 10:00:00", "inactive");
    await gone("2026-08-01 10:00:00", "inactive"); // 9 weeks ago: inside now
    await gone("2025-10-07 12:30:00", "inactive"); // just inside the window (WINDOW_DAYS)
    await gone("2025-10-07 11:30:00", "inactive"); // just outside
    await gone("2026-10-02 10:00:00", "valid-until"); // its author's own date
    await row(A, "auto_archive", "2026-10-02 10:00:00", { entity: "learning" }); // two flags, a different action
    const { upkeep } = await import("../lib/usage");
    expect(upkeep(NOW).archivedUnread).toBe(4);
  });
});

/* ------------------------------------------------------- messages, reminders */

describe("messages and reminders per week", () => {
  it("counts messages, conversations and senders in the week they were sent", async () => {
    await people(A, B, MAINT);
    const { send } = await import("../lib/messages");
    const first = send({ fromId: A, to: B, subject: "Hello", body: "One." }, "mcp");
    send({ fromId: B, threadId: first.thread.id, body: "Two." }, "mcp");
    send({ fromId: A, to: MAINT, subject: "Other", body: "Three." }, "mcp");
    // An older send, a week earlier: its own week, and no message row left for its thread.
    const { lastWeeks, messagesByWeek, weekStart } = await import("../lib/usage");
    const weeks = lastWeeks(new Date());
    const earlier = new Date(`${weeks[50]}T10:00:00Z`).toISOString().slice(0, 19).replace("T", " ");
    await row(A, "send", earlier, { entity: "message", entityId: "gone" });
    const byWeek = messagesByWeek(weeks);
    const now = byWeek.find((w) => w.week === weekStart(new Date()))!;
    expect(now).toMatchObject({ messages: 3, conversations: 2, senders: 2 });
    expect(byWeek[50]).toMatchObject({ messages: 1, conversations: 0, senders: 1 });
    expect(byWeek.slice(0, 50).every((w) => w.messages === 0)).toBe(true);
  });

  it("counts reminders set, done, snoozed and dropped, and nothing from other entities", async () => {
    await people(A);
    const todos = await import("../lib/todos");
    const a = todos.create({ ownerId: A, title: "One" }, "mcp");
    const b = todos.create({ ownerId: A, title: "Two", dueAt: "2030-01-01" }, "mcp");
    const c = todos.create({ ownerId: A, title: "Three" }, "mcp");
    todos.complete(a.id, A, "mcp");
    todos.snooze(b.id, A, "mcp", "2030-02-01");
    todos.abandon(c.id, A, "mcp");
    await memory(A, {}); // a learning `create` is not a reminder
    const { lastWeeks, remindersByWeek } = await import("../lib/usage");
    const byWeek = remindersByWeek(lastWeeks(new Date()));
    expect(byWeek[51]).toMatchObject({ created: 3, done: 1, snoozed: 1, dropped: 1 });
  });

  it("counts memories used, messages and conversations per person", async () => {
    await people(A, B, MAINT);
    const others = await memory(B, {});
    const another = await memory(MAINT, {});
    const own = await memory(A, {});
    await vote(others, A, "helpful");
    await vote(others, A, "kudos"); // the same memory counts once
    await vote(another, A, "kudos");
    await vote(own, A, "helpful"); // the author's own memory is not use
    await vote(another, B, "not_helpful"); // not use
    const { send } = await import("../lib/messages");
    const t = send({ fromId: A, to: B, subject: "Hi", body: "One." }, "mcp");
    send({ fromId: B, threadId: t.thread.id, body: "Two." }, "mcp");
    send({ fromId: MAINT, to: A, subject: "Other", body: "Three." }, "mcp");
    const { activityCountsForUsers } = await import("../lib/users");
    const c = activityCountsForUsers([A, B, "nobody@example.com"]);
    expect(c[A]).toEqual({ used: 2, sent: 1, received: 2, conversations: 2 });
    expect(c[B]).toEqual({ used: 0, sent: 1, received: 1, conversations: 1 });
    expect(c["nobody@example.com"]).toEqual({ used: 0, sent: 0, received: 0, conversations: 0 });
    expect(activityCountsForUsers([])).toEqual({});
  });
});

/* -------------------------------------------------------------------- cache */

describe("the 5-minute cache", () => {
  it("serves one report for 5 minutes, then computes a fresh one", async () => {
    const { cachedUsageReport, USAGE_CACHE_MS } = await import("../lib/usage");
    const first = cachedUsageReport(NOW);
    await row(A, "create", "2026-10-06 08:00:00", { entity: "learning" });
    const later = new Date(NOW.getTime() + USAGE_CACHE_MS - 1000);
    expect(cachedUsageReport(later)).toBe(first);
    expect(first.activity.at(-1)!.saves).toBe(0);
    const fresh = cachedUsageReport(new Date(NOW.getTime() + USAGE_CACHE_MS));
    expect(fresh).not.toBe(first);
    expect(fresh.activity.at(-1)!.saves).toBe(1);
  });

  it("never serves a report read from another database connection", async () => {
    const { cachedUsageReport } = await import("../lib/usage");
    const first = cachedUsageReport(NOW);
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    expect(cachedUsageReport(NOW)).not.toBe(first);
  });
});

/* --------------------------------------------------------------------- page */

describe("/usage page", () => {
  /** The page without its Users directory, which lists every address on purpose (it was /people, open to all). */
  const withoutUsers = (html: string) => html.replace(/<section id="users".*?<\/section>/s, "");

  async function render(email: string | null, users?: string) {
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    // Seeding above may already have cached config() with trust off.
    (await import("../lib/config"))._resetConfigForTests();
    vi.doMock("next/headers", () => ({
      headers: async () =>
        new Headers(email ? { "x-auth-request-user": "f1", "x-auth-request-email": email, "x-auth-request-preferred-username": "Viewer" } : {}),
    }));
    vi.doMock("next/navigation", () => ({
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
    }));
    vi.doMock("@/app/components/shell/Shell", () => ({ default: ({ children }: { children: unknown }) => children }));
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: MAINT, email: MAINT, name: "Mia", roles: [] });
    const Page = (await import("../app/usage/page")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ users }) }));
  }

  // The page uses the real clock and audit rows get SQL's datetime('now'), so these seed relative to now.
  async function weekOf(offsetWeeks = 0) {
    const { weekStart } = await import("../lib/usage");
    const monday = new Date(`${weekStart(new Date())}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() + 7 * offsetWeeks);
    const day = monday.toISOString().slice(0, 10);
    const short = monday.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    return { day, short, at: (sec: number) => `${day} 00:00:${String(sec).padStart(2, "0")}` };
  }

  async function seedLoopAndFlag() {
    await people(A, B);
    const cur = await weekOf(0);
    for (const sec of [40, 41, 42, 43]) {
      await row(A, "identify", cur.at(sec), { entity: "user", details: { source: "none", cx: "c:loop" } });
    }
    const { create, flag } = await import("../lib/learnings");
    const s = create({ authorId: A, title: "Standard open zq9", body: "Body zq9x.", kind: "standard", confirmNotDuplicate: true });
    flag(s.id, B, "mcp", "Moved to src/z.ts, 2026-10-01");
    return s;
  }

  it("shows a non-maintainer the counts and flag titles, without the personal rows", async () => {
    const s = await seedLoopAndFlag();
    const html = await render(B);
    expect(html).toContain("Identify problems");
    expect(html).toContain("Only maintainers see who is looping.");
    expect(html).toContain(`href="/memory/${s.id}"`);
    expect(html).toContain("Standard open zq9");
    expect(withoutUsers(html)).not.toContain(A);
    expect(html).not.toContain("<th>Identified as</th>");
    expect(html).not.toContain("<th>Author</th>");
    expect(html).not.toContain("/memory?author=");
    expect(html).not.toContain('href="/admin"');
  });

  it("treats an anonymous viewer like a non-maintainer, as /memory does", async () => {
    await seedLoopAndFlag();
    const html = await render(null);
    expect(html).toMatch(/data-testid="tile-flags"[^>]*>1</);
    expect(html).toContain("Only maintainers see who is looping.");
    expect(withoutUsers(html)).not.toContain(A);
    expect(html).not.toContain("<th>Identified as</th>");
  });

  it("shows a maintainer the loop rows and the flag authors", async () => {
    await seedLoopAndFlag();
    const html = await render(MAINT);
    expect(html).toContain("<th>Identified as</th>");
    expect(html).toContain("<th>Author</th>");
    expect(html).toContain(`href="/memory?author=${encodeURIComponent(A)}"`);
    expect(html).toContain('href="/admin"');
    expect(html).not.toContain("Only maintainers see who is looping.");
  });

  it("lists users 10 per page with Previous and Next, and clamps a bad page", async () => {
    const { upsertUser } = await import("../lib/users");
    for (let i = 0; i < 12; i++) upsertUser({ id: `pg${i}@example.com`, email: `pg${i}@example.com`, name: `Pager ${i}`, roles: [] });
    const first = await render(MAINT);
    expect(first).toContain('id="users"');
    expect(first).toContain("Page 1 of 2");
    expect(first).toContain('href="/usage?users=2#users"');
    const rows = (html: string) => (html.match(/<section id="users".*?<\/section>/s)?.[0].match(/<tr>/g) ?? []).length - 1;
    expect(rows(first)).toBe(10);
    const second = await render(MAINT, "2");
    expect(second).toContain("Page 2 of 2");
    expect(rows(second)).toBeGreaterThan(0);
    expect(rows(second)).toBeLessThanOrEqual(10);
    expect(second).toContain('href="/usage?users=1#users"');
    expect(await render(MAINT, "99")).toContain("Page 2 of 2");
    expect(await render(MAINT, "abc")).toContain("Page 1 of 2");
  });

  async function seedMessageAndReminder() {
    await people(A, B);
    const { send } = await import("../lib/messages");
    send({ fromId: A, to: B, subject: "Private subject qx7", body: "Private body qx7." }, "mcp");
    const todos = await import("../lib/todos");
    todos.create({ ownerId: A, title: "Secret reminder qx7" }, "mcp");
  }
  const usersOf = (html: string) => html.match(/<section id="users".*?<\/section>/s)?.[0] ?? "";

  it("shows everyone message and reminder totals, but no per-person message counts and no text", async () => {
    await seedMessageAndReminder();
    const html = await render(B);
    expect(html).toContain("Messages and reminders");
    expect(html).toMatch(/data-testid="messages-total"[^>]*>1 message in 12 months</);
    expect(html).toContain("Reminders set, done, snoozed and dropped per week");
    expect(html).not.toContain("qx7");
    expect(usersOf(html)).toContain(">Used<");
    expect(usersOf(html)).not.toContain(">Conversations<");
    expect(usersOf(html)).not.toContain(" sent, ");
  });

  it("shows a maintainer per-person message and conversation counts, still without text", async () => {
    await seedMessageAndReminder();
    const html = await render(MAINT);
    expect(usersOf(html)).toContain(">Conversations<");
    expect(usersOf(html)).toContain('title="1 sent, 0 received"');
    expect(html).not.toContain("qx7");
  });

  it("says so when there are no messages or reminders yet", async () => {
    const html = await render(B);
    expect(html).toContain("No messages yet.");
    expect(html).toContain("No reminders yet.");
  });

  it("redirects /people to the Users section of /usage", async () => {
    const config = (await import("../next.config")).default;
    const redirects = await config.redirects!();
    expect(redirects).toContainEqual({ source: "/people", destination: "/usage#users", permanent: false });
  });

  it("redirects /admin/usage to /usage with a 307", async () => {
    const config = (await import("../next.config")).default;
    const redirects = await config.redirects!();
    expect(redirects).toContainEqual({ source: "/admin/usage", destination: "/usage", permanent: false });
  });

  it("is honest when there is no data: short notes, no charts of zeros, no NaN", async () => {
    const html = await render(MAINT);
    const cur = await weekOf(0);
    expect(html).toContain("No nudges yet");
    expect(html).toContain("since 6 Oct");
    expect(html).toContain("No saves, searches or reactions yet.");
    expect(html).toContain("No memories yet.");
    expect(html).toContain("No memories saved in these weeks.");
    expect(html).toContain("No helpful reactions in the last 12 months.");
    // The page view itself is the only audit row, so every earlier week collapses into one note.
    expect(html).toContain(`No data before ${cur.short}`);
    expect(html).not.toMatch(/NaN|Infinity/);
    expect(html).not.toContain('viewBox="0 0 560'); // no chart of zeros
    expect(html).toMatch(/data-testid="tile-flags"[^>]*>0</);
    expect(html).toMatch(/data-testid="tile-saved"[^>]*>0</);
    expect(html).toContain("none yet this week");
    expect(html).not.toContain("vs last week");
    expect(html).not.toContain("this month</span>"); // no "+0 this month
    expect(html).toMatch(/Updated \d{1,2} [A-Z][a-z]{2,3}, \d{2}:\d{2} UTC/);
  });

  it("shows one week of data without a trend line yet", async () => {
    await people(A);
    await memory(A);
    const html = await render(MAINT);
    expect(html).toContain("A trend shows from the second week.");
    expect(html).toMatch(/data-testid="growth-live"[^>]*>1</);
    expect(html).toContain('viewBox="0 0 560 230"'); // the activity bars, one week
  });

  it("shows the Upkeep tiles: quiet, archived unread, kept, restored and retired, and no Expiring soon", async () => {
    // A memory is quiet 270 days after 2026-10-07 at the earliest, so the page needs a clock past that.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-08-01T12:00:00Z"));
    try {
      await people(A);
      await memory(A, { createdAt: "2026-11-01 09:00:00" });
      await memory(A, { kind: "practice", createdAt: "2026-11-02 09:00:00" });
      await memory(A, { createdAt: "2027-07-20 09:00:00" }); // saved lately: not quiet
      // A different number for each tile, so a tile fed from the wrong field shows.
      for (const day of [20, 21, 22]) await row(A, "keep", `2027-07-${day} 10:00:00`, { entity: "learning" });
      for (const day of [20, 21, 22, 23]) await row(A, "restored", `2027-07-${day} 11:00:00`, { entity: "learning" });
      for (const day of [20, 21, 22, 23, 24]) await row(A, "retire", `2027-07-${day} 12:00:00`, { entity: "learning" });
      await row("system", "auto-archive", "2027-07-22 10:00:00", { entity: "learning", details: { reason: "inactive" } });
      const html = await render(MAINT);
      expect(html).toContain("Quiet 9+ months");
      expect(html).toMatch(/data-testid="upkeep-quiet"[^>]*>2</);
      expect(html).toMatch(/data-testid="upkeep-archived-unread"[^>]*>1</);
      expect(html).toMatch(/data-testid="upkeep-kept"[^>]*>3</);
      expect(html).toMatch(/data-testid="upkeep-restored"[^>]*>4</);
      expect(html).toMatch(/data-testid="upkeep-retired"[^>]*>5</);
      expect(html).not.toContain("Expiring soon");
      expect(html).not.toContain("upkeep-expiring");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fills the page: tiles with totals and this week's growth, charts, top memories, upkeep and health", async () => {
    const cur = await weekOf(0);
    const prev = await weekOf(-1);
    await people(A, B);
    // An older audit row with no activity: those quiet weeks still collapse.
    await row(A, "GET", (await weekOf(-4)).at(1), { path: "/memory" });
    await row(A, "create", prev.at(1), { entity: "learning" });
    for (const sec of [1, 2, 3]) await row(A, "create", cur.at(sec), { entity: "learning" });
    for (const sec of [4, 5]) await row(B, "POST", cur.at(sec), { path: "/mcp#tools/call:bab_search" });
    await learnCall(A, cur.at(1), "c:1");
    await learnCall(B, cur.at(2), "c:2");
    await row(A, "stop_nudge", cur.at(10), { entity: "session" });
    await learnCall(A, cur.at(20), "c:1");
    await row(B, "stop_nudge", cur.at(30), { entity: "session" });
    await row("anonymous", "identify_refused", cur.at(5), { entity: "user", details: { reason: "wrong-form" } });
    for (const sec of [40, 41, 42, 43]) {
      await row(A, "identify", cur.at(sec), { entity: "user", details: { source: "none", cx: "c:loop" } });
    }
    const older = await memory(A, { title: "Older memory with a growth week", createdAt: `${prev.day} 09:00:00`, tags: ["engineering"] });
    await row(B, "helpful", cur.at(6), { entity: "learning", entityId: older });
    await row(B, "kudos", cur.at(7), { entity: "learning", entityId: older });
    const { create, flag } = await import("../lib/learnings");
    const s = create({ authorId: A, title: "Standard tile zq8", body: "Body zq8x.", kind: "standard", confirmNotDuplicate: true });
    flag(s.id, B, "mcp", "Moved to src/y.ts, 2026-10-01");
    const html = await render(MAINT);
    // 1 save last week and 3 seeded this week, plus the create rows of the older memory and the standard (both written now).
    expect(html).toMatch(/data-testid="tile-saved"[^>]*>6</);
    expect(html).toMatch(/data-testid="tile-searches"[^>]*>2</);
    expect(html).toMatch(/data-testid="tile-helpful"[^>]*>2</);
    expect(html).toContain("+5 this week"); // 5 of the 6 saves are this week
    expect(html).not.toMatch(/▼|vs last week/);
    expect(html).toMatch(/data-testid="tile-conversion"[^>]*>50%</);
    expect(html).toContain("1 of 2 nudges");
    expect(html).toMatch(/data-testid="tile-identify"[^>]*>2</);
    expect(html).toContain("1 loop, 1 refused");
    expect(html).toMatch(/data-testid="tile-flags"[^>]*>1</);
    expect(html).toContain('href="#health"');
    expect(html).toContain(`No data before ${prev.short}`);
    expect(html).toMatch(/data-testid="growth-live"[^>]*>2</);
    expect(html).toContain('viewBox="0 0 560 220"'); // the growth line
    expect(html).toMatch(new RegExp(`data-testid="top-helpful".*href="/memory/${older}"`));
    expect(html).toContain(`href="/memory?author=${encodeURIComponent(A)}"`);
    expect(html).not.toMatch(/NaN|Infinity/);
    // Plain words: tool names only in the Health card.
    const beforeHealth = html.slice(0, html.indexOf('id="health"'));
    expect(beforeHealth).not.toMatch(/bab_[a-z]+/);
  });

  it("shows the tiles as 12-month totals with this week's growth, and the people tile as distinct people", async () => {
    await people(A, B);
    const cur = await weekOf(0);
    const prev = await weekOf(-1);
    const old = await weekOf(-30);
    // Saves: 2 thirty weeks ago, 1 last week, 1 this week. Searches: only this week.
    for (const sec of [1, 2]) await row(A, "create", old.at(sec), { entity: "learning" });
    await row(A, "create", prev.at(1), { entity: "learning" });
    await row(A, "create", cur.at(1), { entity: "learning" });
    await row(A, "POST", cur.at(2), { path: "/mcp#tools/call:bab_search" });
    // A is active in two weeks, B only now, and the viewer's own page view counts too: 3 people, new this week 2 (B and the viewer).
    await row(A, "GET", prev.at(5), { path: "/memory" });
    await row(B, "GET", cur.at(5), { path: "/memory" });
    const html = await render(B);
    expect(html).toMatch(/data-testid="tile-saved"[^>]*>4</);
    expect(html).toMatch(/data-testid="tile-searches"[^>]*>1</);
    expect(html).toMatch(/data-testid="tile-helpful"[^>]*>0</);
    expect(html).toMatch(/data-testid="people-total"[^>]*>3 people in 12 months</);
    // Only audit rows are seeded here, no memories, so none are still in BAB.
    expect(html).toMatch(/data-testid="tile-saved-note"[^>]*>0 still in BAB</);
    expect(html).toMatch(/data-testid="tile-search-helped"[^>]*>0%</);
    expect(html).toMatch(/data-testid="tile-helped-note"[^>]*>0 of 1, last 12 months</);
    const tiles = html.slice(html.indexOf('data-testid="usage-tiles"'), html.indexOf("Memories in BAB"));
    expect(tiles).toContain("+1 this week"); // saves and searches both grew by 1
    expect(tiles).toContain("none yet this week"); // no helpful reactions
    expect(tiles).toContain("over the last 12 months");
    expect(html).toContain("over the last 12 months.");
    expect(html).not.toContain("week by week");
    // The sparklines are running totals: they only go up.
    for (const m of tiles.matchAll(/running total: ([^"]+)"/g)) {
      const values = m[1].split(", ").map((p) => Number(p.split(" ").at(-1)));
      expect(values).toEqual([...values].sort((x, y) => x - y));
    }
  });

  it("counts only people not seen before this week as new this week", async () => {
    await people(A, B);
    const cur = await weekOf(0);
    const prev = await weekOf(-1);
    await row(A, "GET", prev.at(1), { path: "/memory" });
    await row(B, "GET", prev.at(2), { path: "/memory" });
    const html = await render(A);
    const tiles = html.slice(html.indexOf('data-testid="usage-tiles"'), html.indexOf("Memories in BAB"));
    // A and B were seen last week; only the viewer is new.
    expect(html).toMatch(/data-testid="people-total"[^>]*>3 people in 12 months</);
    expect(tiles).toMatch(/data-testid="tile-active-week-note"[^>]*>\d+ returning, 1 new</);
    // People using BAB is no longer a hero tile: it is cumulative, so it sits on the weekly people card.
    expect(tiles).not.toContain("tile-people");
  });

  it("shows a compact Clean-up card: six rows of small weekly bars, with the totals", async () => {
    await people(A, B);
    const cur = await weekOf(0);
    const prev = await weekOf(-1);
    const act = (action: string, at: string, details?: unknown) =>
      row("system", action, at, { entity: "learning", entityId: `l-${action}`, details });
    await act("auto-archive", cur.at(1), { reason: "inactive" });
    await act("auto-archive", prev.at(1), { reason: "inactive" });
    await act("auto-archive", prev.at(2), { reason: "inactive" });
    // A valid-until archive is not "unread": it is not on this card.
    await act("auto-archive", cur.at(3), { reason: "valid-until" });
    await act("downvote_archived", cur.at(4), { notHelpful: 3, support: 0 });
    await act("downvote_archived", prev.at(4), { notHelpful: 4, support: 1 });
    await act("auto_archive", cur.at(5));
    await act("retire", cur.at(6));
    await act("keep", cur.at(7));
    await act("restored", cur.at(8));
    await act("confirm", cur.at(9), { verified: true });
    await act("confirm", cur.at(10));
    const html = await render(B);
    const card = html.slice(html.indexOf('aria-label="Clean-up"'), html.indexOf('id="users"'));
    expect(card).toContain("Last 12 months");
    for (const label of ["Archived unread", "Archived, not helpful", "Archived by flags", "Retired", "Restored or kept", "Old memories verified"]) {
      expect(card).toContain(label);
    }
    expect(card).not.toMatch(/expir/i);
    expect((card.match(/<li class="[^"]*cleanRow/g) ?? []).length).toBe(6);
    // The total of each row sits at its end: 3 unread, 2 not helpful, 1 flagged, 1 retired, 2 kept, 1 verified.
    const totals = [...card.matchAll(/class="[^"]*cleanValue[^"]*">(\d+)</g)].map((m) => Number(m[1]));
    expect(totals).toEqual([3, 2, 1, 1, 2, 1]);
    expect(card).toContain("Week of");
  });

  it("says so when nothing was cleaned up", async () => {
    await people(A, B);
    expect(await render(B)).toContain("No clean-up in these weeks.");
  });
  describe("searches that found nothing", () => {
    const SEARCH = "/mcp#tools/call:bab_search";
    // After SEARCH_RESULTS_SINCE, so the recorded counts fall inside the window.
    const LATER = new Date("2026-11-03T12:00:00Z");

    async function mcpSearch(args: Record<string, unknown>) {
      vi.doMock("next/headers", () => ({
        headers: async () => new Headers({ "x-bab-actor-email": A, "x-bab-actor-name": "Ann A" }),
      }));
      const { POST } = await import("../app/mcp/route");
      const res = await POST(
        new Request("https://bab.example.com/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", host: "bab.example.com" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bab_search", arguments: args } }),
        }),
      );
      return res.json();
    }

    it("bab_search writes the result count on its own audit row, and the redacted query (cut to 120 characters) only when it found nothing", async () => {
      await people(A, B);
      await memory(B, { title: "Kafka consumer lag fix for the acme cluster" });
      await mcpSearch({ query: "kafka consumer lag" });
      const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
      await mcpSearch({ query: `nothing matches qqzzyy ${secret} ${"x".repeat(200)}` });
      await mcpSearch({ query: "kafka consumer lag", offset: 5 }); // a later page: not recorded
      await mcpSearch({ query: "", houseRules: true }); // the digest: not a search
      await mcpSearch({ query: "", kind: "standard" }); // a listing with no text: not recorded
      const { getDb } = await import("../lib/db");
      const rows = getDb().prepare("SELECT details FROM audit_log WHERE path = ? ORDER BY id").all(SEARCH) as Array<{ details: string | null }>;
      expect(rows).toHaveLength(5);
      const found = JSON.parse(rows[0].details!);
      expect(found.results).toBeGreaterThan(0);
      expect(found.q).toBeUndefined(); // the text is kept only when nothing was found
      const empty = JSON.parse(rows[1].details!);
      expect(empty.results).toBe(0);
      expect(empty.q.length).toBeLessThanOrEqual(120);
      expect(empty.q).toContain("nothing matches qqzzyy");
      expect(empty.q).toContain("[redacted]");
      expect(rows[1].details).not.toContain(secret);
      // The identity source on every row stays; the later page and the digest get no count.
      expect(found.source).toBe("declared");
      expect(JSON.parse(rows[2].details!)).toEqual({ source: "declared" });
      expect(JSON.parse(rows[3].details!)).toEqual({ source: "declared" });
      expect(JSON.parse(rows[4].details!)).toEqual({ source: "declared" });
    });

    it("GET /api/learnings with a query records its result count, and keeps the identity source", async () => {
      await people(A);
      vi.doMock("next/headers", () => ({
        headers: async () => new Headers({ "x-bab-actor-email": A, "x-bab-actor-name": "Ann A" }),
        cookies: async () => ({ get: () => undefined }),
      }));
      const { GET } = await import("../app/api/learnings/route");
      const { NextRequest } = await import("next/server");
      await GET(new NextRequest("http://x/api/learnings?q=Unfindable%20Thing%20zz9"));
      const { getDb } = await import("../lib/db");
      const r = getDb().prepare("SELECT details FROM audit_log WHERE path = '/api/learnings'").get() as { details: string };
      const d = JSON.parse(r.details);
      expect(d).toMatchObject({ results: 0, q: "Unfindable Thing zz9" });
      expect(d.source).toBeDefined();
    });

    it("reports the share since recording began and groups zero-result queries case-insensitively", async () => {
      await row(A, "POST", "2026-11-02 09:00:00", { path: SEARCH }); // no count: left out
      await row(A, "POST", "2026-11-02 09:01:00", { path: SEARCH, details: { results: 3, q: "deploy" } });
      await row(A, "POST", "2026-11-02 09:02:00", { path: SEARCH, details: { results: 0, q: "Vault Path" } });
      await row(B, "GET", "2026-11-03 09:03:00", { path: "/api/learnings", details: { results: 0, q: "vault path" } });
      await row(B, "POST", "2026-11-03 09:04:00", { path: SEARCH, details: { results: 0, q: "argo sync" } });
      await row(B, "POST", "2026-11-03 09:05:00", { path: SEARCH, details: { results: 0 } }); // a listing, no text
      await row(B, "POST", "2026-11-03 09:06:00", { path: "/api/learnings", details: { results: 0, q: "a save" } }); // not a search
      const { usageReport } = await import("../lib/usage");
      const s = usageReport(LATER).searchOutcomes;
      expect(s).toMatchObject({ since: "2026-11-02", recorded: 5, zero: 4 });
      expect(s.zeroQueries.map((q) => [q.query, q.n])).toEqual([
        ["vault path", 2],
        ["argo sync", 1],
      ]);
    });

    it("shows the share to everyone and the queries to maintainers only", async () => {
      await people(A, B);
      const { getDb } = await import("../lib/db");
      const now = getDb().prepare("SELECT datetime('now') AS t").get() as { t: string };
      await row(A, "POST", now.t, { path: SEARCH, details: { results: 0, q: "secret project qqvv" } });
      await row(A, "POST", now.t, { path: SEARCH, details: { results: 2, q: "deploy" } });
      const asMember = await render(B);
      expect(asMember).toMatch(/data-testid="tile-found-nothing"[^>]*>50%</);
      expect(asMember).not.toContain("qqvv");
      expect(asMember).not.toContain("Searches that found nothing");
      (await import("../lib/db"))._resetDbForTests();
      vi.resetModules();
      const asMaint = await render(MAINT);
      expect(asMaint).toContain("Searches that found nothing");
      expect(asMaint).toContain("secret project qqvv");
    });
  });

  describe("memories never used, time saved and weekly people", () => {
    it("counts live learnings and practices over 14 days old, saved since reads are recorded, with no read and no reaction from anyone but the author", async () => {
      await people(A, B);
      const later = new Date("2026-11-10T12:00:00Z");
      const saved = "2026-10-08 00:00:00"; // after INACTIVITY_CLOCK_START, over 14 days before `later`
      const unread = await memory(A, { createdAt: saved });
      const read = await memory(A, { createdAt: saved });
      const votedByOther = await memory(A, { createdAt: saved, kind: "practice" });
      await memory(A, { createdAt: saved, kind: "standard" }); // not a learning or practice
      await memory(A, { createdAt: "2026-11-01 00:00:00" }); // too young
      await memory(A, { createdAt: "2026-09-01 00:00:00" }); // saved before reads were recorded: not judged
      const pinned = await memory(A, { createdAt: saved });
      const { getDb } = await import("../lib/db");
      getDb().prepare("UPDATE learnings SET last_accessed_at = '2026-10-20 10:00:00' WHERE id = ?").run(read);
      getDb().prepare("UPDATE learnings SET pinned = 1 WHERE id = ?").run(pinned);
      await vote(votedByOther, B, "helpful");
      const { usageReport } = await import("../lib/usage");
      const u = usageReport(later).unused;
      expect(u).toEqual({ unused: 1, eligible: 3 });
      expect(unread).toBeTruthy();
    });

    it("counts saved effort only for reuses measured on both sides, per person and memory, floored at zero", async () => {
      const { measuredSavingsFrom } = await import("../lib/usage");
      const r = (learningId: string, voterId: string, at: string, d: [number, number] | null, u: [number, number] | null) => ({
        learningId,
        voterId,
        at,
        discoveryMs: d ? d[0] : null,
        discoveryTokens: d ? d[1] : null,
        reuseMs: u ? u[0] : null,
        reuseTokens: u ? u[1] : null,
      });
      const m = measuredSavingsFrom(
        [
          // Measured: 30 min and 100k tokens to find, 5 min and 10k to reuse.
          r("m1", "a@example.com", "2026-10-28 10:00:00", [1_800_000, 100_000], [300_000, 10_000]),
          // The same person's kudos on the same memory is the same reuse: the earliest measured one counts.
          r("m1", "A@example.com", "2026-10-28 11:00:00", [1_800_000, 100_000], [60_000, 1_000]),
          // Reuse cost more than discovery: floored at zero, still a measured reuse.
          r("m2", "b@example.com", "2026-10-28 10:00:00", [60_000, 5_000], [120_000, 9_000]),
          // No discovery measurement, and no reuse measurement.
          r("m3", "a@example.com", "2026-10-28 10:00:00", null, [60_000, 1_000]),
          r("m4", "a@example.com", "2026-10-28 10:00:00", [600_000, 1_000], null),
        ],
        "2026-10-27",
      );
      expect(m).toEqual({ since: "2026-10-27", reuses: 4, measured: 2, noDiscovery: 1, noReuse: 1, savedMs: 1_500_000, savedTokens: 90_000 });
    });

    it("reads the measured costs from the database, people's helpful and kudos reactions only", async () => {
      await people(A, B);
      const found = await memory(A);
      const unmeasured = await memory(A);
      const { getDb } = await import("../lib/db");
      const db = getDb();
      db.prepare("INSERT INTO learning_costs (learning_id, active_ms, tokens) VALUES (?, ?, ?)").run(found, 3_600_000, 200_000);
      await vote(found, B, "helpful");
      db.prepare("INSERT INTO reuse_costs (learning_id, voter_id, kind, active_ms, tokens) VALUES (?, ?, 'helpful', ?, ?)").run(found, B, 600_000, 20_000);
      await people("system");
      await vote(found, "system", "helpful");
      await vote(unmeasured, B, "confirm");
      await vote(unmeasured, B, "kudos");
      const { measuredSavings, lastWeeks } = await import("../lib/usage");
      expect(measuredSavings(lastWeeks(new Date()))).toMatchObject({ reuses: 2, measured: 1, noDiscovery: 1, noReuse: 0, savedMs: 3_000_000, savedTokens: 180_000 });
    });

    it("shows the measured tiles, with what was left out in the hover", async () => {
      await people(A, B);
      const found = await memory(A);
      const { getDb } = await import("../lib/db");
      const db = getDb();
      db.prepare("INSERT INTO learning_costs (learning_id, active_ms, tokens) VALUES (?, ?, ?)").run(found, 2 * 3_600_000, 1_250_000);
      await vote(found, B, "helpful");
      db.prepare("INSERT INTO reuse_costs (learning_id, voter_id, kind, active_ms, tokens) VALUES (?, ?, 'helpful', ?, ?)").run(found, B, 1_800_000, 50_000);
      await vote(await memory(A), B, "kudos");
      const html = await render(B);
      expect(html).toMatch(/data-testid="tile-time-saved"[^>]*>1.5 h</);
      expect(html).toMatch(/data-testid="tile-tokens-saved"[^>]*>1.2M</);
      expect(html).toMatch(/data-testid="tile-time-saved-note"[^>]*>1 measured reuse since 27 Oct</);
      expect(html).toMatch(/data-testid="tile-tokens-saved-note"[^>]*>1,200,000 tokens since 27 Oct</);
      expect(html).toContain("Counted: 1 of 2 reuses since 27 Oct");
      expect(html).toContain("1 reuse of memories saved without a measured cost");
      expect(html).not.toContain("Measuring since");
    });

    it("shows the second row of tiles and the weekly active people card", async () => {
      await people(A, B);
      const prev = await (async () => {
        const { weekStart } = await import("../lib/usage");
        const d = new Date(`${weekStart(new Date())}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 7);
        return d.toISOString().slice(0, 10);
      })();
      await row(A, "GET", `${prev} 00:00:01`, { path: "/memory" });
      const { getDb } = await import("../lib/db");
      const now = (getDb().prepare("SELECT datetime('now') AS t").get() as { t: string }).t;
      await row(A, "GET", now, { path: "/memory" });
      // 4 searches, each followed by a helpful reaction: 100% helped. Nothing measured yet.
      for (let i = 0; i < 4; i++) {
        await row(A, "POST", `${prev} 0${i}:00:00`, { path: "/mcp#tools/call:bab_search" });
        await row(A, "helpful", `${prev} 0${i}:05:00`, { entity: "learning" });
      }
      for (const sec of [1, 2]) await row(A, "create", `${prev} 09:00:0${sec}`, { entity: "learning" });
      const html = await render(B);
      expect(html).toMatch(/data-testid="tile-time-saved"[^>]*>Measuring since 27 Oct</);
      expect(html).toMatch(/data-testid="tile-tokens-saved"[^>]*>Measuring since 27 Oct</);
      expect(html).toMatch(/data-testid="tile-time-saved-note"[^>]*>No reuse measured on both sides yet</);
      expect(html).toMatch(/data-testid="tile-search-helped"[^>]*>100%</);
      expect(html).toMatch(/data-testid="tile-helped-note"[^>]*>4 of 4, last 12 months</);
      expect(html).toContain("docs/savings.md");
      // The old estimate is gone.
      expect(html).not.toContain("Time saved (estimate)");
      expect(html).not.toContain("An estimate, not a measurement");
      // Outcomes first, then activity, in the owner's order.
      const order = ["tile-time-saved", "tile-tokens-saved", "tile-search-helped", "tile-found-nothing", "tile-saved", "tile-searches", "tile-helpful", "tile-active-week"];
      const at = order.map((id) => html.indexOf(`data-testid="${id}"`));
      expect(at.every((x) => x > 0)).toBe(true);
      expect(at).toEqual([...at].sort((x, y) => x - y));
      // Never used moved to the Upkeep row.
      expect(html.indexOf('data-testid="tile-never-used"')).toBeGreaterThan(html.indexOf('id="upkeep-h"'));
      // A (also active last week), B and the viewer's own page view.
      expect(html).toMatch(/data-testid="tile-active-week"[^>]*>3</);
      expect(html).toMatch(/data-testid="tile-active-week-note"[^>]*>1 returning, 2 new</);
      expect(html).toMatch(/data-testid="tile-found-nothing-note"[^>]*>No searches recorded yet</);
      expect(html).toContain("Weekly active people");
      expect(html).toContain("Week of ");
      expect(html).toMatch(/3 people, 1 returning, 2 new/);
      expect(html).not.toMatch(/NaN|Infinity|-\d+(\.\d)? h</);
    });

    it("labels weak standing as few or no reactions, and explains no team tag", async () => {
      await people(A);
      await memory(A, { tags: [] });
      const html = await render(A);
      expect(html).toContain("Low so far");
      expect(html).not.toMatch(/<span>Weak<\/span>/);
      expect(html).toContain("Authors can add one to their memories.");
    });
  });
});
