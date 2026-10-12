import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-maintenance-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_AUDIT_RETENTION_DAYS;
  (await import("../lib/config"))._resetConfigForTests();
  vi.restoreAllMocks();
});

function insertLearning(
  db: DatabaseSync,
  id: string,
  status: string,
  expiresAt: string | null,
  authorId = "actor-1",
) {
  db.prepare(
    `INSERT INTO learnings (id, author_id, title, body, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, authorId, `Learning ${id}`, "Body", status, expiresAt);
}

describe("runMaintenance retention sweep", () => {
  it("deletes idempotency rows older than 24h but keeps fresh ones", async () => {
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();

    const db = getDb();
    db.prepare(
      `INSERT INTO idempotency (actor_id, key, status, body_json, created_at)
       VALUES (?, ?, ?, ?, datetime('now', '-25 hours'))`,
    ).run("actor-1", "old-key", 200, "{}");
    db.prepare(
      `INSERT INTO idempotency (actor_id, key, status, body_json, created_at)
       VALUES (?, ?, ?, ?, datetime('now', '-1 hours'))`,
    ).run("actor-1", "fresh-key", 200, "{}");

    const result = runMaintenance(true);
    expect(result?.idempotencyDeleted).toBe(1);

    const remaining = db.prepare("SELECT key FROM idempotency").all() as { key: string }[];
    expect(remaining.map((r) => r.key)).toEqual(["fresh-key"]);
  });

  it("deletes audit_log rows older than BAB_AUDIT_RETENTION_DAYS but keeps fresh ones", async () => {
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    process.env.BAB_AUDIT_RETENTION_DAYS = "10";
    const { _resetConfigForTests } = await import("../lib/config");
    _resetConfigForTests();
    const AUDIT_RETENTION_DAYS = 10;
    _resetMaintenanceGuardForTests();

    const db = getDb();
    db.prepare(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, via, at)
       VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
    ).run("actor-1", "create", "learning", "l-1", "ui", `-${AUDIT_RETENTION_DAYS + 1} days`);
    db.prepare(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, via, at)
       VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
    ).run("actor-1", "create", "learning", "l-2", "ui", `-${AUDIT_RETENTION_DAYS - 1} days`);

    const result = runMaintenance(true);
    expect(result?.auditDeleted).toBe(1);

    const remaining = db.prepare("SELECT entity_id FROM audit_log").all() as { entity_id: string }[];
    expect(remaining.map((r) => r.entity_id)).toEqual(["l-2"]);
  });

  it("runs at most once per hour unless forced", async () => {
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();
    getDb();

    const first = runMaintenance();
    expect(first).not.toBeNull();

    const second = runMaintenance();
    expect(second).toBeNull();

    const third = runMaintenance(true);
    expect(third).not.toBeNull();
  });

  it("never throws when the db errors", async () => {
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();

    const db = getDb();
    const spy = vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("simulated db failure");
    });

    expect(() => runMaintenance(true)).not.toThrow();
    const result = runMaintenance(true);
    expect(result).toBeNull();

    spy.mockRestore();
  });
});

describe("runMaintenance valid-until sweep (docs/spec.md Garbage collection)", () => {
  async function seedUser() {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "actor-1", email: "actor-1@example.com", name: "Actor", roles: [] });
  }

  it("archives an active learning the day after its valid-until date, not on it", async () => {
    await seedUser();
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    const { addDaysUtc, todayUtc } = await import("../lib/dates");
    _resetMaintenanceGuardForTests();

    const db = getDb();
    const today = todayUtc();
    insertLearning(db, "l-yesterday", "active", addDaysUtc(today, -1));
    insertLearning(db, "l-past", "active", addDaysUtc(today, -3));
    // Today is still the last valid day. Tomorrow and a week out (inside what used to be the 14-day
    // warning window) stay live too.
    insertLearning(db, "l-today", "active", today);
    insertLearning(db, "l-tomorrow", "active", addDaysUtc(today, 1));
    insertLearning(db, "l-next-week", "active", addDaysUtc(today, 7));

    const result = runMaintenance(true);
    expect(result?.learningsExpired).toBe(2);
    // There is no middle step any more: a date that is coming up changes nothing until it arrives.
    expect(result).not.toHaveProperty("learningsExpiring");

    const rows = db.prepare("SELECT id, status FROM learnings ORDER BY id").all() as {
      id: string;
      status: string;
    }[];
    expect(rows.find((r) => r.id === "l-yesterday")!.status).toBe("archived");
    expect(rows.find((r) => r.id === "l-past")!.status).toBe("archived");
    expect(rows.find((r) => r.id === "l-today")!.status).toBe("active");
    expect(rows.find((r) => r.id === "l-tomorrow")!.status).toBe("active");
    expect(rows.find((r) => r.id === "l-next-week")!.status).toBe("active");
  });

  it("never touches an already-archived, deleted, or null-expiry learning", async () => {
    await seedUser();
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    const { todayUtc } = await import("../lib/dates");
    _resetMaintenanceGuardForTests();

    const db = getDb();
    const today = todayUtc();
    insertLearning(db, "l-archived", "archived", today);
    insertLearning(db, "l-deleted", "deleted", today);
    insertLearning(db, "l-no-expiry", "active", null);

    const result = runMaintenance(true);
    expect(result?.learningsExpired).toBe(0);

    const rows = db.prepare("SELECT id, status FROM learnings ORDER BY id").all() as {
      id: string;
      status: string;
    }[];
    expect(rows.find((r) => r.id === "l-archived")!.status).toBe("archived");
    expect(rows.find((r) => r.id === "l-deleted")!.status).toBe("deleted");
    expect(rows.find((r) => r.id === "l-no-expiry")!.status).toBe("active");
  });

  it("is idempotent: running it twice in a row doesn't re-move an already-moved row", async () => {
    await seedUser();
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    const { addDaysUtc, todayUtc } = await import("../lib/dates");
    _resetMaintenanceGuardForTests();

    const db = getDb();
    insertLearning(db, "l-yesterday", "active", addDaysUtc(todayUtc(), -1));

    const first = runMaintenance(true);
    expect(first?.learningsExpired).toBe(1);

    const second = runMaintenance(true);
    expect(second?.learningsExpired).toBe(0);
    expect((db.prepare("SELECT status FROM learnings WHERE id = ?").get("l-yesterday") as { status: string }).status).toBe(
      "archived",
    );
  });
});

describe("runMaintenance retention: deleted learnings and empty threads", () => {
  it("purges a deleted learning (and its votes) once past the retention window, keeps a recent one", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "actor-1", email: "actor-1@example.com", name: "Actor", roles: [] });
    upsertUser({ id: "voter-1", email: "voter-1@example.com", name: "Voter", roles: [] });

    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();

    const db = getDb();
    db.prepare(
      `INSERT INTO learnings (id, author_id, title, body, status, updated_at)
       VALUES (?, ?, ?, ?, 'deleted', datetime('now', '-31 days'))`,
    ).run("l-old-deleted", "actor-1", "Old deleted", "Body");
    db.prepare("INSERT INTO votes (learning_id, voter_id, kind) VALUES (?, ?, 'flag')").run(
      "l-old-deleted",
      "voter-1",
    );

    db.prepare(
      `INSERT INTO learnings (id, author_id, title, body, status, updated_at)
       VALUES (?, ?, ?, ?, 'deleted', datetime('now', '-2 days'))`,
    ).run("l-recent-deleted", "actor-1", "Recent deleted", "Body");

    const result = runMaintenance(true);
    expect(result?.learningsPurged).toBe(1);

    const remainingIds = (db.prepare("SELECT id FROM learnings").all() as { id: string }[]).map((r) => r.id);
    expect(remainingIds).not.toContain("l-old-deleted");
    expect(remainingIds).toContain("l-recent-deleted");

    const remainingVotes = db
      .prepare("SELECT COUNT(*) AS n FROM votes WHERE learning_id = ?")
      .get("l-old-deleted") as { n: number };
    expect(remainingVotes.n).toBe(0);
  });

  it("never purges an active or archived learning regardless of age", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "actor-1", email: "actor-1@example.com", name: "Actor", roles: [] });

    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();

    const db = getDb();
    for (const status of ["active", "archived"]) {
      db.prepare(
        `INSERT INTO learnings (id, author_id, title, body, status, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', '-9999 days'))`,
      ).run(`l-old-${status}`, "actor-1", `Old ${status}`, "Body", status);
    }

    const result = runMaintenance(true);
    expect(result?.learningsPurged).toBe(0);

    const remainingIds = (db.prepare("SELECT id FROM learnings").all() as { id: string }[]).map((r) => r.id);
    expect(remainingIds).toEqual(expect.arrayContaining(["l-old-active", "l-old-archived"]));
  });

  it("deletes a thread with no messages, keeps one with a message", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "alice", email: "alice@example.com", name: "Alice", roles: [] });
    upsertUser({ id: "bob", email: "bob@example.com", name: "Bob", roles: [] });

    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();

    const db = getDb();
    db.prepare("INSERT INTO threads (id, subject, created_by) VALUES (?, ?, ?)").run(
      "t-empty",
      "Empty",
      "alice",
    );

    const { send } = await import("../lib/messages");
    const { thread } = send({ fromId: "alice", to: "bob", subject: "Has a message", body: "hi" }, "mcp");

    const result = runMaintenance(true);
    expect(result?.threadsPurged).toBe(1);

    const remainingIds = (db.prepare("SELECT id FROM threads").all() as { id: string }[]).map((r) => r.id);
    expect(remainingIds).not.toContain("t-empty");
    expect(remainingIds).toContain(thread.id);
  });

  it("purges an expired session_links row, keeps a live one", async () => {
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    const { mintLinkToken } = await import("../lib/session-links");
    _resetMaintenanceGuardForTests();

    const liveToken = mintLinkToken("sess-live");
    const expiredToken = mintLinkToken("sess-expired");

    const db = getDb();
    db.prepare("UPDATE session_links SET expires_at = datetime('now', '-1 minute') WHERE token = ?").run(
      expiredToken,
    );

    const result = runMaintenance(true);
    expect(result?.sessionLinksPurged).toBe(1);

    const remainingTokens = (db.prepare("SELECT token FROM session_links").all() as { token: string }[]).map(
      (r) => r.token,
    );
    expect(remainingTokens).toContain(liveToken);
    expect(remainingTokens).not.toContain(expiredToken);
  });

  it("purges session_nudges rows with no session after 7 days, and every row after 30 days", async () => {
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    const { upsertUser } = await import("../lib/users");
    const { linkSession } = await import("../lib/sessions");
    _resetMaintenanceGuardForTests();

    upsertUser({ id: "owner-1", email: "owner-1", name: "Owner", roles: [] });
    linkSession("owner-1", "sess-live");
    const db = getDb();
    const add = (session: string, kind: string, daysAgo: number) =>
      db
        .prepare("INSERT INTO session_nudges (session_id, kind, at) VALUES (?, ?, datetime('now', ?))")
        .run(session, kind, `-${daysAgo} days`);
    add("sess-orphan-new", "rules", 1); // no session yet, recent: kept, it still guards a first prompt
    add("sess-orphan-old", "rules", 8); // no session, over 7 days: gone
    add("sess-live", "rules", 20); // live session, under 30 days: kept
    add("sess-live", "project", 31); // live session, over 30 days: gone

    const result = runMaintenance(true);
    expect(result?.sessionNudgesPurged).toBe(2);
    const left = db.prepare("SELECT session_id, kind FROM session_nudges ORDER BY session_id").all();
    expect(left.map((r) => ({ ...r }))).toEqual([
      { session_id: "sess-live", kind: "rules" },
      { session_id: "sess-orphan-new", kind: "rules" },
    ]);
  });

  it("purges a session_deliveries row for a dead session, keeps a live one", async () => {
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    const { upsertUser } = await import("../lib/users");
    const { linkSession } = await import("../lib/sessions");
    _resetMaintenanceGuardForTests();

    upsertUser({ id: "owner-1", email: "owner-1", name: "Owner", roles: [] });
    linkSession("owner-1", "sess-live");
    // "sess-dead" is never created in `sessions` at all — the same state a session
    // reaches once sweepSessions() hard-deletes it 7 days after it ends.

    const db = getDb();
    db.prepare("INSERT INTO session_deliveries (session_id, message_id) VALUES (?, ?)").run(
      "sess-live",
      "msg-1",
    );
    db.prepare("INSERT INTO session_deliveries (session_id, message_id) VALUES (?, ?)").run(
      "sess-dead",
      "msg-2",
    );

    const result = runMaintenance(true);
    expect(result?.sessionDeliveriesPurged).toBe(1);

    const remaining = (
      db.prepare("SELECT session_id FROM session_deliveries").all() as { session_id: string }[]
    ).map((r) => r.session_id);
    expect(remaining).toContain("sess-live");
    expect(remaining).not.toContain("sess-dead");
  });

  // reminder_deliveries (migration v17) dedups the due-reminder notice per owner, keyed
  // on (owner_id, todo_id, due_at) — nothing else ever cleans it up. A row goes stale two
  // ways: the todo it names is gone, or snooze() (lib/todos.ts) moved it to a new due_at.
  it("purges a reminder_deliveries row whose todo has since been snoozed to a new due_at, keeps a current one", async () => {
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    const { upsertUser } = await import("../lib/users");
    const { create, snooze } = await import("../lib/todos");
    _resetMaintenanceGuardForTests();

    upsertUser({ id: "owner-1", email: "owner-1@example.com", name: "Owner", roles: [] });
    const stale = create({ ownerId: "owner-1", title: "Snoozed reminder", dueAt: "2026-09-01" });
    const current = create({ ownerId: "owner-1", title: "Still due today", dueAt: "2026-09-25" });

    const db = getDb();
    db.prepare("INSERT INTO reminder_deliveries (owner_id, todo_id, due_at) VALUES (?, ?, ?)").run(
      "owner-1",
      stale.id,
      "2026-09-01",
    );
    db.prepare("INSERT INTO reminder_deliveries (owner_id, todo_id, due_at) VALUES (?, ?, ?)").run(
      "owner-1",
      current.id,
      "2026-09-25",
    );

    // The old due_at row no longer matches the todo's current due_at once snoozed.
    snooze(stale.id, "owner-1");

    const result = runMaintenance(true);
    expect(result?.reminderDeliveriesPurged).toBe(1);

    const remaining = (
      db.prepare("SELECT todo_id FROM reminder_deliveries").all() as { todo_id: string }[]
    ).map((r) => r.todo_id);
    expect(remaining).not.toContain(stale.id);
    expect(remaining).toContain(current.id);
  });
});

describe("runMaintenance: purging a deleted replacement", () => {
  it("purges a deleted learning that superseded another, despite supersession_links", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "actor-1", email: "actor-1@example.com", name: "Actor", roles: [] });
    const { getDb } = await import("../lib/db");
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();
    const db = getDb();
    db.prepare("INSERT INTO learnings (id, author_id, title, body, status) VALUES ('old', 'actor-1', 'Old', 'B', 'archived')").run();
    db.prepare(
      `INSERT INTO learnings (id, author_id, title, body, status, supersedes_id, updated_at)
       VALUES ('new', 'actor-1', 'New', 'B', 'deleted', 'old', datetime('now', '-31 days'))`,
    ).run();
    db.prepare("INSERT INTO supersession_links (old_id, new_id) VALUES ('old', 'new')").run();

    const result = runMaintenance(true);
    expect(result?.learningsPurged).toBe(1);
    expect(db.prepare("SELECT 1 FROM learnings WHERE id = 'new'").get()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM supersession_links").get()).toEqual({ n: 0 });
  });
});
