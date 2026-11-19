import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Evidence on a BAB Tasks to-do: up to 3 { label, url } links, validated like the record's links,
 * optional, kept through patch, and read back by list and by the stored-record parser.
 */

let dataDir: string;
const OWNER = "owner.one@example.com";
const ORIGIN = "https://bab.example.com";
const NOW = Date.parse("2026-03-02T10:00:00Z");
const PR = { label: "PR", url: "https://git.example.com/acme/x/pull/1" };
const RUN = { label: "Tests", url: "https://ci.example.com/acme/x/runs/7" };

type Cc = typeof import("../lib/tasks");
let cc: Cc;

const ME = { id: OWNER, email: OWNER, name: "Some One", source: "device" as const, deviceId: "dev-1" };

function run(args: Record<string, unknown>) {
  return cc.runTasks(ME, args, "mcp", ORIGIN) as Record<string, unknown>;
}

function publish(tasks: unknown[]) {
  return run({ action: "publish", v: 1, id: "billing-export", title: "Billing export", tasks });
}

function patch(tasks: unknown[]) {
  return run({ action: "patch", id: "billing-export", tasks });
}

function refusal(fn: () => unknown): { status: number; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { status?: number; message: string };
    return { status: e.status ?? 0, message: e.message };
  }
  throw new Error("expected a refusal");
}

const stored = () => cc.ccGet(OWNER, "billing-export").tasks;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-cc-evidence-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  cc = await import("../lib/tasks");
  cc._resetTasksForTests();
  (await import("../lib/rate-limit")).resetForTests();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
});

afterEach(async () => {
  vi.useRealTimers();
  cc._resetTasksForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  (await import("../lib/config"))._resetConfigForTests();
  vi.resetModules();
});

describe("evidence on a to-do", () => {
  it("is stored with the task and returned by list with an id", () => {
    publish([{ id: "build", text: "Build it", status: "done", evidence: [PR, RUN] }, { id: "ship", text: "Ship it", status: "pending" }]);
    const got = run({ action: "list", id: "billing-export" }) as { tasks: { id: string; evidence?: unknown }[] };
    expect(got.tasks[0].evidence).toEqual([PR, RUN]);
    expect(got.tasks[1]).not.toHaveProperty("evidence");
  });

  it("is optional: a task without it, or with an empty list, stores no key", () => {
    publish([{ id: "a", text: "A", status: "done" }, { id: "b", text: "B", status: "done", evidence: [] }, { id: "c", text: "C", status: "done", evidence: null }]);
    for (const t of stored()) expect(t).not.toHaveProperty("evidence");
  });

  it("allows 3 links and refuses a fourth, naming the field", () => {
    const three = [PR, RUN, { label: "Doc", url: "https://example.com/doc" }];
    publish([{ id: "a", text: "A", status: "done", evidence: three }]);
    expect(stored()[0].evidence).toHaveLength(3);
    const four = [...three, { label: "More", url: "https://example.com/more" }];
    expect(refusal(() => publish([{ id: "a", text: "A", status: "done", evidence: four }])).message).toBe("tasks[0].evidence: at most 3 evidence links; you sent 4");
  });

  it("checks each link like links: https only, label and url shape, no unknown field", () => {
    const bad = (evidence: unknown) => refusal(() => publish([{ id: "a", text: "A", status: "done" }, { id: "b", text: "B", status: "done", evidence }]));
    expect(bad([{ label: "x", url: "http://example.com" }])).toMatchObject({ status: 400, message: "tasks[1].evidence[0].url must start with https://" });
    expect(bad([PR, { label: "x", url: "javascript:alert(1)" }]).message).toBe("tasks[1].evidence[1].url must start with https://");
    expect(bad([{ label: "x", url: "data:text/html,hi" }]).status).toBe(400);
    expect(bad([{ label: "x", url: "https://" }]).message).toBe("tasks[1].evidence[0].url is not a valid URL");
    expect(bad([{ label: "x", url: "https://example.com/" + "a".repeat(500) }]).message).toMatch(/evidence\[0\]\.url is \d+ characters; at most 500/);
    expect(bad([{ label: "l".repeat(61), url: PR.url }]).message).toMatch(/evidence\[0\]\.label is 61 characters; at most 60/);
    expect(bad([{ url: PR.url }]).message).toMatch(/evidence\[0\]\.label is required/);
    expect(bad([{ label: "x" }]).message).toBe("tasks[1].evidence[0].url must start with https://");
    expect(bad([{ ...PR, note: "hi" }]).message).toMatch(/unknown field 'tasks\[1\]\.evidence\[0\]\.note'/);
    expect(bad("https://example.com").message).toBe("tasks[1].evidence must be an array");
    expect(bad(["https://example.com"]).message).toBe("tasks[1].evidence[0] must be an object { label, url }");
  });

  it("refuses an unknown task field and lists evidence among the allowed ones", () => {
    expect(refusal(() => publish([{ id: "a", text: "A", status: "done", proof: [] }])).message).toBe("unknown field 'tasks[0].proof'; allowed: id, text, status, evidence");
  });

  it("refuses a secret in an evidence label or url and stores nothing", () => {
    const secret = "AKIA" + "ABCDEFGHIJKLMNOP";
    expect(refusal(() => publish([{ id: "a", text: "A", status: "done", evidence: [{ label: secret, url: PR.url }] }])).message).toMatch(/evidence\[0\]\.label holds/);
    expect(refusal(() => publish([{ id: "a", text: "A", status: "done", evidence: [{ label: "x", url: `https://example.com/?k=${secret}` }] }])).message).toMatch(/evidence\[0\]\.url holds/);
    expect(() => cc.ccGet(OWNER, "billing-export")).toThrow();
  });

  it("counts toward the record size limit", () => {
    const long = (i: number) => ({ label: "l".repeat(60), url: `https://example.com/${i}/` + "a".repeat(450) });
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, text: "T".repeat(120), status: "done", evidence: [long(i), long(i + 100), long(i + 200)] }));
    expect(refusal(() => publish(tasks)).status).toBe(413);
  });

  it("an existing record without evidence reads the same, and a replay of it is unchanged", () => {
    publish([{ id: "a", text: "A", status: "done" }]);
    const before = JSON.stringify(cc.ccGet(OWNER, "billing-export"));
    expect(publish([{ id: "a", text: "A", status: "done" }])).toMatchObject({ unchanged: true, seq: 1 });
    expect(publish([{ id: "a", text: "A", status: "done", evidence: [] }])).toMatchObject({ unchanged: true, seq: 1 });
    expect(JSON.stringify(cc.ccGet(OWNER, "billing-export"))).toBe(before);
  });

  it("adding evidence is a change; the same evidence again is a replay", () => {
    publish([{ id: "a", text: "A", status: "done" }]);
    expect(publish([{ id: "a", text: "A", status: "done", evidence: [PR] }])).toMatchObject({ seq: 2 });
    expect(publish([{ id: "a", text: "A", status: "done", evidence: [PR] }])).toMatchObject({ unchanged: true, seq: 2 });
  });
});

describe("patch and evidence", () => {
  it("sets evidence on one task and leaves the others and their times alone", () => {
    publish([{ id: "a", text: "A", status: "done" }, { id: "b", text: "B", status: "in_progress" }]);
    const before = stored();
    expect(patch([{ id: "a", evidence: [PR] }])).toMatchObject({ seq: 2 });
    const got = stored();
    expect(got[0]).toEqual({ ...before[0], evidence: [PR] });
    expect(got[1]).toEqual(before[1]);
  });

  it("keeps evidence when a patch changes only the status or text, and replaces it when sent", () => {
    publish([{ id: "a", text: "A", status: "in_progress", evidence: [PR, RUN] }]);
    patch([{ id: "a", status: "done" }]);
    expect(stored()[0]).toMatchObject({ status: "done", evidence: [PR, RUN] });
    patch([{ id: "a", evidence: [RUN] }]);
    expect(stored()[0].evidence).toEqual([RUN]);
  });

  it("clears evidence with an empty list or null", () => {
    publish([{ id: "a", text: "A", status: "done", evidence: [PR] }]);
    patch([{ id: "a", evidence: [] }]);
    expect(stored()[0]).not.toHaveProperty("evidence");
    patch([{ id: "a", evidence: [PR] }]);
    patch([{ id: "a", evidence: null }]);
    expect(stored()[0]).not.toHaveProperty("evidence");
  });

  it("adds a new task with evidence in one patch, and a publish that leaves it out clears it", () => {
    publish([{ id: "a", text: "A", status: "done" }]);
    patch([{ id: "b", text: "B", status: "done", evidence: [RUN] }]);
    expect(stored().map((t) => t.evidence)).toEqual([undefined, [RUN]]);
    publish([{ id: "a", text: "A", status: "done" }, { id: "b", text: "B", status: "done" }]);
    expect(stored().map((t) => t.evidence)).toEqual([undefined, undefined]);
  });

  it("refuses bad evidence in a patch like a publish, and stores nothing", () => {
    publish([{ id: "a", text: "A", status: "done" }]);
    expect(refusal(() => patch([{ id: "a", evidence: [{ label: "x", url: "http://example.com" }] }])).message).toBe("tasks[0].evidence[0].url must start with https://");
    expect(refusal(() => patch([{ id: "a", evidence: [PR, RUN, PR, RUN] }])).message).toMatch(/at most 3 evidence links/);
    expect(cc.ccGet(OWNER, "billing-export").seq).toBe(1);
  });

  it("reopening a done task with a status-only patch keeps its evidence", () => {
    publish([{ id: "a", text: "A", status: "done", evidence: [PR] }]);
    patch([{ id: "a", status: "in_progress" }]);
    expect(stored()[0]).toMatchObject({ status: "in_progress", finishedAt: null, evidence: [PR] });
    patch([{ id: "a", status: "done" }]);
    expect(stored()[0].evidence).toEqual([PR]);
  });

  it("reads evidence given as JSON text on the MCP path", () => {
    publish([{ id: "a", text: "A", status: "done" }]);
    cc.runTasksMcp(ME, { action: "patch", id: "billing-export", record: { tasks: JSON.stringify([{ id: "a", evidence: [PR] }]) } }, ORIGIN);
    expect(stored()[0].evidence).toEqual([PR]);
  });
});

describe("the v2 snapshot importer", () => {
  const at = new Date(NOW - 86_400_000).toISOString();
  function snapshotRecord(tasks: unknown[]): Record<string, unknown> {
    return {
      v: 1, id: "alpha", title: "Alpha", area: null, key: null, state: "active", kind: "project", cadence: null, deadline: null, priority: null,
      tasks, questions: [], health: null, comments: [], links: [], source: null, updatedAt: at, seq: 2, publishedBy: "device:dev-1", writers: [],
    };
  }
  function importOf(tasks: unknown[]) {
    writeFileSync(path.join(dataDir, "command-center-snapshot.json"), JSON.stringify({ version: 1, savedAt: new Date(NOW).toISOString(), owners: { [OWNER]: [snapshotRecord(tasks)] } }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = cc.importTasksSnapshot();
    log.mockRestore();
    return result;
  }

  it("loads a record without evidence unchanged", () => {
    expect(importOf([{ id: "t1", text: "Task", status: "done", startedAt: at, finishedAt: at }])).toMatchObject({ imported: 1, dropped: 0 });
    expect(cc.ccGet(OWNER, "alpha").tasks[0]).toEqual({ id: "t1", text: "Task", status: "done", startedAt: at, finishedAt: at });
  });

  it("keeps valid evidence", () => {
    expect(importOf([{ id: "t1", text: "Task", status: "done", evidence: [PR], startedAt: at, finishedAt: at }])).toMatchObject({ imported: 1 });
    expect(cc.ccGet(OWNER, "alpha").tasks[0].evidence).toEqual([PR]);
  });

  it("drops a record with a bad evidence url", () => {
    expect(importOf([{ id: "t1", text: "Task", status: "done", evidence: [{ label: "x", url: "http://example.com" }] }])).toMatchObject({ imported: 0, dropped: 1 });
  });
});

describe("the view", () => {
  it("carries evidence to the page data", () => {
    publish([{ id: "a", text: "A", status: "done", evidence: [PR] }]);
    expect(cc.ccView(OWNER).records[0].tasks[0].evidence).toEqual([PR]);
  });
});
