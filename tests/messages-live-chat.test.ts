import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-messages-live-chat-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "alice@example.com", email: "alice@example.com", name: "Alice", roles: [] });
  upsertUser({ id: "bob@example.com", email: "bob@example.com", name: "Bob", roles: [] });
}

describe("kind: \"auto\" is no longer supported", () => {
  it("400s (ValidationError) when kind:auto is sent", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    expect(() =>
      send({ fromId: "alice@example.com", to: "bob@example.com", body: "hi", kind: "auto" as any }, "mcp"),
    ).toThrow(/no longer supported/);
  });

  it("succeeds as kind:human when kind is omitted", async () => {
    await seedUsers();
    const { send } = await import("../lib/messages");
    const result = send({ fromId: "alice@example.com", to: "bob@example.com", body: "hi" }, "mcp");
    expect(result.message.kind).toBe("human");
  });
});

describe("chat lease", () => {
  it("recordLease clamps turns to <=10 and minutes to <=60", async () => {
    await seedUsers();
    const { send, recordLease } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice@example.com", to: "bob@example.com", body: "hi" }, "mcp");
    const lease = recordLease(thread.id, "alice@example.com", 999, 999);
    expect(lease.turnsLeft).toBe(10);
  });

  it("decrements turnsLeft on each lease-backed send and refuses at 0", async () => {
    await seedUsers();
    const { send, recordLease, getLeaseForActor } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice@example.com", to: "bob@example.com", body: "hi" }, "mcp");
    recordLease(thread.id, "alice@example.com", 2, 10);

    send({ fromId: "alice@example.com", threadId: thread.id, body: "1", useLease: true }, "mcp");
    expect(getLeaseForActor(thread.id, "alice@example.com")!.turnsLeft).toBe(1);

    send({ fromId: "alice@example.com", threadId: thread.id, body: "2", useLease: true }, "mcp");
    expect(getLeaseForActor(thread.id, "alice@example.com")!.turnsLeft).toBe(0);

    expect(() =>
      send({ fromId: "alice@example.com", threadId: thread.id, body: "3", useLease: true }, "mcp"),
    ).toThrow(/lease/i);
  });

  it("decrements on a plain human send carrying useLease, without requiring kind:auto", async () => {
    await seedUsers();
    const { send, recordLease, getLeaseForActor } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice@example.com", to: "bob@example.com", body: "hi" }, "mcp");
    recordLease(thread.id, "alice@example.com", 3, 10);

    const result = send(
      { fromId: "alice@example.com", threadId: thread.id, body: "leased human reply", useLease: true },
      "mcp",
    );
    expect(result.message.kind).toBe("human");
    expect(getLeaseForActor(thread.id, "alice@example.com")!.turnsLeft).toBe(2);
  });

  it("refuses a lease-backed send once the lease has expired", async () => {
    await seedUsers();
    const { send, recordLease } = await import("../lib/messages");
    const { getDb } = await import("../lib/db");
    const { thread } = send({ fromId: "alice@example.com", to: "bob@example.com", body: "hi" }, "mcp");
    recordLease(thread.id, "alice@example.com", 5, 10);

    const db = getDb();
    const store = { "alice@example.com": { actorId: "alice@example.com", turnsLeft: 5, expiresAt: "2000-01-01 00:00:00" } };
    db.prepare("UPDATE threads SET lease_json = ? WHERE id = ?").run(JSON.stringify(store), thread.id);

    expect(() =>
      send({ fromId: "alice@example.com", threadId: thread.id, body: "too late", useLease: true }, "mcp"),
    ).toThrow(/lease/i);
  });

  it("recordLease 404s for an unknown thread and 403s for a non-participant", async () => {
    await seedUsers();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "carol@example.com", email: "carol@example.com", name: "Carol", roles: [] });
    const { send, recordLease } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice@example.com", to: "bob@example.com", body: "hi" }, "mcp");

    expect(() => recordLease("nope", "alice@example.com", 1, 1)).toThrow(/not found/i);
    expect(() => recordLease(thread.id, "carol@example.com", 1, 1)).toThrow(/participant/i);
  });

  it("getLeaseForActor returns undefined when no lease was ever recorded", async () => {
    await seedUsers();
    const { send, getLeaseForActor } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice@example.com", to: "bob@example.com", body: "hi" }, "mcp");
    expect(getLeaseForActor(thread.id, "bob@example.com")).toBeUndefined();
  });
});
