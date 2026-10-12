import { describe, it, expect, afterEach } from "vitest";

describe("lib/events (in-process bus)", () => {
  afterEach(async () => {
    const { _resetEventsForTests } = await import("../lib/events");
    _resetEventsForTests();
  });

  it("emit() assigns increasing seq numbers and notifies subscribers", async () => {
    const { emit, subscribe, _resetEventsForTests } = await import("../lib/events");
    _resetEventsForTests();

    const seen: number[] = [];
    const unsubscribe = subscribe((e) => seen.push(e.seq));

    const e1 = emit("todo.changed", "todo-1", { title: "First" });
    const e2 = emit("todo.changed", "todo-2", { title: "Second" });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(seen).toEqual([1, 2]);

    unsubscribe();
    emit("todo.changed", "todo-3", { title: "Third" });
    expect(seen).toEqual([1, 2]); // unsubscribed, no longer notified
  });

  it("subscribe() returns an unsubscribe function and a thrown callback doesn't break others", async () => {
    const { emit, subscribe, _resetEventsForTests } = await import("../lib/events");
    _resetEventsForTests();

    const seen: string[] = [];
    subscribe(() => {
      throw new Error("boom");
    });
    subscribe((e) => seen.push(e.id));

    expect(() => emit("kudos", "learning-1")).not.toThrow();
    expect(seen).toEqual(["learning-1"]);
  });

  it("keeps only the last 200 events in the ring buffer", async () => {
    const { emit, eventsSince, _resetEventsForTests } = await import("../lib/events");
    _resetEventsForTests();

    for (let i = 0; i < 250; i++) emit("todo.changed", `todo-${i}`);

    const all = eventsSince(0);
    expect(all.length).toBe(200);
    expect(all[0].id).toBe("todo-50"); // the oldest 50 were dropped
    expect(all[all.length - 1].id).toBe("todo-249");
  });

  it("eventsSince(lastSeq) replays only events strictly after lastSeq", async () => {
    const { emit, eventsSince, _resetEventsForTests } = await import("../lib/events");
    _resetEventsForTests();

    emit("vote", "learning-1");
    const marker = emit("vote", "learning-2");
    emit("vote", "learning-3");

    const replayed = eventsSince(marker.seq);
    expect(replayed.map((e) => e.id)).toEqual(["learning-3"]);
  });

  it("truncates an overlong snippet to 140 chars", async () => {
    const { emit, _resetEventsForTests } = await import("../lib/events");
    _resetEventsForTests();

    const long = "x".repeat(500);
    const event = emit("learning.created", "l1", { snippet: long });
    expect(event.payload.snippet?.length).toBe(140);
  });
});
