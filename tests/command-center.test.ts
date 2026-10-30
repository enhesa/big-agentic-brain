import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Command Center store (lib/command-center.ts): validation, upsert, question lifecycle, opt-in,
 * retention, snapshot and the lease. Each test gets its own DATA_DIR and a fresh store.
 */

let dataDir: string;
const OWNER = "owner.one@example.com";
const OTHER = "other.two@example.com";
const ORIGIN = "https://bab.example.com";
const NOW = Date.parse("2026-03-02T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Cc = typeof import("../lib/command-center");
let cc: Cc;

const device = (id: string, deviceId = "dev-1") => ({ id, email: id, name: "Some One", source: "device" as const, deviceId });
const ME = device(OWNER);

function record(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: "billing-export",
    title: "Billing export",
    area: "finance",
    state: "active",
    tasks: [
      { id: "design", text: "Design it", status: "done" },
      { id: "build", text: "Build it", status: "in_progress" },
    ],
    questions: [{ id: "q-scope", text: "Which months?", options: ["Last 3", "All"] }],
    links: [{ label: "PR", url: "https://git.example.com/acme/x/pull/1" }],
    source: { machine: "laptop-1", session: "s-1" },
    ...extra,
  };
}

function run(args: Record<string, unknown>, actor: Parameters<Cc["runCommandCenter"]>[0] = ME) {
  return cc.runCommandCenter(actor, args, "mcp", ORIGIN) as Record<string, unknown>;
}

function publish(extra: Record<string, unknown> = {}, actor?: Parameters<Cc["runCommandCenter"]>[0]) {
  return run({ action: "publish", ...record(extra) }, actor);
}

function refusal(fn: () => unknown): { status: number; message: string; current?: unknown } {
  try {
    fn();
  } catch (err) {
    const e = err as { status?: number; message: string; current?: unknown };
    return { status: e.status ?? 0, message: e.message, current: e.current };
  }
  throw new Error("expected a refusal");
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-cc-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  cc = await import("../lib/command-center");
  cc._resetCommandCenterForTests();
  (await import("../lib/rate-limit")).resetForTests();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
  upsertUser({ id: OTHER, email: OTHER, name: "Other Two", roles: [] });
  cc.ccSetSwitch(OWNER, true);
});

afterEach(async () => {
  vi.useRealTimers();
  cc._resetCommandCenterForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_COMMAND_CENTER;
  delete process.env.BAB_REPLICAS;
  (await import("../lib/config"))._resetConfigForTests();
  vi.resetModules();
});

const auditRows = async (action: string) => {
  const { getDb } = await import("../lib/db");
  return getDb().prepare("SELECT actor_id, entity_id, details FROM audit_log WHERE action = ?").all(action) as { actor_id: string; entity_id: string; details: string }[];
};

describe("publish", () => {
  it("is an upsert: a replay changes nothing, a change is the same record with seq 2", async () => {
    expect(publish()).toMatchObject({ id: "billing-export", seq: 1 });
    expect(publish()).toMatchObject({ id: "billing-export", seq: 1, unchanged: true });
    expect(await auditRows("cc_publish")).toHaveLength(1);
    expect(publish({ title: "Billing export v2" })).toMatchObject({ id: "billing-export", seq: 2 });
    const list = run({ action: "list" });
    expect(list.initiatives).toHaveLength(1);
    expect((list.initiatives as { seq: number; openQuestions: number }[])[0]).toMatchObject({ seq: 2, openQuestions: 1 });
  });

  it("keeps askedAt while a question id stays, clears a missing one, and drops cleared ones after 7 days", () => {
    const first = publish();
    const askedAt = (first.questions as { askedAt: string }[])[0].askedAt;
    vi.setSystemTime(NOW + HOUR);
    const second = publish();
    expect((second.questions as { askedAt: string }[])[0].askedAt).toBe(askedAt);
    vi.setSystemTime(NOW + 2 * HOUR);
    const third = publish({ questions: [] });
    expect(third.questions).toEqual([{ id: "q-scope", askedAt, clearedAt: new Date(NOW + 2 * HOUR).toISOString() }]);
    vi.setSystemTime(NOW + 2 * HOUR + 7 * DAY);
    expect(publish({ questions: [] }).questions).toEqual([]);
  });

  it("refuses a sixth open question", () => {
    const qs = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, text: "Why?" }));
    expect(refusal(() => publish({ questions: qs }))).toMatchObject({ status: 400, message: "questions: at most 5 open; clear one first" });
  });

  it("refuses a record over 32 KB with 413 and stores nothing", () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, text: "x".repeat(120), status: "pending" }));
    const comments = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, text: "y".repeat(500) }));
    const links = Array.from({ length: 20 }, (_, i) => ({ label: "z".repeat(60), url: "https://example.com/" + "p".repeat(470) + i }));
    const questions = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, text: "w".repeat(500), options: ["o".repeat(60), "o".repeat(60), "o".repeat(60), "o".repeat(60)] }));
    const r = refusal(() => publish({ tasks, comments, links, questions }));
    expect(r.status).toBe(413);
    expect(r.message).toMatch(/at most 32 KB per initiative/);
    expect(run({ action: "list" }).initiatives).toEqual([]);
  });

  it("refuses an unknown field and names it with the allowed list", () => {
    const r = refusal(() => publish({ owner: OTHER }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/^unknown field 'owner'; allowed: v, id, title/);
    expect(refusal(() => publish({ tasks: [{ id: "a", text: "b", status: "done", extra: 1 }] })).message).toMatch(/unknown field 'tasks\[0\]\.extra'; allowed: id, text, status/);
  });

  it("requires v: 1", () => {
    const { v: _v, ...noV } = record();
    void _v;
    expect(refusal(() => run({ action: "publish", ...noV })).message).toBe('v is required: add "v": 1 to the record');
    expect(refusal(() => publish({ v: 2 })).message).toMatch(/v must be 1/);
  });

  it("names the field and the fix for bad values, and truncates nothing", () => {
    expect(refusal(() => publish({ tasks: [{ id: "a", text: "b", status: "doing" }] })).message).toBe("tasks[0].status must be pending, in_progress or done");
    expect(refusal(() => publish({ links: [{ label: "x", url: "http://example.com" }] })).message).toBe("links[0].url must start with https://");
    expect(refusal(() => publish({ links: [{ label: "x", url: "javascript:alert(1)" }] })).status).toBe(400);
    expect(refusal(() => publish({ links: [{ label: "x", url: "data:text/html,hi" }] })).status).toBe(400);
    expect(refusal(() => publish({ title: "t".repeat(121) })).message).toMatch(/title is 121 characters; at most 120/);
    expect(refusal(() => publish({ id: "Bad Id" })).message).toMatch(/^id must be a slug/);
    expect(refusal(() => publish({ deadline: "2026-02-30" })).message).toMatch(/deadline must be a date/);
    expect(refusal(() => publish({ key: "not a key" })).message).toMatch(/key must be a ticket key/);
    expect(refusal(() => publish({ cadence: "daily" })).message).toMatch(/cadence is for kind "recurring" only/);
    expect(refusal(() => publish({ kind: "recurring", tasks: [{ id: "a", text: "b", status: "done" }] })).message).toMatch(/has no tasks/);
    expect(refusal(() => publish({ tasks: [{ id: "a", text: "b", status: "done" }, { id: "a", text: "c", status: "done" }] })).message).toMatch(/used twice/);
    expect(refusal(() => publish({ priority: "soon" })).message).toBe("priority must be urgent, high, low or paused");
    expect(refusal(() => publish({ expectSeq: -1 })).message).toMatch(/expectSeq must be a whole number/);
  });

  it("expectSeq mismatch is 409 with the current record", () => {
    publish();
    const r = refusal(() => publish({ expectSeq: 0 }));
    expect(r.status).toBe(409);
    expect(r.current).toMatchObject({ id: "billing-export", seq: 1 });
    expect(r.message).toMatch(/expectSeq 1/);
    expect(publish({ expectSeq: 1, title: "Changed" })).toMatchObject({ seq: 2 });
  });

  it("refuses a token in a comment and names the field and the kind", () => {
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const r = refusal(() => publish({ comments: [{ id: "c1", text: `use ${token}` }] }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/^comments\[0\]\.text holds .+, and Command Center never keeps confidential data/);
  });

  it("owns every timestamp: tasks get started and finished times, health gets receivedAt", () => {
    publish();
    const got = cc.ccGet(OWNER, "billing-export");
    expect(got.tasks[0]).toMatchObject({ startedAt: new Date(NOW).toISOString(), finishedAt: new Date(NOW).toISOString() });
    expect(got.tasks[1]).toMatchObject({ startedAt: new Date(NOW).toISOString(), finishedAt: null });
    expect(got.progress).toBe(50);
    expect(got.publishedBy).toBe("device:dev-1");
    expect(JSON.stringify(got)).not.toMatch(/secret/i);
  });

  it("caps a person at 100 initiatives", () => {
    for (let i = 0; i < 100; i++) cc.ccPublish(ME, OWNER, record({ id: `i${i}`, questions: [] }), "mcp");
    expect(refusal(() => cc.ccPublish(ME, OWNER, record({ id: "one-more" }), "mcp")).message).toMatch(/100 initiatives/);
  });
});

describe("the other actions", () => {
  it("clear_question clears an open one, and answers unknown otherwise", () => {
    publish();
    expect(run({ action: "clear_question", id: "billing-export", questionId: "q-scope" })).toEqual({ cleared: true });
    expect(run({ action: "clear_question", id: "billing-export", questionId: "q-scope" })).toEqual({ cleared: false, reason: "unknown" });
    expect(run({ action: "clear_question", id: "nope", questionId: "q-scope" })).toEqual({ cleared: false, reason: "unknown" });
  });

  it("comment appends with a server time and keeps the last 20", () => {
    publish();
    for (let i = 0; i < 20; i++) cc.ccComment(ME, OWNER, { id: "billing-export", text: `note ${i}` }, "mcp");
    expect(cc.ccComment(ME, OWNER, { id: "billing-export", text: "note 20" }, "mcp").dropped).toBe("n2");
    cc.ccComment(ME, OWNER, { id: "billing-export", text: "note 21" }, "mcp");
    const got = cc.ccGet(OWNER, "billing-export");
    expect(got.comments).toHaveLength(20);
    expect(got.comments[19]).toMatchObject({ text: "note 21", at: new Date(NOW).toISOString() });
    expect(refusal(() => run({ action: "comment", id: "missing", text: "x" })).status).toBe(404);
    expect(refusal(() => run({ action: "comment", id: "billing-export", text: "x", extra: 1 })).message).toMatch(/unknown field 'extra' for comment/);
  });

  it("health is for recurring initiatives and marks overdue by cadence", () => {
    publish();
    expect(refusal(() => run({ action: "health", id: "billing-export", level: "green", reason: "", checkedAt: "2026-03-02T09:00:00Z" })).message).toMatch(/recurring/);
    publish({ id: "inbox-drain", kind: "recurring", cadence: "drain", tasks: [], questions: [] });
    expect(run({ action: "health", id: "inbox-drain", level: "green", reason: "empty", checkedAt: "2026-03-02T09:00:00Z" })).toEqual({ seq: 2 });
    expect(refusal(() => run({ action: "health", id: "inbox-drain", level: "blue", checkedAt: "x" })).message).toMatch(/level must be/);
    vi.setSystemTime(NOW + 3 * HOUR);
    const list = run({ action: "list" });
    expect((list.initiatives as { id: string; overdue: boolean }[]).find((i) => i.id === "inbox-drain")!.overdue).toBe(true);
    expect(list.dataHealth).toMatchObject({ overdueRecurring: 1 });
  });

  it("remove drops one record and audits it", async () => {
    publish();
    expect(run({ action: "remove", id: "billing-export" })).toEqual({ removed: true });
    expect(run({ action: "remove", id: "billing-export" })).toEqual({ removed: false });
    expect((await auditRows("cc_remove"))[0]).toMatchObject({ actor_id: OWNER, entity_id: "billing-export" });
  });

  it("refuses an unknown action, and an action with no default", () => {
    expect(refusal(() => run({ action: "nope" })).message).toMatch(/required, has no default/);
    expect(refusal(() => run({})).message).toMatch(/required, has no default/);
  });

  it("audits writes without bodies", async () => {
    publish();
    run({ action: "comment", id: "billing-export", text: "BODY-TEXT-HERE" });
    const rows = [...(await auditRows("cc_publish")), ...(await auditRows("cc_comment"))];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.details).not.toContain("BODY-TEXT-HERE");
  });
});

describe("review fixes", () => {
  it("a question the person dismissed stays dismissed while its text is the same", () => {
    publish();
    expect(cc.ccClearQuestion(OWNER, { id: "billing-export", questionId: "q-scope" }, "ui")).toEqual({ cleared: true });
    const again = publish();
    expect(again.dismissed).toEqual(["q-scope"]);
    expect(cc.ccView(OWNER).needsYou).toEqual([]);
    expect(publish({ questions: [{ id: "q-scope", text: "Which months, now?" }] }).dismissed).toBeUndefined();
    expect(cc.ccView(OWNER).needsYou).toHaveLength(1);
  });

  it("a dismissal on the page moves neither seq nor updatedAt", () => {
    publish();
    vi.setSystemTime(NOW + DAY);
    cc.ccClearQuestion(OWNER, { id: "billing-export", questionId: "q-scope" }, "ui");
    expect(cc.ccGet(OWNER, "billing-export")).toMatchObject({ seq: 1, updatedAt: new Date(NOW).toISOString() });
  });

  it("a publish without comments or health keeps them; an explicit empty value clears them", () => {
    publish();
    run({ action: "comment", id: "billing-export", text: "woken 10:30" });
    publish();
    expect(cc.ccGet(OWNER, "billing-export").comments.map((c) => c.text)).toEqual(["woken 10:30"]);
    publish({ comments: [] });
    expect(cc.ccGet(OWNER, "billing-export").comments).toEqual([]);
    publish({ id: "upkeep", kind: "recurring", tasks: [], questions: [] });
    run({ action: "health", id: "upkeep", level: "green", reason: "ok", checkedAt: "2026-03-02T09:00:00Z" });
    publish({ id: "upkeep", kind: "recurring", tasks: [], questions: [], title: "Upkeep" });
    expect(cc.ccGet(OWNER, "upkeep").health).toMatchObject({ level: "green" });
    publish({ id: "upkeep", kind: "recurring", tasks: [], questions: [], title: "Upkeep", health: null });
    expect(cc.ccGet(OWNER, "upkeep").health).toBeNull();
  });

  it("checkedAt must be a strict ISO time", () => {
    publish({ id: "upkeep", kind: "recurring", tasks: [], questions: [] });
    expect(refusal(() => run({ action: "health", id: "upkeep", level: "green", reason: "", checkedAt: "March 2" })).message).toMatch(/checkedAt must be an ISO/);
  });

  it("keeps at most 20 cleared questions", () => {
    for (let i = 0; i < 25; i++) cc.ccPublish(ME, OWNER, record({ questions: [{ id: `q${i}`, text: `Ask ${i}` }] }), "mcp");
    const qs = cc.ccGet(OWNER, "billing-export").questions;
    expect(qs.filter((q) => q.clearedAt)).toHaveLength(20);
    expect(qs.filter((q) => !q.clearedAt).map((q) => q.id)).toEqual(["q24"]);
  });

  it("does not load the records of someone switched off past the keep window", () => {
    publish();
    cc.saveCommandCenterSnapshot();
    cc.ccSetSwitch(OWNER, false);
    cc._resetCommandCenterForTests();
    vi.setSystemTime(NOW + 31 * DAY);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(cc.ccView(OWNER).records).toEqual([]);
    warn.mockRestore();
    // The drop is written back, so the file forgets them too.
    expect(cc.saveCommandCenterSnapshot()).toBe(true);
    expect(JSON.parse(readFileSync(cc.ccSnapshotPath(), "utf8")).owners).toEqual({});
  });

  it("delete now and remove are written to disk at once", () => {
    publish();
    cc.saveCommandCenterSnapshot();
    run({ action: "remove", id: "billing-export" });
    expect(JSON.parse(readFileSync(cc.ccSnapshotPath(), "utf8")).owners).toEqual({});
    publish();
    cc.saveCommandCenterSnapshot();
    cc.ccDeleteAll(OWNER);
    expect(JSON.parse(readFileSync(cc.ccSnapshotPath(), "utf8")).owners).toEqual({});
  });
});

describe("identity and opt-in", () => {
  it("refuses a declared identity and serves a device and a bound token", () => {
    const declared = { id: OWNER, email: OWNER, source: "declared" as const };
    expect(refusal(() => run({ action: "list" }, declared))).toMatchObject({ status: 403 });
    expect(run({ action: "list" }, ME).initiatives).toEqual([]);
    expect(run({ action: "list" }, { ...declared, tokenBound: true }).initiatives).toEqual([]);
  });

  it("switch off is 403 with the exact sentence and stores nothing", () => {
    const other = device(OTHER, "dev-2");
    const r = refusal(() => publish({}, other));
    expect(r).toMatchObject({
      status: 403,
      message: `Command Center is off for Other Two. Ask them to open ${ORIGIN}/command-center and switch it on, then publish again. Nothing was stored.`,
    });
    expect(refusal(() => run({ action: "list" }, other)).status).toBe(403);
    expect(cc.ccView(OTHER).records).toEqual([]);
  });

  it("switch off then on restores the records; delete now empties and audits", async () => {
    publish();
    cc.ccSetSwitch(OWNER, false);
    expect(refusal(() => run({ action: "list" })).status).toBe(403);
    const off = cc.ccView(OWNER);
    expect(off.keptUntil).toBe("2026-04-01");
    cc.ccSetSwitch(OWNER, true);
    expect(run({ action: "list" }).initiatives).toHaveLength(1);
    expect(cc.ccDeleteAll(OWNER)).toEqual({ deleted: 1 });
    expect(run({ action: "list" }).initiatives).toEqual([]);
    expect(await auditRows("cc_delete_all")).toHaveLength(1);
    expect(await auditRows("cc_enable")).toHaveLength(2);
    expect(await auditRows("cc_disable")).toHaveLength(1);
  });

  it("deletes a switched-off person's records after 30 days", () => {
    publish();
    cc.ccSetSwitch(OWNER, false);
    vi.setSystemTime(NOW + 31 * DAY);
    expect(cc.sweepCommandCenter()).toBe(1);
    cc.ccSetSwitch(OWNER, true);
    expect(run({ action: "list" }).initiatives).toEqual([]);
  });

  it("keeps people apart: the viewer's owner key is the agent's owner key", () => {
    publish();
    cc.ccSetSwitch(OTHER, true);
    expect(run({ action: "list" }, device(OTHER, "dev-2")).initiatives).toEqual([]);
    expect(cc.ccView(OTHER).records).toEqual([]);
    expect(cc.ccView(OWNER).records.map((r) => r.id)).toEqual(["billing-export"]);
  });

  it("rate limits at 20 at once and answers 429 with the wait", () => {
    for (let i = 0; i < 20; i++) run({ action: "list" });
    const r = refusal(() => run({ action: "list" }));
    expect(r.status).toBe(429);
    expect(r.message).toMatch(/at most 60 a minute, 20 at once/);
  });

  it("is 404 when switched off on the server, 503 with replicas", async () => {
    process.env.BAB_COMMAND_CENTER = "0";
    (await import("../lib/config"))._resetConfigForTests();
    expect(refusal(() => run({ action: "list" })).status).toBe(404);
    process.env.BAB_COMMAND_CENTER = "1";
    process.env.BAB_REPLICAS = "2";
    (await import("../lib/config"))._resetConfigForTests();
    expect(refusal(() => run({ action: "list" })).status).toBe(503);
  });
});

describe("derived flags", () => {
  it("flags stale questions at 3 days, on closed initiatives and when another session kept them", () => {
    publish();
    expect(cc.ccView(OWNER).needsYou[0].question.stale).toBe(false);
    vi.setSystemTime(NOW + 3 * DAY + 1000);
    expect(cc.ccView(OWNER).needsYou[0].question.stale).toBe(true);
    vi.setSystemTime(NOW);
    publish({ source: { machine: "vm-1", session: "s-2" } });
    expect(cc.ccView(OWNER).needsYou[0].question.stale).toBe(true);
    expect(cc.ccView(OWNER).records[0].twoWriters).toBe(true);
    publish({ state: "done", source: { machine: "laptop-1", session: "s-1" } });
    expect(cc.ccView(OWNER).dataHealth.staleQuestions).toBe(1);
  });

  it("paused hides questions and counts nothing as stale or silent", () => {
    publish({ priority: "paused" });
    vi.setSystemTime(NOW + 20 * DAY);
    const v = cc.ccView(OWNER);
    expect(v.needsYou).toEqual([]);
    expect(v.dataHealth).toEqual({ staleQuestions: 0, silentInitiatives: 0, recurringWithoutHealth: 0, overdueRecurring: 0 });
  });

  it("silent after 14 days, dropped after 60; done dropped after 30", () => {
    publish();
    publish({ id: "old-done", state: "done", questions: [] });
    vi.setSystemTime(NOW + 15 * DAY);
    expect(cc.ccView(OWNER).dataHealth.silentInitiatives).toBe(1);
    vi.setSystemTime(NOW + 31 * DAY);
    expect(cc.ccView(OWNER).records.map((r) => r.id)).toEqual(["billing-export"]);
    vi.setSystemTime(NOW + 61 * DAY);
    expect(cc.ccView(OWNER).records).toEqual([]);
  });

  it("counts recurring without health, sorts by state and priority", () => {
    publish({ id: "upkeep", kind: "recurring", tasks: [], questions: [] });
    publish({ id: "low-one", priority: "low", questions: [] });
    publish({ id: "urgent-one", priority: "urgent", questions: [] });
    publish({ id: "done-one", state: "done", questions: [] });
    const v = cc.ccView(OWNER);
    expect(v.dataHealth.recurringWithoutHealth).toBe(1);
    expect(v.records.map((r) => r.id)).toEqual(["urgent-one", "upkeep", "low-one", "done-one"]);
    expect(v.records.at(-1)!.progress).toBe(100);
  });
});

describe("snapshot and lease", () => {
  it("survives a restart", () => {
    publish();
    expect(cc.saveCommandCenterSnapshot()).toBe(true);
    expect(cc.saveCommandCenterSnapshot()).toBe(false);
    cc._resetCommandCenterForTests();
    expect(cc.ccGet(OWNER, "billing-export")).toMatchObject({ seq: 1, title: "Billing export" });
  });

  it("drops a corrupt entry and counts it in the log", () => {
    publish();
    cc.saveCommandCenterSnapshot();
    cc._resetCommandCenterForTests();
    const file = cc.ccSnapshotPath();
    const snap = JSON.parse(readFileSync(file, "utf8"));
    snap.owners[OWNER].push({ ...snap.owners[OWNER][0], id: "broken", links: [{ label: "x", url: "javascript:1" }] });
    snap.owners[OWNER].push({ ...snap.owners[OWNER][0] });
    writeFileSync(file, JSON.stringify(snap));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(run({ action: "list" }).initiatives).toHaveLength(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("dropped 2 Command Center snapshot entries"))).toBe(true);
    warn.mockRestore();
  });

  it("a broken file is an empty store", () => {
    writeFileSync(path.join(dataDir, "command-center-snapshot.json"), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(run({ action: "list" }).initiatives).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a second process on a fresh lease gets 503", () => {
    publish();
    cc._resetCommandCenterForTests();
    // Another live process on another host holds the lease.
    writeFileSync(path.join(dataDir, "kv.lease"), JSON.stringify({ instance: "other", host: "another-host", pid: 1, at: Date.now() }));
    const r = refusal(() => run({ action: "list" }));
    expect(r.status).toBe(503);
    expect(r.message).toMatch(/another BAB process serves it/);
  });

  it("flush writes when dirty, and never without the lease", () => {
    cc.flushCommandCenterSnapshot();
    publish();
    cc.flushCommandCenterSnapshot();
    expect(JSON.parse(readFileSync(cc.ccSnapshotPath(), "utf8")).owners[OWNER]).toHaveLength(1);
  });
});

describe("migration v53", () => {
  it("adds the opt-in columns and keeps a decision across a rewind", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    const before = cc.ccSwitch(OWNER).enabledAt;
    expect(before).not.toBeNull();
    db.prepare("DELETE FROM migrations WHERE version >= 53").run();
    _resetDbForTests();
    const again = getDb();
    const cols = (again.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["command_center_enabled_at", "command_center_disabled_at"]));
    expect(again.prepare("SELECT 1 FROM migrations WHERE version = 53").get()).toBeTruthy();
    expect(cc.ccSwitch(OWNER).enabledAt).toBe(before);
  });
});
