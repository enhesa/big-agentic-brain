import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-sessions-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seedUser(id = "owner-1", email = "owner@example.com") {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id, email, name: "Owner", roles: [] });
}

describe("linkSession", () => {
  it("records the owner of a session id", async () => {
    await seedUser();
    const { linkSession } = await import("../lib/sessions");
    const s = linkSession("owner-1", "sess-1");
    expect(s.id).toBe("sess-1");
    expect(s.owner_id).toBe("owner-1");
    expect(s.status).toBe("active");
    expect(s.ended_at).toBeNull();
  });

  it("rejects a missing/too-long id", async () => {
    await seedUser();
    const { linkSession } = await import("../lib/sessions");
    expect(() => linkSession("owner-1", "")).toThrow();
    expect(() => linkSession("owner-1", "x".repeat(129))).toThrow();
  });

  it("refuses to hand an existing session to a different owner (ForbiddenError), leaving it untouched", async () => {
    await seedUser("owner-1", "owner1@example.com");
    await seedUser("owner-2", "owner2@example.com");
    const { linkSession, getById } = await import("../lib/sessions");
    const { ForbiddenError } = await import("../lib/errors");
    linkSession("owner-1", "sess-1");

    expect(() => linkSession("owner-2", "sess-1")).toThrow(ForbiddenError);
    expect(getById("sess-1")!.owner_id).toBe("owner-1");
  });

  it("clears ended_at when a swept session links again", async () => {
    await seedUser();
    const { linkSession } = await import("../lib/sessions");
    const { getDb } = await import("../lib/db");
    linkSession("owner-1", "sess-1");
    getDb().prepare("UPDATE sessions SET status = 'ended', ended_at = datetime('now') WHERE id = ?").run("sess-1");
    const revived = linkSession("owner-1", "sess-1");
    expect(revived.ended_at).toBeNull();
    expect(revived.status).toBe("active");
  });

  it("writes none of the old registry columns (name, title, cwd, host, pid)", async () => {
    await seedUser();
    const { linkSession } = await import("../lib/sessions");
    const { getDb } = await import("../lib/db");
    linkSession("owner-1", "sess-1");
    const row = getDb().prepare("SELECT name, title, cwd, host, pid FROM sessions WHERE id = ?").get("sess-1");
    expect({ ...row }).toEqual({ name: null, title: null, cwd: null, host: null, pid: null });
  });
});

describe("refreshSessionIfStale", () => {
  it("does nothing to a fresh row", async () => {
    await seedUser();
    const { linkSession, refreshSessionIfStale, getById } = await import("../lib/sessions");
    linkSession("owner-1", "sess-1");
    const before = getById("sess-1")!.updated_at;

    refreshSessionIfStale("sess-1");

    expect(getById("sess-1")!.updated_at).toBe(before);
  });

  it("bumps updated_at once the row has gone stale", async () => {
    await seedUser();
    const { linkSession, refreshSessionIfStale, getById } = await import("../lib/sessions");
    const { getDb } = await import("../lib/db");
    linkSession("owner-1", "sess-1");
    getDb().prepare("UPDATE sessions SET updated_at = datetime('now', '-20 minutes') WHERE id = ?").run("sess-1");
    const before = getById("sess-1")!.updated_at;

    refreshSessionIfStale("sess-1");

    expect(getById("sess-1")!.updated_at).not.toBe(before);
  });

  it("never creates a row for an id that doesn't exist", async () => {
    const { refreshSessionIfStale, getById } = await import("../lib/sessions");
    refreshSessionIfStale("no-such-session");
    expect(getById("no-such-session")).toBeUndefined();
  });

  it("leaves an ended session's ended_at alone, even when stale", async () => {
    await seedUser();
    const { linkSession, refreshSessionIfStale, getById } = await import("../lib/sessions");
    const { getDb } = await import("../lib/db");
    linkSession("owner-1", "sess-1");
    getDb()
      .prepare("UPDATE sessions SET status = 'ended', ended_at = datetime('now'), updated_at = datetime('now', '-20 minutes') WHERE id = ?")
      .run("sess-1");

    refreshSessionIfStale("sess-1");

    const row = getById("sess-1")!;
    expect(row.ended_at).not.toBeNull();
    expect(row.status).toBe("ended");
  });
});

describe("sweepSessions", () => {
  it("ends stale sessions (>24h no hook refresh) and deletes old ended sessions (>7d)", async () => {
    await seedUser();
    const { linkSession, sweepSessions } = await import("../lib/sessions");
    const { getDb } = await import("../lib/db");
    const db = getDb();

    linkSession("owner-1", "stale-1");
    db.prepare("UPDATE sessions SET updated_at = datetime('now', '-25 hours') WHERE id = ?").run("stale-1");

    linkSession("owner-1", "old-ended");
    db.prepare(
      "UPDATE sessions SET status = 'ended', ended_at = datetime('now', '-8 days'), updated_at = datetime('now', '-8 days') WHERE id = ?",
    ).run("old-ended");

    const result = sweepSessions(db);
    expect(result.ended).toBe(1);
    expect(result.deleted).toBe(1);

    const staleRow = db.prepare("SELECT * FROM sessions WHERE id = ?").get("stale-1") as { status: string };
    expect(staleRow.status).toBe("ended");

    const deletedRow = db.prepare("SELECT * FROM sessions WHERE id = ?").get("old-ended");
    expect(deletedRow).toBeUndefined();
  });
});
