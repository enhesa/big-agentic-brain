import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isSessionLink } from "../lib/command-center-link";

/**
 * Command Center store (lib/command-center.ts): validation, upsert, question lifecycle, the work
 * log, opt-in, retention, the SQLite store, the v2 snapshot import and migration v54. Each test
 * gets its own DATA_DIR and a fresh database.
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
  delete process.env.BAB_COMMAND_CENTER_LOG_DAYS;
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
    expect(refusal(() => publish({ questions: qs }))).toMatchObject({ status: 400, message: "questions: at most 5 open; leave an answered one out to clear it" });
  });

  it("refuses a record over 32 KB with 413 and stores nothing", () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, text: "x".repeat(120), status: "pending" }));
    const links = Array.from({ length: 20 }, (_, i) => ({ label: "z".repeat(60), url: "https://example.com/" + "p".repeat(470) + i }));
    const questions = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, text: "w".repeat(500), options: ["o".repeat(60), "o".repeat(60), "o".repeat(60), "o".repeat(60)] }));
    // Twenty cleared questions are kept for a week and count towards the record.
    for (let round = 0; round < 5; round++) {
      publish({ id: "big", questions: Array.from({ length: 5 }, (_, i) => ({ id: `old${round}-${i}`, text: "v".repeat(500) })) });
    }
    const logged = cc.ccLogOf(OWNER).length;
    const r = refusal(() => publish({ id: "big", tasks, links, questions, worked: "tried a big one" }));
    expect(r.status).toBe(413);
    expect(r.message).toMatch(/at most 32 KB per initiative.*keeps 20 cleared questions for 7 days/);
    expect(cc.ccGet(OWNER, "big").tasks).toHaveLength(2);
    expect(cc.ccLogOf(OWNER)).toHaveLength(logged);
  });

  it("refuses an unknown field and names it with the allowed list", () => {
    const r = refusal(() => publish({ owner: OTHER }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/^unknown field 'owner'; allowed: v, id, title/);
    expect(refusal(() => publish({ tasks: [{ id: "a", text: "b", status: "done", extra: 1 }] })).message).toMatch(/unknown field 'tasks\[0\]\.extra'; allowed: id, text, status/);
  });

  it("refuses comments and names worked as the fix", () => {
    expect(refusal(() => publish({ comments: [{ id: "c1", text: "hi" }] })).message).toMatch(/^comments is gone: send "worked"/);
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
    expect(refusal(() => publish({ worked: "w".repeat(201) })).message).toMatch(/worked is 201 characters; at most 200/);
    expect(refusal(() => publish({ worked: "line one\nline two" })).message).toMatch(/worked must be one line/);
    expect(refusal(() => publish({ worked: "line one\u2028line two" })).message).toMatch(/worked must be one line/);
    expect(refusal(() => publish({ worked: "bell\u0007" })).message).toMatch(/worked must be one line/);
    expect(refusal(() => publish({ id: "export" })).message).toBe("id 'export' is reserved; pick another id");
    expect(refusal(() => publish({ worked: "x", size: "huge" })).message).toBe("size must be small, medium or large");
    expect(refusal(() => publish({ size: "small" })).message).toMatch(/size goes with worked/);
  });

  it("keeps source.link only for https:// or claude://claude.ai/ with a plain path, and refuses the rest naming the field", () => {
    const withLink = (link: unknown) => {
      publish({ source: { machine: "laptop-1", session: "s-1", link } });
      return cc.ccGet(OWNER, record().id as string);
    };
    const accepted = [
      "claude://claude.ai/epitaxy/session_01AbCdEf",
      "claude://claude.ai",
      "https://claude.ai/code/session_01x-y_z.1",
      "https://bab.forge.example.com/a/b/",
      "https://claude.ai",
    ];
    for (const link of accepted) expect((withLink(link).source as { link?: string }).link).toBe(link);
    // Boundaries, checked on the shared rule: a 63-character label, exactly 300 characters.
    const label63 = "a".repeat(63);
    expect(isSessionLink(`https://${label63}.example.com/x`)).toBe(true);
    expect(isSessionLink(`https://${label63}a.example.com/x`)).toBe(false);
    const base = "https://claude.ai/";
    expect(isSessionLink(base + "a".repeat(300 - base.length))).toBe(true);
    expect(isSessionLink(base + "a".repeat(301 - base.length))).toBe(false);
    for (const odd of ["https://claude.ai//evil.example.com", "https://claude.ai/a/../b", "https://claude.ai/./x", "https://claude.ai/a//", "https://claude.ai/.."]) {
      expect(isSessionLink(odd)).toBe(false);
    }
    expect(isSessionLink("https://claude.ai/a/.well-known/x")).toBe(true);
    expect(refusal(() => cc.validateRecord(record({ source: { link: " " } }))).message).toMatch(/^source\.link /);
    const refused = [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.example.com/x",
      "http://claude.ai/x",
      "HTTPS://claude.ai/x",
      "Claude://claude.ai/x",
      "claude://evil.example.com/x",
      "claude://claude.ai.evil.com/x",
      "claude://claude.aix/x",
      "https://user:pw@example.com/x",
      "https://claude.ai@example.com/x",
      "https://claude.ai:8443/x",
      "https://claude.ai/x?y=1",
      "https://claude.ai/x#y",
      "https://claude.ai/a%20b",
      "https://claude.ai/%6Aavascript",
      "https://claude.ai/a b",
      "https://claude.ai/a\nb",
      "https://claude.ai/x\n",
      "https://claude.ai/x\u0000",
      "https://claude.ai/café",
      "https://claude.ai\\@evil.com",
      "https://localhost/x",
      "https://-bad.com/x",
      "https://claude.ai/" + "a".repeat(300),
      "claude:claude.ai/x",
      42,
      { url: "https://claude.ai" },
    ];
    for (const link of refused) {
      // validateRecord directly: the publish rate limit would refuse this many publishes first.
      const r = refusal(() => cc.validateRecord(record({ source: { machine: "laptop-1", session: "s-1", link } })));
      expect(r.status, String(link)).toBe(400);
      expect(r.message).toMatch(/^source\.link /);
    }
    // Empty or absent: no link, and the stored source has none.
    expect(withLink(null).source).toEqual({ machine: "laptop-1", session: "s-1" });
    expect(withLink("").source).toEqual({ machine: "laptop-1", session: "s-1" });
    // The page's own check is the same function.
    expect(refusal(() => withLink("https://claude.ai/" + "a".repeat(290))).message).toMatch(/source\.link is 308 characters; at most 300/);
  });

  it("refuses a source.link that holds a token, like any other text", async () => {
    const { isSessionLink } = await import("../lib/command-center-link");
    const tokenLink = "https://claude.ai/ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    // It passes the shape check, so the refusal comes from the confidential-data rule.
    expect(isSessionLink(tokenLink)).toBe(true);
    expect(refusal(() => publish({ source: { link: tokenLink } })).message).toMatch(/^source\.link holds .+, and Command Center never keeps confidential data/);
  });

  it("expectSeq mismatch is 409 with the current record, and logs nothing", () => {
    publish();
    const before = cc.ccLogOf(OWNER).length;
    const r = refusal(() => publish({ expectSeq: 0, title: "Someone else's change", worked: "my change" }));
    expect(r.status).toBe(409);
    expect(r.current).toMatchObject({ id: "billing-export", seq: 1, title: "Billing export" });
    expect(r.message).toMatch(/expectSeq 1/);
    expect(cc.ccLogOf(OWNER)).toHaveLength(before);
    expect(publish({ expectSeq: 1, title: "Changed" })).toMatchObject({ seq: 2 });
    expect(refusal(() => publish({ expectSeq: 1, title: "Stale" })).status).toBe(409);
  });

  it("a retried publish with the expectSeq the first try moved past is a no-op, not a 409", async () => {
    expect(publish({ expectSeq: 0, worked: "started it" })).toMatchObject({ seq: 1 });
    // The answer was lost; the agent sends the very same request again.
    expect(publish({ expectSeq: 0, worked: "started it" })).toMatchObject({ seq: 1, unchanged: true });
    expect(publish({ expectSeq: 1, title: "Changed" })).toMatchObject({ seq: 2 });
    expect(publish({ expectSeq: 1, title: "Changed" })).toMatchObject({ seq: 2, unchanged: true });
    expect(await auditRows("cc_publish")).toHaveLength(2);
    expect(cc.ccLogOf(OWNER).filter((e) => e.kind === "worked")).toHaveLength(1);
  });

  it("refuses a token in worked and names the field and the kind", () => {
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    const r = refusal(() => publish({ worked: `used ${token}` }));
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/^worked holds .+, and Command Center never keeps confidential data/);
    expect(cc.ccLogOf(OWNER)).toEqual([]);
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

describe("the work log", () => {
  it("logs worked with the server time, the session and machine, and a size", () => {
    const res = publish({ worked: "Built the export", size: "medium" });
    expect(res.logged).toMatch(/^[0-9a-f]{32}$/);
    const worked = cc.ccLogOf(OWNER).filter((e) => e.kind === "worked");
    expect(worked).toEqual([
      {
        id: res.logged,
        initiative: "billing-export",
        title: "Billing export",
        key: null,
        kind: "worked",
        text: "Built the export",
        size: "medium",
        session: "s-1",
        machine: "laptop-1",
        source: "live",
        at: new Date(NOW).toISOString(),
      },
    ]);
  });

  it("derives entries for task, question, health and state changes, once each", () => {
    publish({ tasks: [{ id: "a", text: "Do A", status: "pending" }] });
    const kinds = () => cc.ccLogOf(OWNER).map((e) => `${e.kind}:${e.text}`);
    expect(kinds()).toEqual(["question_asked:Which months?"]);
    vi.setSystemTime(NOW + HOUR);
    publish({ tasks: [{ id: "a", text: "Do A", status: "in_progress" }] });
    vi.setSystemTime(NOW + 2 * HOUR);
    publish({ tasks: [{ id: "a", text: "Do A", status: "done" }], questions: [] });
    vi.setSystemTime(NOW + 3 * HOUR);
    publish({ tasks: [{ id: "a", text: "Do A", status: "done" }], questions: [], state: "done" });
    publish({ tasks: [{ id: "a", text: "Do A", status: "done" }], questions: [], state: "done" });
    expect(kinds()).toHaveLength(5);
    expect(kinds()).toEqual(expect.arrayContaining(["question_asked:Which months?", "task_started:Do A", "task_done:Do A", "question_cleared:Which months?", "state:done"]));
    publish({ id: "upkeep", kind: "recurring", tasks: [], questions: [], health: { level: "green", reason: "ok", checkedAt: "2026-03-02T12:00:00Z" } });
    publish({ id: "upkeep", kind: "recurring", tasks: [], questions: [], health: { level: "green", reason: "still ok", checkedAt: "2026-03-02T12:30:00Z" } });
    publish({ id: "upkeep", kind: "recurring", tasks: [], questions: [], health: { level: "red", reason: "failing", checkedAt: "2026-03-02T13:00:00Z" } });
    expect(cc.ccLogOf(OWNER).filter((e) => e.kind === "health").map((e) => e.text)).toEqual(["green: ok", "red: failing"]);
  });

  it("an unchanged record with a new worked line logs it, keeps seq and touches updatedAt", () => {
    publish({ worked: "first" });
    vi.setSystemTime(NOW + DAY);
    const res = publish({ worked: "answered a question" });
    expect(res).toMatchObject({ seq: 1, unchanged: true });
    expect(res.logged).toBeTruthy();
    expect(cc.ccGet(OWNER, "billing-export")).toMatchObject({ seq: 1, updatedAt: new Date(NOW + DAY).toISOString() });
    // The retry answers the same entry and writes nothing.
    expect(publish({ worked: "answered a question" }).logged).toBe(res.logged);
    expect(cc.ccLogOf(OWNER).filter((e) => e.kind === "worked").map((e) => e.text)).toEqual(["first", "answered a question"]);
  });

  it("keeps the log when an initiative is removed or leaves the live view", () => {
    publish({ worked: "did it" });
    run({ action: "remove", id: "billing-export" });
    expect(cc.ccLogOf(OWNER).some((e) => e.text === "did it")).toBe(true);
  });

  it("logs the same line again after an initiative is removed and created anew", () => {
    publish({ worked: "same line" });
    run({ action: "remove", id: "billing-export" });
    vi.setSystemTime(NOW + HOUR);
    expect(publish({ worked: "same line" })).toMatchObject({ seq: 1 });
    expect(cc.ccLogOf(OWNER).filter((e) => e.text === "same line")).toHaveLength(2);
  });

  it("keeps people's logs apart", () => {
    publish({ worked: "mine" });
    publish({ worked: "theirs" }, device(OTHER, "dev-2"));
    expect(cc.ccLogOf(OWNER).filter((e) => e.kind === "worked").map((e) => e.text)).toEqual(["mine"]);
    expect(cc.ccLogOf(OTHER).filter((e) => e.kind === "worked").map((e) => e.text)).toEqual(["theirs"]);
    expect(cc.ccRecentLog(OTHER, "billing-export").every((e) => e.text !== "mine")).toBe(true);
  });

  it("drops entries older than BAB_COMMAND_CENTER_LOG_DAYS", async () => {
    process.env.BAB_COMMAND_CENTER_LOG_DAYS = "10";
    (await import("../lib/config"))._resetConfigForTests();
    publish({ worked: "old work" });
    vi.setSystemTime(NOW + 5 * DAY);
    publish({ worked: "newer work", title: "Billing export 2" });
    vi.setSystemTime(NOW + 11 * DAY);
    cc.sweepCommandCenter();
    expect(cc.ccLogOf(OWNER).filter((e) => e.kind === "worked").map((e) => e.text)).toEqual(["newer work"]);
    delete process.env.BAB_COMMAND_CENTER_LOG_DAYS;
  });
});

describe("the other actions", () => {
  it("comment, health and clear_question are gone, with the fix in the answer", () => {
    publish();
    expect(refusal(() => run({ action: "comment", id: "billing-export", text: "x" })).message).toMatch(/comment is gone: publish the record with "worked"/);
    expect(refusal(() => run({ action: "health", id: "billing-export" })).message).toMatch(/health is gone as an action/);
    expect(refusal(() => run({ action: "clear_question", id: "billing-export", questionId: "q-scope" })).message).toMatch(/clear_question is gone/);
  });

  it("health is a field for recurring initiatives and marks overdue by cadence", () => {
    publish();
    expect(refusal(() => publish({ health: { level: "green", reason: "", checkedAt: "2026-03-02T09:00:00Z" } })).message).toMatch(/recurring/);
    const upkeep = { id: "inbox-drain", kind: "recurring", cadence: "drain", tasks: [], questions: [] };
    publish({ ...upkeep, health: { level: "green", reason: "empty", checkedAt: "2026-03-02T09:00:00Z" } });
    expect(refusal(() => publish({ ...upkeep, health: { level: "blue", checkedAt: "x" } })).message).toMatch(/level must be/);
    expect(refusal(() => publish({ ...upkeep, health: { level: "green", reason: "", checkedAt: "March 2" } })).message).toMatch(/checkedAt must be an ISO/);
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

  it("list with an id is the full record", () => {
    publish();
    expect(run({ action: "list", id: "billing-export" })).toMatchObject({ id: "billing-export", seq: 1, tasks: [{ id: "design" }, { id: "build" }] });
    expect(refusal(() => run({ action: "list", id: "missing" })).status).toBe(404);
    expect(refusal(() => run({ action: "list", id: "billing-export", extra: 1 })).message).toMatch(/unknown field 'extra' for list/);
  });

  it("refuses an unknown action, and an action with no default", () => {
    expect(refusal(() => run({ action: "nope" })).message).toMatch(/required, has no default/);
    expect(refusal(() => run({})).message).toMatch(/required, has no default/);
  });

  it("audits writes without bodies", async () => {
    publish({ worked: "BODY-TEXT-HERE" });
    publish({ worked: "MORE-BODY-TEXT", title: "Renamed" });
    const rows = await auditRows("cc_publish");
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.details).not.toMatch(/BODY-TEXT/);
  });
});

describe("review fixes", () => {
  it("a question the person dismissed stays dismissed while its text is the same", () => {
    publish();
    expect(cc.ccClearQuestion(OWNER, { id: "billing-export", questionId: "q-scope" }, "ui")).toEqual({ cleared: true });
    expect(cc.ccClearQuestion(OWNER, { id: "billing-export", questionId: "q-scope" }, "ui")).toEqual({ cleared: false, reason: "unknown" });
    const again = publish();
    expect(again.dismissed).toEqual(["q-scope"]);
    expect(cc.ccView(OWNER).needsYou).toEqual([]);
    expect(publish({ questions: [{ id: "q-scope", text: "Which months, now?" }] }).dismissed).toBeUndefined();
    expect(cc.ccView(OWNER).needsYou).toHaveLength(1);
  });

  it("a dismissal on the page moves neither seq nor updatedAt, and is logged", () => {
    publish();
    vi.setSystemTime(NOW + DAY);
    cc.ccClearQuestion(OWNER, { id: "billing-export", questionId: "q-scope" }, "ui");
    expect(cc.ccGet(OWNER, "billing-export")).toMatchObject({ seq: 1, updatedAt: new Date(NOW).toISOString() });
    expect(cc.ccLogOf(OWNER).filter((e) => e.kind.startsWith("question")).map((e) => e.kind)).toEqual(["question_asked", "question_cleared"]);
  });

  it("a publish without health keeps it; an explicit null clears it", () => {
    const upkeep = { id: "upkeep", kind: "recurring", tasks: [], questions: [] };
    publish({ ...upkeep, health: { level: "green", reason: "ok", checkedAt: "2026-03-02T09:00:00Z" } });
    publish({ ...upkeep, title: "Upkeep" });
    expect(cc.ccGet(OWNER, "upkeep").health).toMatchObject({ level: "green" });
    publish({ ...upkeep, title: "Upkeep", health: null });
    expect(cc.ccGet(OWNER, "upkeep").health).toBeNull();
  });

  it("keeps at most 20 cleared questions", () => {
    for (let i = 0; i < 25; i++) cc.ccPublish(ME, OWNER, record({ questions: [{ id: `q${i}`, text: `Ask ${i}` }] }), "mcp");
    const qs = cc.ccGet(OWNER, "billing-export").questions;
    expect(qs.filter((q) => q.clearedAt)).toHaveLength(20);
    expect(qs.filter((q) => !q.clearedAt).map((q) => q.id)).toEqual(["q24"]);
  });

  it("drops cleared questions after 7 days", () => {
    publish();
    publish({ questions: [] });
    vi.setSystemTime(NOW + 8 * DAY);
    expect(cc.ccGet(OWNER, "billing-export").questions).toEqual([]);
  });
});

describe("identity and opt-in", () => {
  it("refuses a declared identity and serves a device and a bound token", () => {
    const declared = { id: OWNER, email: OWNER, source: "declared" as const };
    expect(refusal(() => run({ action: "list" }, declared))).toMatchObject({ status: 403 });
    expect(run({ action: "list" }, ME).initiatives).toEqual([]);
    expect(run({ action: "list" }, { ...declared, tokenBound: true }).initiatives).toEqual([]);
  });

  it("needs no opt-in: a person's first publish creates their Command Center", () => {
    const other = device(OTHER, "dev-2");
    expect(run({ action: "list" }, other).initiatives).toEqual([]);
    expect(publish({ worked: "x" }, other)).toMatchObject({ seq: 1 });
    expect(run({ action: "list" }, other).initiatives).toHaveLength(1);
    expect(cc.ccLogOf(OTHER).some((e) => e.kind === "worked" && e.text === "x")).toBe(true);
  });

  it("the sweep keeps a person who never had a switch; only the live and log rules delete", () => {
    publish({ worked: "x" });
    vi.setSystemTime(NOW + 29 * DAY);
    expect(cc.sweepCommandCenter()).toMatchObject({ records: 0, people: 0 });
    expect(run({ action: "list" }).initiatives).toHaveLength(1);
    vi.setSystemTime(NOW + 31 * DAY);
    expect(cc.sweepCommandCenter()).toMatchObject({ records: 1, people: 0 });
    expect(cc.ccLogOf(OWNER).length).toBeGreaterThan(0);
  });

  it("keeps parked and paused records 180 days, others 30, and list says how many days are left", () => {
    publish({ id: "plain", worked: "x" });
    publish({ id: "set-aside", state: "parked" });
    publish({ id: "on-hold", priority: "paused" });
    publish({ id: "finished", state: "done" });
    type Item = { id: string; expiresInDays: number };
    const days = () => Object.fromEntries((run({ action: "list" }).initiatives as Item[]).map((i) => [i.id, i.expiresInDays]));
    expect(days()).toEqual({ plain: 30, "set-aside": 180, "on-hold": 180, finished: 30 });

    vi.setSystemTime(NOW + 31 * DAY);
    expect(cc.sweepCommandCenter()).toMatchObject({ records: 2 });
    expect(days()).toEqual({ "set-aside": 149, "on-hold": 149 });

    vi.setSystemTime(NOW + 181 * DAY);
    expect(cc.sweepCommandCenter()).toMatchObject({ records: 2 });
    expect(run({ action: "list" }).initiatives).toEqual([]);
  });

  it("keeps the data of a person whose old switch column says off", async () => {
    publish({ worked: "x" });
    (await import("../lib/db")).getDb().prepare("UPDATE users SET command_center_enabled_at = NULL, command_center_disabled_at = ? WHERE id = ?").run(new Date(NOW - 40 * DAY).toISOString(), OWNER);
    expect(cc.sweepCommandCenter()).toMatchObject({ records: 0, people: 0 });
    expect(run({ action: "list" }).initiatives).toHaveLength(1);
    expect(cc.ccView(OWNER).records).toHaveLength(1);
  });

  it("delete_all empties the caller's records, log and grants only, and audits", async () => {
    publish({ worked: "mine" });
    publish({ worked: "theirs" }, device(OTHER, "dev-2"));
    expect(run({ action: "delete_all", confirm: true })).toMatchObject({ deleted: 1 });
    expect(run({ action: "list" }).initiatives).toEqual([]);
    expect(cc.ccLogOf(OWNER)).toEqual([]);
    expect(run({ action: "list" }, device(OTHER, "dev-2")).initiatives).toHaveLength(1);
    expect(cc.ccLogOf(OTHER).some((e) => e.text === "theirs")).toBe(true);
    expect(await auditRows("cc_delete_all")).toHaveLength(1);
    expect(refusal(() => run({ action: "delete_all", id: "billing-export" })).message).toMatch(/unknown field 'id' for delete_all/);
  });

  it("delete_all needs confirm: true and deletes nothing without it", () => {
    publish({ worked: "mine" });
    for (const extra of [{}, { confirm: false }, { confirm: "yes" }]) {
      const r = refusal(() => run({ action: "delete_all", ...extra }));
      expect(r.status).toBe(400);
      expect(r.message).toMatch(/confirm: true/);
    }
    expect(run({ action: "list" }).initiatives).toHaveLength(1);
  });

  it("keeps people apart: the viewer's owner key is the agent's owner key", () => {
    publish();
    expect(run({ action: "list" }, device(OTHER, "dev-2")).initiatives).toEqual([]);
    expect(refusal(() => run({ action: "list", id: "billing-export" }, device(OTHER, "dev-2"))).status).toBe(404);
    expect(run({ action: "remove", id: "billing-export" }, device(OTHER, "dev-2"))).toEqual({ removed: false });
    expect(cc.ccView(OTHER).records).toEqual([]);
    expect(cc.ccView(OWNER).records.map((r) => r.id)).toEqual(["billing-export"]);
  });

  it("rate limits at 20 at once and answers 429 with the wait", () => {
    for (let i = 0; i < 20; i++) run({ action: "list" });
    const r = refusal(() => run({ action: "list" }));
    expect(r.status).toBe(429);
    expect(r.message).toMatch(/at most 60 a minute, 20 at once/);
  });

  it("runs prepare only after every gate passes", async () => {
    const prepare = vi.fn((a: Record<string, unknown>) => a);
    const go = (actor: Parameters<Cc["runCommandCenter"]>[0] = ME) => refusal(() => cc.runCommandCenter(actor, { action: "list" }, "mcp", ORIGIN, prepare));
    expect(go({ id: OWNER, email: OWNER, name: "Owner One", source: "header" } as never).status).toBe(403);
    process.env.BAB_COMMAND_CENTER = "0";
    (await import("../lib/config"))._resetConfigForTests();
    expect(go().status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
    delete process.env.BAB_COMMAND_CENTER;
    (await import("../lib/config"))._resetConfigForTests();
    expect(cc.runCommandCenter(ME, { action: "list" }, "mcp", ORIGIN, prepare)).toMatchObject({ initiatives: [] });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("is 404 when switched off on the server; more replicas no longer refuse it", async () => {
    process.env.BAB_COMMAND_CENTER = "0";
    (await import("../lib/config"))._resetConfigForTests();
    expect(refusal(() => run({ action: "list" })).status).toBe(404);
    process.env.BAB_COMMAND_CENTER = "1";
    process.env.BAB_REPLICAS = "2";
    (await import("../lib/config"))._resetConfigForTests();
    expect(run({ action: "list" }).initiatives).toEqual([]);
  });
});

describe("derived flags and the live view", () => {
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

  it("paused hides questions and counts nothing as stale or silent, and stays on the page", () => {
    publish({ priority: "paused" });
    vi.setSystemTime(NOW + 20 * DAY);
    const v = cc.ccView(OWNER);
    expect(v.needsYou).toEqual([]);
    expect(v.records.map((r) => r.id)).toEqual(["billing-export"]);
    expect(v.dataHealth).toEqual({ staleQuestions: 0, silentInitiatives: 0, recurringWithoutHealth: 0, overdueRecurring: 0 });
  });

  it("the page drops done, parked and silent ones; list keeps them; the store deletes active and done ones 30 days after the last write", () => {
    publish({ worked: "work on it" });
    publish({ id: "old-done", state: "done", questions: [] });
    publish({ id: "parked-one", state: "parked", questions: [] });
    let v = cc.ccView(OWNER);
    expect(v.records.map((r) => r.id)).toEqual(["billing-export"]);
    expect(v.offPage).toBe(2);
    expect(v.records[0].log.map((e) => e.kind)).toContain("worked");
    vi.setSystemTime(NOW + 15 * DAY);
    v = cc.ccView(OWNER);
    expect(v.records).toEqual([]);
    expect(v.offPage).toBe(3);
    expect(v.dataHealth.silentInitiatives).toBe(1);
    expect((run({ action: "list" }).initiatives as unknown[]).length).toBe(3);
    vi.setSystemTime(NOW + 31 * DAY);
    cc.sweepCommandCenter();
    // The parked one stays longer (CC_SET_ASIDE_KEEP_MS).
    expect((run({ action: "list" }).initiatives as { id: string }[]).map((i) => i.id)).toEqual(["parked-one"]);
    expect(cc.ccLogOf(OWNER).some((e) => e.text === "work on it")).toBe(true);
  });

  it("counts recurring without health, sorts by priority", () => {
    publish({ id: "upkeep", kind: "recurring", tasks: [], questions: [] });
    publish({ id: "low-one", priority: "low", questions: [] });
    publish({ id: "urgent-one", priority: "urgent", questions: [] });
    publish({ id: "done-one", state: "done", questions: [] });
    const v = cc.ccView(OWNER);
    expect(v.dataHealth.recurringWithoutHealth).toBe(1);
    // Projects first (by status, then priority), then recurring upkeep.
    expect(v.records.map((r) => r.id)).toEqual(["urgent-one", "low-one", "upkeep"]);
    expect(cc.ccGet(OWNER, "done-one").progress).toBe(100);
  });

  it("the stamp changes when a worked line is logged on an unchanged record", () => {
    publish();
    const a = cc.ccView(OWNER).stamp;
    publish({ worked: "answered" });
    expect(cc.ccView(OWNER).stamp).not.toBe(a);
  });
});

describe("one store: SQLite", () => {
  it("survives a restart of the process", () => {
    publish({ worked: "kept" });
    cc._resetCommandCenterForTests();
    expect(cc.ccGet(OWNER, "billing-export")).toMatchObject({ seq: 1, title: "Billing export" });
    expect(cc.ccLogOf(OWNER).some((e) => e.text === "kept")).toBe(true);
  });

  it("writes no snapshot and no lease file", () => {
    publish();
    expect(existsSync(cc.ccSnapshotPath())).toBe(false);
    expect(existsSync(path.join(dataDir, "kv.lease"))).toBe(false);
  });
});

/** A v2 snapshot record, as lib/command-center.ts v2.19 wrote it. */
function v2Record(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date(NOW - DAY).toISOString();
  return {
    v: 1,
    id,
    title: `Title ${id}`,
    area: "finance",
    key: "KEY-1",
    state: "active",
    kind: "project",
    cadence: null,
    deadline: null,
    priority: null,
    tasks: [{ id: "t1", text: "Task", status: "in_progress", startedAt: at, finishedAt: null }],
    questions: [{ id: "q1", text: "Ask?", options: [], askedAt: at, clearedAt: null, session: "s-1" }],
    health: null,
    comments: [
      { id: "n1", text: "woken 10:30", at },
      { id: "n2", text: "second note", at: new Date(NOW - HOUR).toISOString() },
    ],
    links: [],
    source: { machine: "laptop-1", session: "s-1" },
    updatedAt: at,
    seq: 4,
    publishedBy: "device:dev-1",
    writers: [{ session: "s-1", at }],
    ...extra,
  };
}

function writeSnapshot(owners: Record<string, unknown[]>): void {
  writeFileSync(path.join(dataDir, "command-center-snapshot.json"), JSON.stringify({ version: 1, savedAt: new Date(NOW).toISOString(), owners }));
}

describe("the one-time import of a v2 snapshot", () => {
  it("moves records into SQLite, turns comments into notes, keeps seq and leaves the file byte-identical", () => {
    writeSnapshot({ [OWNER]: [v2Record("alpha"), v2Record("beta")] });
    const before = readFileSync(cc.ccSnapshotPath());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(cc.importCommandCenterSnapshot()).toEqual({ imported: 2, skipped: 0, dropped: 0, notes: 4 });
    log.mockRestore();
    // Untouched, so a rollback to v2.19 still reads it; nothing is renamed.
    expect(readFileSync(cc.ccSnapshotPath()).equals(before)).toBe(true);
    expect(existsSync(cc.ccImportedSnapshotPath())).toBe(false);
    expect(cc.ccGet(OWNER, "alpha")).toMatchObject({ seq: 4, title: "Title alpha", key: "KEY-1", questions: [{ id: "q1" }] });
    expect((cc.ccGet(OWNER, "alpha") as unknown as Record<string, unknown>).comments).toBeUndefined();
    const notes = cc.ccLogOf(OWNER).filter((e) => e.initiative === "alpha");
    expect(notes.map((e) => [e.kind, e.text, e.source])).toEqual([
      ["note", "woken 10:30", "import"],
      ["note", "second note", "import"],
    ]);
    // The next publish continues from the imported seq.
    expect(cc.ccPublish(ME, OWNER, record({ id: "alpha", title: "Title alpha", expectSeq: 4 }), "mcp")).toMatchObject({ seq: 5 });
    // Nothing left to import: a second run is a no-op.
    expect(cc.importCommandCenterSnapshot()).toBeNull();
  });

  it("runs on first use and drops broken or duplicated entries; nobody is dropped for an old switch", () => {
    writeSnapshot({
      [OWNER]: [v2Record("alpha"), v2Record("alpha"), v2Record("broken", { links: [{ label: "x", url: "javascript:1" }] }), v2Record("future", { updatedAt: new Date(NOW + 2 * DAY).toISOString() })],
      [OTHER]: [v2Record("theirs")],
      "bad/owner": [v2Record("x")],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(run({ action: "list" }).initiatives).toHaveLength(1);
    expect(log.mock.calls.some((c) => String(c[0]).includes("2 records") && String(c[0]).includes("4 dropped"))).toBe(true);
    log.mockRestore();
    expect(cc.ccList(OTHER).initiatives.map((r) => r.id)).toEqual(["theirs"]);
  });

  it("leaves a file that is not JSON in place and starts empty", () => {
    writeFileSync(cc.ccSnapshotPath(), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(run({ action: "list" }).initiatives).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(existsSync(cc.ccSnapshotPath())).toBe(true);
  });

  it("a restart does not import the same file again, quietly: removed records stay removed", () => {
    writeSnapshot({ [OWNER]: [v2Record("alpha")] });
    const before = readFileSync(cc.ccSnapshotPath());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cc.importCommandCenterSnapshot();
    log.mockRestore();
    run({ action: "remove", id: "alpha" });
    // A restart: the process forgets it imported; the file is still there, unchanged.
    cc._resetCommandCenterForTests();
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(cc.importCommandCenterSnapshot()).toBeNull();
    expect(run({ action: "list" }).initiatives).toEqual([]);
    expect(quiet).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    quiet.mockRestore();
    warn.mockRestore();
    expect(readFileSync(cc.ccSnapshotPath()).equals(before)).toBe(true);
  });

  it("deletes the snapshot 30 days after the import while its sha256 is the imported one", () => {
    writeSnapshot({ [OWNER]: [v2Record("alpha")] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cc.importCommandCenterSnapshot();
    log.mockRestore();
    cc.sweepCommandCenter(NOW + 29 * DAY);
    expect(existsSync(cc.ccSnapshotPath())).toBe(true);
    cc.sweepCommandCenter(NOW + 31 * DAY);
    expect(existsSync(cc.ccSnapshotPath())).toBe(false);
  });

  it("never deletes a snapshot rewritten after the import; it gets its own window once imported", () => {
    writeSnapshot({ [OWNER]: [v2Record("alpha")] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cc.importCommandCenterSnapshot();
    cc.sweepCommandCenter(NOW + DAY); // hashes the imported file once
    // A rolled-back v2.19 rewrites it with the same size; move the mtime as a real write would.
    writeSnapshot({ [OWNER]: [v2Record("alpha", { title: "Title alphb" })] });
    utimesSync(cc.ccSnapshotPath(), new Date(NOW + 2 * DAY), new Date(NOW + 2 * DAY));
    cc.sweepCommandCenter(NOW + 31 * DAY);
    cc.sweepCommandCenter(NOW + 60 * DAY);
    expect(existsSync(cc.ccSnapshotPath())).toBe(true);
    // The next v3 start imports it, and its own 30 days start then.
    cc._resetCommandCenterForTests();
    expect(cc.importCommandCenterSnapshot(NOW + 60 * DAY)).not.toBeNull();
    log.mockRestore();
    cc.sweepCommandCenter(NOW + 70 * DAY);
    expect(existsSync(cc.ccSnapshotPath())).toBe(true);
    cc.sweepCommandCenter(NOW + 91 * DAY);
    expect(existsSync(cc.ccSnapshotPath())).toBe(false);
  });

  it("imports new initiatives from a rewritten snapshot and never overwrites ones already in SQLite", () => {
    writeSnapshot({ [OWNER]: [v2Record("alpha")] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cc.importCommandCenterSnapshot();
    const alpha = cc.ccGet(OWNER, "alpha");
    const alphaLog = cc.ccLogOf(OWNER);
    // On v2.19 after a rollback: alpha changed (title, seq, a new comment) and gamma is new.
    writeSnapshot({
      [OWNER]: [
        v2Record("alpha", { title: "Changed on v2", seq: 9, comments: [{ id: "n9", text: "written on v2", at: new Date(NOW - HOUR).toISOString() }] }),
        v2Record("gamma"),
      ],
    });
    cc._resetCommandCenterForTests();
    expect(cc.importCommandCenterSnapshot()).toEqual({ imported: 1, skipped: 1, dropped: 0, notes: 2 });
    log.mockRestore();
    expect(cc.ccGet(OWNER, "alpha")).toEqual(alpha);
    expect(cc.ccLogOf(OWNER).filter((e) => e.initiative === "alpha")).toEqual(alphaLog);
    expect(cc.ccGet(OWNER, "gamma")).toMatchObject({ title: "Title gamma", seq: 4 });
  });

  it("deletes a command-center-snapshot.imported.json left by an earlier build after the window", () => {
    writeSnapshot({ [OWNER]: [v2Record("alpha")] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cc.importCommandCenterSnapshot();
    log.mockRestore();
    writeFileSync(cc.ccImportedSnapshotPath(), "{}");
    cc.sweepCommandCenter(NOW + 29 * DAY);
    expect(existsSync(cc.ccImportedSnapshotPath())).toBe(true);
    cc.sweepCommandCenter(NOW + 31 * DAY);
    expect(existsSync(cc.ccImportedSnapshotPath())).toBe(false);
  });

  it("normalizes imported times, drops future note times, and checks a joined comment as one line", () => {
    const at = new Date(NOW - DAY).toISOString();
    writeSnapshot({
      [OWNER]: [
        v2Record("alpha", {
          comments: [
            { id: "n1", text: "kept", at: "2026-03-01T10:00:00+02:00" },
            { id: "n2", text: "from the future", at: new Date(NOW + 5 * DAY).toISOString() },
            { id: "n3", text: "not a time", at: "Sunday" },
            { id: "n4", text: "two\nlines", at },
          ],
        }),
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cc.importCommandCenterSnapshot();
    log.mockRestore();
    const notes = cc.ccLogOf(OWNER).filter((e) => e.kind === "note");
    expect(notes.map((e) => [e.text, e.at]).sort()).toEqual([
      ["from the future", at],
      ["kept", "2026-03-01T08:00:00.000Z"],
      ["not a time", at],
      ["two lines", at],
    ]);
  });

  it("the replica that loses the import race imports nothing and says another process did it", async () => {
    const { getDb } = await import("../lib/db");
    writeSnapshot({ [OWNER]: [v2Record("alpha")] });
    // Another replica commits the same sha256 between this one's check and its insert.
    getDb().exec(
      "CREATE TEMP TRIGGER cc_race BEFORE INSERT ON command_center_imports BEGIN INSERT OR IGNORE INTO command_center_imports (sha256, imported_at) VALUES (NEW.sha256, NEW.imported_at); END;",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(cc.importCommandCenterSnapshot()).toBeNull();
    expect(log.mock.calls.some((c) => String(c[0]).includes("imported by another process"))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    getDb().exec("DROP TRIGGER cc_race");
    // Left in place for the replica that imported it, and never imported here.
    expect(existsSync(cc.ccSnapshotPath())).toBe(true);
    expect(cc.ccLogOf(OWNER)).toEqual([]);
    expect(run({ action: "list" }).initiatives).toEqual([]);
  });

  it("never overwrites a record already in SQLite", () => {
    publish({ id: "alpha", title: "Newer", questions: [] });
    writeSnapshot({ [OWNER]: [v2Record("alpha")] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(cc.importCommandCenterSnapshot()).toMatchObject({ imported: 0, skipped: 1 });
    log.mockRestore();
    expect(cc.ccGet(OWNER, "alpha")).toMatchObject({ title: "Newer", seq: 1 });
  });
});

describe("migration v54", () => {
  it("rewinds: tables come back, a re-import of the untouched file gives the same data and no duplicates", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    writeSnapshot({ [OWNER]: [v2Record("alpha")] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cc.importCommandCenterSnapshot();
    const first = { record: cc.ccGet(OWNER, "alpha"), log: cc.ccLogOf(OWNER) };
    // Rewind to v53: the version row and the v3 tables gone; the snapshot was never moved.
    const db = getDb();
    db.prepare("DELETE FROM migrations WHERE version >= 54").run();
    db.exec("DROP TABLE command_center_initiatives; DROP TABLE command_center_log; DROP TABLE command_center_export_grants; DROP TABLE command_center_imports;");
    _resetDbForTests();
    cc._resetCommandCenterForTests();
    const again = getDb();
    expect(again.prepare("SELECT 1 FROM migrations WHERE version = 54").get()).toBeTruthy();
    const tables = (again.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'command_center_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    // command_center_backfill_links is v55's (dropped versions >= 54 above, so it runs again too).
    expect(tables).toEqual(["command_center_backfill_links", "command_center_export_grants", "command_center_imports", "command_center_initiatives", "command_center_log"]);
    cc.importCommandCenterSnapshot();
    expect(cc.ccGet(OWNER, "alpha")).toEqual(first.record);
    expect(cc.ccLogOf(OWNER)).toEqual(first.log);
    // A rerun of the migration and of the import changes nothing.
    again.prepare("DELETE FROM migrations WHERE version >= 54").run();
    _resetDbForTests();
    cc.importCommandCenterSnapshot();
    expect(cc.ccLogOf(OWNER)).toEqual(first.log);
    log.mockRestore();
  });

  it("a database at v54 without command_center_imports still serves publish and list, and logs it once", async () => {
    const { getDb } = await import("../lib/db");
    // An early v54 build created no command_center_imports; the imported file is still there.
    getDb().exec("DROP TABLE command_center_imports");
    writeFileSync(cc.ccImportedSnapshotPath(), "{}");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(publish()).toMatchObject({ seq: 1 });
    expect(run({ action: "list" }).initiatives).toHaveLength(1);
    cc.sweepCommandCenter(NOW + 31 * DAY);
    cc.sweepCommandCenter(NOW + 32 * DAY);
    const missing = warn.mock.calls.filter((c) => String(c[0]).includes("command_center_imports"));
    warn.mockRestore();
    expect(missing).toHaveLength(1);
    expect(existsSync(cc.ccImportedSnapshotPath())).toBe(true);
  });

  it("keeps the v53 opt-in columns (no longer read) across a rewind", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const at = new Date(NOW).toISOString();
    getDb().prepare("UPDATE users SET command_center_enabled_at = ? WHERE id = ?").run(at, OWNER);
    getDb().prepare("DELETE FROM migrations WHERE version >= 53").run();
    _resetDbForTests();
    const cols = (getDb().prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["command_center_enabled_at", "command_center_disabled_at"]));
    expect((getDb().prepare("SELECT command_center_enabled_at AS e FROM users WHERE id = ?").get(OWNER) as { e: string }).e).toBe(at);
  });
});
