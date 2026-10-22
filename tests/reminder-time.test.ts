import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/** A time of day on reminders: dueAt as YYYY-MM-DD or an ISO date-time with an offset. */

const OWNER = "alice.example@example.com";
const FORM_ERROR =
  "dueAt must be YYYY-MM-DD, or an ISO 8601 date-time with an offset or Z, e.g. 2026-10-21T16:00:00-04:00";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-reminder-time-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

function setNow(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
}

async function seedUser() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Alice", roles: [] });
}

async function addTodo(dueAt: string, title = "Call back") {
  await seedUser();
  const { create } = await import("../lib/todos");
  return create({ ownerId: OWNER, title, dueAt });
}

describe("parseDueAt", () => {
  it("keeps a date-only value as it is", async () => {
    const { parseDueAt } = await import("../lib/dates");
    expect(parseDueAt("2026-10-21")).toEqual({ dueAt: "2026-10-21", hasTime: false });
  });

  it("stores a date-time with an offset as a UTC instant", async () => {
    const { parseDueAt } = await import("../lib/dates");
    expect(parseDueAt("2026-10-21T16:00:00-04:00")).toEqual({ dueAt: "2026-10-21T20:00:00Z", hasTime: true });
    expect(parseDueAt("2026-10-21T16:00+02:00")).toEqual({ dueAt: "2026-10-21T14:00:00Z", hasTime: true });
  });

  it("accepts Z", async () => {
    const { parseDueAt } = await import("../lib/dates");
    expect(parseDueAt("2026-10-21T16:00:00Z")).toEqual({ dueAt: "2026-10-21T16:00:00Z", hasTime: true });
  });

  it.each([
    "2026-10-21T16:00:00",
    "2026-10-21T16:00",
    "2026-10-21 16:00:00Z",
    "2026-10-21T25:00:00Z",
    "2026-10-21T16:61:00Z",
    "2026-02-30T10:00:00Z",
    "2026-10-21T16:00:00+25:00",
    "tomorrow 4pm",
    "",
  ])("rejects %j", async (value) => {
    const { parseDueAt } = await import("../lib/dates");
    expect(parseDueAt(value)).toBeNull();
  });

  it("rejects a value that is not a string", async () => {
    const { parseDueAt } = await import("../lib/dates");
    expect(parseDueAt(20261021)).toBeNull();
    expect(parseDueAt(null)).toBeNull();
  });
});

describe("create over REST and MCP", () => {
  it("lib create refuses a date-time with no offset and names the form", async () => {
    await seedUser();
    const { create } = await import("../lib/todos");
    expect(() => create({ ownerId: OWNER, title: "T", dueAt: "2026-10-21T16:00:00" })).toThrow(FORM_ERROR);
  });

  it("stores the instant and the flag; a date-only row has the flag off", async () => {
    const timed = await addTodo("2026-10-21T16:00:00-04:00");
    expect(timed.due_at).toBe("2026-10-21T20:00:00Z");
    expect(timed.due_has_time).toBe(1);
    const dateOnly = await addTodo("2026-10-21", "Day");
    expect(dateOnly.due_at).toBe("2026-10-21");
    expect(dateOnly.due_has_time).toBe(0);
  });

  it("POST /api/todos accepts an offset date-time and refuses one without", async () => {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": OWNER, "x-bab-actor-name": "Alice" }),
    }));
    await seedUser();
    const { POST } = await import("../app/api/todos/route");
    const mk = (dueAt: string) =>
      new Request("http://x/api/todos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "T", dueAt }),
      }) as never;
    const ok = await POST(mk("2026-10-21T16:00:00-04:00"));
    expect(ok.status).toBe(201);
    expect((await ok.json()).todo.due_at).toBe("2026-10-21T20:00:00Z");
    const bad = await POST(mk("2026-10-21T16:00:00"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: FORM_ERROR });
    vi.doUnmock("next/headers");
  });

  it("bab_remind create takes a timed dueAt and refuses one with no offset", async () => {
    const { TOOLS } = await import("../lib/mcp");
    const tool = TOOLS.find((t) => t.name === "bab_remind")!;
    await seedUser();
    const actor = { id: OWNER, email: OWNER, name: "Alice", roles: [], source: "declared" } as never;
    const made = JSON.parse(
      await tool.run(actor, { action: "create", title: "T", dueAt: "2026-10-21T16:00:00-04:00" }),
    );
    expect(made.todo.due_at).toBe("2026-10-21T20:00:00Z");
    await expect(
      Promise.resolve().then(() => tool.run(actor, { action: "create", title: "T", dueAt: "2026-10-21T16:00:00" })),
    ).rejects.toThrow(FORM_ERROR);
  });
});

describe("due logic", () => {
  it("a timed reminder is not overdue before its instant, and is at it", async () => {
    await addTodo("2026-10-21T16:00:00Z");
    const { listMine } = await import("../lib/todos");

    setNow("2026-10-21T15:59:59Z");
    expect(listMine(OWNER, "overdue")).toHaveLength(0);
    expect(listMine(OWNER, "due_soon")).toHaveLength(1);

    setNow("2026-10-21T16:00:00Z");
    expect(listMine(OWNER, "overdue")).toHaveLength(1);
    expect(listMine(OWNER, "due_soon")).toHaveLength(0);
  });

  it("a date-only reminder stays due for its whole day and is overdue the day after", async () => {
    await addTodo("2026-10-21");
    const { listMine } = await import("../lib/todos");

    setNow("2026-10-21T23:59:59Z");
    expect(listMine(OWNER, "overdue")).toHaveLength(0);
    expect(listMine(OWNER, "due_soon")).toHaveLength(1);

    setNow("2026-10-22T00:00:00Z");
    expect(listMine(OWNER, "overdue")).toHaveLength(1);
  });

  it("the Reminders page groups use the time", async () => {
    await addTodo("2026-10-21T16:00:00Z", "Timed");
    const { remindersFor } = await import("../lib/reminders-view");

    setNow("2026-10-21T10:00:00Z");
    let groups = remindersFor(OWNER);
    expect(groups.dueSoon.map((t) => t.title)).toEqual(["Timed"]);
    expect(groups.overdue).toHaveLength(0);

    setNow("2026-10-21T17:00:00Z");
    groups = remindersFor(OWNER);
    expect(groups.overdue.map((t) => t.title)).toEqual(["Timed"]);
  });

  it("the chip says overdue once a timed reminder has passed, even on its own day", async () => {
    const { formatDueDate } = await import("../lib/reminders-view");
    const at = "2026-10-21T16:00:00Z";
    const now = Date.parse("2026-10-21T17:00:00Z");
    expect(formatDueDate(at, "2026-10-21", true, now)).toBe("overdue");
    expect(formatDueDate(at, "2026-10-21", true, Date.parse("2026-10-21T10:00:00Z"))).toBe("due today");
    expect(formatDueDate("2026-10-21", "2026-10-21", false, now)).toBe("due today");
  });
});

describe("the hook's due-reminder notice", () => {
  async function linkSession(sessionId: string) {
    await seedUser();
    const { mintOrReuseLinkToken, redeemLinkToken } = await import("../lib/session-links");
    redeemLinkToken(mintOrReuseLinkToken(sessionId), OWNER);
  }
  async function prompt(sessionId: string) {
    const { POST } = await import("../app/api/hook/route");
    const res = await POST(
      new Request("https://bab.example.com/api/hook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId }),
      }),
    );
    return res.json();
  }

  it("announces a timed reminder after its time, once, and never before", async () => {
    await linkSession("sess-1");
    const todo = await addTodo("2026-10-21T16:00:00-04:00", "Secret title");

    setNow("2026-10-21T19:59:00Z");
    expect(await prompt("sess-1")).toEqual({});

    setNow("2026-10-21T20:00:00Z");
    const first = await prompt("sess-1");
    expect(first.hookSpecificOutput.additionalContext).toContain("1 reminder due");
    expect(first.hookSpecificOutput.additionalContext).not.toContain(todo.title);

    setNow("2026-10-21T20:30:00Z");
    expect(await prompt("sess-1")).toEqual({});
  });

  it("snoozing a timed reminder re-arms the notice", async () => {
    await linkSession("sess-1");
    const todo = await addTodo("2026-10-21T20:00:00Z");

    setNow("2026-10-21T20:05:00Z");
    expect((await prompt("sess-1")).hookSpecificOutput.additionalContext).toContain("1 reminder due");
    expect(await prompt("sess-1")).toEqual({});

    const { snooze, getById } = await import("../lib/todos");
    snooze(todo.id, OWNER, "mcp");
    const snoozed = getById(todo.id)!;
    expect(snoozed.due_at).toBe("2026-10-28T20:05:00Z");
    expect(snoozed.due_has_time).toBe(1);
    expect(await prompt("sess-1")).toEqual({});

    setNow("2026-10-28T20:06:00Z");
    expect((await prompt("sess-1")).hookSpecificOutput.additionalContext).toContain("1 reminder due");
  });

  it("snooze with a dueAt moves to exactly that time, and may drop the time", async () => {
    const todo = await addTodo("2026-10-21T20:00:00Z");
    const { snooze } = await import("../lib/todos");
    setNow("2026-10-21T20:05:00Z");
    const timed = snooze(todo.id, OWNER, "mcp", "2026-10-22T09:00:00+02:00");
    expect(timed.due_at).toBe("2026-10-22T07:00:00Z");
    expect(timed.due_has_time).toBe(1);
    const plain = snooze(todo.id, OWNER, "mcp", "2026-10-30");
    expect(plain.due_at).toBe("2026-10-30");
    expect(plain.due_has_time).toBe(0);
    expect(() => snooze(todo.id, OWNER, "mcp", "2026-10-30T09:00:00")).toThrow(FORM_ERROR);
  });

  it("date-only behaviour is unchanged: due from the start of its day, once, snooze +7 days", async () => {
    await linkSession("sess-1");
    const todo = await addTodo("2026-10-21");

    setNow("2026-10-20T23:59:00Z");
    expect(await prompt("sess-1")).toEqual({});

    setNow("2026-10-21T00:01:00Z");
    expect((await prompt("sess-1")).hookSpecificOutput.additionalContext).toContain("1 reminder due");
    expect(await prompt("sess-1")).toEqual({});

    const { snooze } = await import("../lib/todos");
    const snoozed = snooze(todo.id, OWNER, "mcp");
    expect(snoozed.due_at).toBe("2026-10-28");
    expect(snoozed.due_has_time).toBe(0);
  });
});

describe("POST /api/todos/:id/snooze body", () => {
  async function snoozeWith(body: string | undefined) {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": OWNER, "x-bab-actor-name": "Alice" }),
    }));
    const todo = await addTodo("2030-01-01");
    const { POST } = await import("../app/api/todos/[id]/snooze/route");
    const res = await POST(
      new Request(`http://x/api/todos/${todo.id}/snooze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }) as never,
      { params: Promise.resolve({ id: todo.id }) },
    );
    vi.doUnmock("next/headers");
    const { getById } = await import("../lib/todos");
    return { res, after: getById(todo.id)! };
  }

  it("400s on a body that is not valid JSON and leaves the reminder alone", async () => {
    const { res, after } = await snoozeWith("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Body must be a JSON object" });
    expect(after.due_at).toBe("2030-01-01");
  });

  it("400s on JSON that is not an object", async () => {
    expect((await snoozeWith("[1]")).res.status).toBe(400);
  });

  it("an empty body is the default snooze", async () => {
    const empty = await snoozeWith(undefined);
    expect(empty.res.status).toBe(200);
    expect(empty.after.due_at).not.toBe("2030-01-01");
  });
});

describe("migration v48", () => {
  it("re-running v48 on a database that already has the column keeps existing rows date-only", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    await seedUser();
    getDb()
      .prepare("INSERT INTO todos (id, owner_id, title, due_at) VALUES ('t1', ?, 'Old', '2026-01-01')")
      .run(OWNER);
    getDb().exec("DELETE FROM migrations WHERE version = 48");
    _resetDbForTests();
    const row = (await import("../lib/db")).getDb().prepare("SELECT due_has_time FROM todos WHERE id = 't1'").get() as {
      due_has_time: number;
    };
    expect(row.due_has_time).toBe(0);
  });
});
