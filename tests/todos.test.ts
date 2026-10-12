import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-todos-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seedUser() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "owner-1", email: "a@example.com", name: "Ada", roles: [] });
}

describe("todos.create / listMine", () => {
  it("redacts a secret token in the body", async () => {
    await seedUser();
    const { create } = await import("../lib/todos");
    const t = create({
      ownerId: "owner-1",
      title: "Rotate creds",
      body: "Use Bearer abc123.def456-ghi to call the API",
    });
    expect(t.body).toContain("[redacted]");
    expect(t.body).not.toContain("abc123");
  });

  it("masks a pasted bab_ token in the title and body", async () => {
    await seedUser();
    const { create } = await import("../lib/todos");
    // Assembled at runtime so no token-shaped literal sits in the repo.
    const tok = ["bab", "_", "Zk3Qm9xT2vLw7RnB0cYdHf5sJgA8uEoP1iNtXzV4yKe"].join("");
    const t = create({ ownerId: "owner-1", title: `use ${tok}`, body: `my token is ${tok} ok` });
    expect(t.title).not.toContain(tok.slice(4, 20));
    expect(t.body).not.toContain(tok.slice(4, 20));
    expect(t.body).toContain("[redacted]");
  });

  it("creates a todo and lists it as open", async () => {
    await seedUser();
    const { create, listMine } = await import("../lib/todos");
    const t = create({ ownerId: "owner-1", title: "Re-enable alert filter" });
    expect(t.status).toBe("open");

    const open = listMine("owner-1", "open");
    expect(open.map((x) => x.id)).toContain(t.id);
  });

  it("separates overdue from due-soon", async () => {
    await seedUser();
    const { create, listMine } = await import("../lib/todos");
    const { addDaysUtc, todayUtc } = await import("../lib/dates");

    const yesterday = addDaysUtc(todayUtc(), -1);
    const inThreeDays = addDaysUtc(todayUtc(), 3);
    const inThirtyDays = addDaysUtc(todayUtc(), 30);

    const overdueTodo = create({ ownerId: "owner-1", title: "Overdue one", dueAt: yesterday });
    const soonTodo = create({ ownerId: "owner-1", title: "Due soon one", dueAt: inThreeDays });
    create({ ownerId: "owner-1", title: "Far out one", dueAt: inThirtyDays });

    const overdue = listMine("owner-1", "overdue");
    expect(overdue.map((x) => x.id)).toEqual([overdueTodo.id]);

    const dueSoon = listMine("owner-1", "due_soon");
    expect(dueSoon.map((x) => x.id)).toEqual([soonTodo.id]);
  });

  it("due_soon is a 14-day window (DUE_SOON_DAYS), inclusive of today and the 14-day boundary", async () => {
    await seedUser();
    const { create, listMine, DUE_SOON_DAYS } = await import("../lib/todos");
    const { addDaysUtc, todayUtc } = await import("../lib/dates");
    expect(DUE_SOON_DAYS).toBe(14);

    const today = todayUtc();
    const boundary = addDaysUtc(today, 14);
    const justPast = addDaysUtc(today, 15);

    const dueToday = create({ ownerId: "owner-1", title: "Due today", dueAt: today });
    const dueAtBoundary = create({ ownerId: "owner-1", title: "Due at boundary", dueAt: boundary });
    create({ ownerId: "owner-1", title: "Due just past boundary", dueAt: justPast });

    const dueSoon = listMine("owner-1", "due_soon").map((x) => x.id);
    expect(dueSoon).toContain(dueToday.id);
    expect(dueSoon).toContain(dueAtBoundary.id);
    expect(dueSoon.length).toBe(2);
  });
});

describe("todos lifecycle", () => {
  it("completes a todo", async () => {
    await seedUser();
    const { create, complete, getById } = await import("../lib/todos");
    const t = create({ ownerId: "owner-1", title: "Ship it" });
    complete(t.id, "owner-1");
    expect(getById(t.id)!.status).toBe("done");
  });

  it("snoozing an overdue todo moves it a week past today, not past its old date", async () => {
    await seedUser();
    const { create, snooze } = await import("../lib/todos");
    const t = create({ ownerId: "owner-1", title: "Long overdue", dueAt: "2026-01-01" });

    const snoozed = snooze(t.id, "owner-1");
    const today = new Date().toISOString().slice(0, 10);
    const expected = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    expect(snoozed.due_at!.slice(0, 10)).toBe(expected);
  });

  it("snoozes a todo by 7 calendar days and keeps it open", async () => {
    await seedUser();
    const { create, snooze, getById } = await import("../lib/todos");
    const dueAt = new Date().toISOString().slice(0, 10); // date-only, as the date input sends
    const t = create({ ownerId: "owner-1", title: "Follow up", dueAt });

    const snoozed = snooze(t.id, "owner-1");
    expect(snoozed.status).toBe("open");

    const newDue = new Date(`${snoozed.due_at!}T00:00:00Z`).getTime();
    const oldDue = new Date(`${dueAt}T00:00:00Z`).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(newDue - oldDue).toBe(sevenDaysMs);
    expect(getById(t.id)!.status).toBe("open");
  });

  it("abandons a todo", async () => {
    await seedUser();
    const { create, abandon, getById } = await import("../lib/todos");
    const t = create({ ownerId: "owner-1", title: "Nope" });
    abandon(t.id, "owner-1");
    expect(getById(t.id)!.status).toBe("abandoned");
  });
});

describe("todos explicit no-op signalling (409 instead of silent success)", () => {
  it("completing an already-done todo 409s with a status-specific message", async () => {
    await seedUser();
    const { create, complete } = await import("../lib/todos");
    const { ConflictError } = await import("../lib/errors");
    const t = create({ ownerId: "owner-1", title: "Ship it" });
    complete(t.id, "owner-1");

    expect(() => complete(t.id, "owner-1")).toThrow(ConflictError);
    expect(() => complete(t.id, "owner-1")).toThrow(/already done/i);
  });

  it("completing an already-abandoned todo 409s", async () => {
    await seedUser();
    const { create, complete, abandon } = await import("../lib/todos");
    const { ConflictError } = await import("../lib/errors");
    const t = create({ ownerId: "owner-1", title: "Ship it" });
    abandon(t.id, "owner-1");

    expect(() => complete(t.id, "owner-1")).toThrow(ConflictError);
    expect(() => complete(t.id, "owner-1")).toThrow(/already abandoned/i);
  });

  it("abandoning an already-done todo 409s", async () => {
    await seedUser();
    const { create, complete, abandon } = await import("../lib/todos");
    const { ConflictError } = await import("../lib/errors");
    const t = create({ ownerId: "owner-1", title: "Ship it" });
    complete(t.id, "owner-1");

    expect(() => abandon(t.id, "owner-1")).toThrow(ConflictError);
  });

  it("snoozing an already-done todo 409s", async () => {
    await seedUser();
    const { create, complete, snooze } = await import("../lib/todos");
    const { ConflictError } = await import("../lib/errors");
    const t = create({ ownerId: "owner-1", title: "Ship it" });
    complete(t.id, "owner-1");

    expect(() => snooze(t.id, "owner-1")).toThrow(ConflictError);
    expect(() => snooze(t.id, "owner-1")).toThrow(/already done/i);
  });

  it("snoozing an already-abandoned todo re-opens it (not a 409)", async () => {
    await seedUser();
    const { create, abandon, snooze, getById } = await import("../lib/todos");
    const t = create({ ownerId: "owner-1", title: "Ship it" });
    abandon(t.id, "owner-1");

    const snoozed = snooze(t.id, "owner-1");
    expect(snoozed.status).toBe("open");
    expect(getById(t.id)!.status).toBe("open");
  });
});

describe("todos ownership enforcement", () => {
  async function seedOtherUser() {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "intruder-1", email: "i@example.com", name: "Ivan", roles: [] });
  }

  it("rejects completing another user's todo and leaves it unchanged", async () => {
    await seedUser();
    await seedOtherUser();
    const { create, complete, getById } = await import("../lib/todos");
    const t = create({ ownerId: "owner-1", title: "Mine" });

    expect(() => complete(t.id, "intruder-1")).toThrow(/not found/i);
    expect(getById(t.id)!.status).toBe("open");
  });

  it("rejects snoozing another user's todo and leaves it unchanged", async () => {
    await seedUser();
    await seedOtherUser();
    const { create, snooze, getById } = await import("../lib/todos");
    const t = create({ ownerId: "owner-1", title: "Mine" });
    const before = getById(t.id)!;

    expect(() => snooze(t.id, "intruder-1")).toThrow(/not found/i);
    expect(getById(t.id)!.due_at).toBe(before.due_at);
    expect(getById(t.id)!.status).toBe("open");
  });

  it("rejects abandoning another user's todo and leaves it unchanged", async () => {
    await seedUser();
    await seedOtherUser();
    const { create, abandon, getById } = await import("../lib/todos");
    const t = create({ ownerId: "owner-1", title: "Mine" });

    expect(() => abandon(t.id, "intruder-1")).toThrow(/not found/i);
    expect(getById(t.id)!.status).toBe("open");
  });
});
