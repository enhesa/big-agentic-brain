import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-events-emission-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  const { _resetEventsForTests } = await import("../lib/events");
  _resetEventsForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

async function seedUser(id = "alice@example.com", name = "Alice") {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id, email: id, name, roles: [] });
}

describe("event emission from lib write paths", () => {
  it("learnings.create() emits learning.created", async () => {
    await seedUser();
    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    subscribe((e) => seen.push(e.type));

    const { create } = await import("../lib/learnings");
    create({ authorId: "alice@example.com", title: "T", body: "B", tags: [] });

    expect(seen).toContain("learning.created");
  });

  it("learnings.vote() emits vote", async () => {
    await seedUser("alice@example.com", "Alice");
    await seedUser("bob@example.com", "Bob");
    const { create, vote } = await import("../lib/learnings");
    const learning = create({ authorId: "alice@example.com", title: "T", body: "B", tags: [] });

    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    subscribe((e) => seen.push(e.type));

    vote(learning.id, "bob@example.com", "helpful");
    expect(seen).toEqual(["vote"]);
  });

  it("learnings.flag() emits flag, and learning.updated once auto-archived", async () => {
    await seedUser("alice@example.com", "Alice");
    await seedUser("bob@example.com", "Bob");
    await seedUser("carol@example.com", "Carol");
    const { create, flag } = await import("../lib/learnings");
    const learning = create({ authorId: "alice@example.com", title: "T", body: "B", tags: [] });

    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    subscribe((e) => seen.push(e.type));

    flag(learning.id, "bob@example.com");
    expect(seen).toEqual(["flag"]);

    flag(learning.id, "carol@example.com"); // 2nd distinct flag -> auto-archive
    expect(seen).toEqual(["flag", "flag", "learning.updated"]);
  });

  it("learnings.giveKudos() emits kudos", async () => {
    await seedUser("alice@example.com", "Alice");
    await seedUser("bob@example.com", "Bob");
    const { create, giveKudos } = await import("../lib/learnings");
    const learning = create({ authorId: "alice@example.com", title: "T", body: "B", tags: [] });

    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    subscribe((e) => seen.push(e.type));

    giveKudos(learning.id, "bob@example.com", null);
    expect(seen).toEqual(["kudos"]);
  });

  it("learnings.supersede() emits learning.updated for the retired learning", async () => {
    await seedUser("alice@example.com", "Alice");
    const { create, supersede } = await import("../lib/learnings");
    const oldOne = create({ authorId: "alice@example.com", title: "Old", body: "B", tags: [] });
    const newOne = create({
      authorId: "alice@example.com",
      title: "New",
      body: "B2",
      tags: [],
      supersedesId: oldOne.id,
    });

    const { subscribe } = await import("../lib/events");
    const seen: { type: string; id: string }[] = [];
    subscribe((e) => seen.push({ type: e.type, id: e.id }));

    supersede(newOne.id, oldOne.id, "alice@example.com");
    expect(seen).toEqual([{ type: "learning.updated", id: oldOne.id }]);
  });

  it("messages.send() emits message.created", async () => {
    await seedUser("alice@example.com", "Alice");
    await seedUser("bob@example.com", "Bob");
    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    subscribe((e) => seen.push(e.type));

    const { send } = await import("../lib/messages");
    send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Hi", body: "Hello" });

    expect(seen).toEqual(["message.created"]);
  });

  it("message.created never carries the subject or body (/api/events is served without SSO)", async () => {
    await seedUser("alice@example.com", "Alice");
    await seedUser("bob@example.com", "Bob");
    const { subscribe } = await import("../lib/events");
    const events: { payload: Record<string, unknown> }[] = [];
    subscribe((e) => events.push(e));

    const { send } = await import("../lib/messages");
    send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Salary review", body: "Confidential numbers" });

    expect(events).toHaveLength(1);
    const json = JSON.stringify(events[0].payload);
    expect(json).not.toContain("Salary review");
    expect(json).not.toContain("Confidential");
    expect(events[0].payload.snippet).toBeUndefined();
    expect(events[0].payload.title).toBeUndefined();
  });

  // P0.3: /api/events is public, so no event may name a person. The payload keys are pinned.
  it("message.created carries no person name (P0.3)", async () => {
    await seedUser("alice@example.com", "Alice Anderson");
    await seedUser("bob@example.com", "Bob Builder");
    const { subscribe } = await import("../lib/events");
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    subscribe((e) => events.push(e));

    const { send } = await import("../lib/messages");
    send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Hi", body: "Hello" });

    const message = events.find((e) => e.type === "message.created")!;
    expect(Object.keys(message.payload).sort()).toEqual(["id", "kind"]);
    expect(JSON.stringify(events)).not.toMatch(/Alice Anderson|Bob Builder/);
  });


  // Review fix: reminders are private and /api/events is public, so no todo title may leave.
  it("todo.changed never carries the title: payload keys are exactly id and kind", async () => {
    await seedUser();
    const { subscribe } = await import("../lib/events");
    const events: { type: string; payload: Record<string, unknown> }[] = [];
    subscribe((e) => events.push(e));

    const { create, complete, snooze, abandon } = await import("../lib/todos");
    const t1 = create({ ownerId: "alice@example.com", title: "Secret plan one" });
    const t2 = create({ ownerId: "alice@example.com", title: "Secret plan two" });
    const t3 = create({ ownerId: "alice@example.com", title: "Secret plan three" });
    complete(t1.id, "alice@example.com");
    snooze(t2.id, "alice@example.com");
    abandon(t3.id, "alice@example.com");

    const todos = events.filter((e) => e.type === "todo.changed");
    expect(todos).toHaveLength(6);
    for (const e of todos) expect(Object.keys(e.payload).sort()).toEqual(["id", "kind"]);
    expect(JSON.stringify(events)).not.toContain("Secret plan");
  });

  it("messages.markRead() emits message.created only when a message actually got marked", async () => {
    await seedUser("alice@example.com", "Alice");
    await seedUser("bob@example.com", "Bob");
    const { send, markRead } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice@example.com", to: "bob@example.com", subject: "Hi", body: "Hello" });

    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    subscribe((e) => seen.push(e.type));

    markRead(thread.id, "bob@example.com");
    expect(seen).toEqual(["message.created"]);

    markRead(thread.id, "bob@example.com"); // nothing left unread: no-op, no event
    expect(seen).toEqual(["message.created"]);
  });

  it("todos.create/complete/snooze/abandon() each emit todo.changed", async () => {
    await seedUser();
    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    subscribe((e) => seen.push(e.type));

    const { create, complete, snooze, abandon } = await import("../lib/todos");
    const t1 = create({ ownerId: "alice@example.com", title: "Do thing" });
    const t2 = create({ ownerId: "alice@example.com", title: "Do other thing" });
    const t3 = create({ ownerId: "alice@example.com", title: "Do third thing" });
    complete(t1.id, "alice@example.com");
    snooze(t2.id, "alice@example.com");
    abandon(t3.id, "alice@example.com");

    expect(seen).toEqual(["todo.changed", "todo.changed", "todo.changed", "todo.changed", "todo.changed", "todo.changed"]);
  });
});
