import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Reactions and reads. A helpful, confirm or kudos from someone other than the
 * author counts as an agent read of the memory (touchRead in lib/learnings.ts; the basic cases are
 * in tests/agent-reads.test.ts). The same reactions used to reset the memory's expiry.
 * They no longer touch it: memories do not expire, and a valid-until date is the
 * author's own, moved only by a correction. These cases pin the edges: no date moves, a refused
 * reaction leaves no read, the repeat paths of vote, confirm and kudos, archived and deleted
 * memories, and what a reaction emits.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-reaction-reads-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
  upsertUser({ id: "voter-1", email: "b@example.com", name: "Bob", roles: [] });
  upsertUser({ id: "voter-2", email: "c@example.com", name: "Cid", roles: [] });
}

let seq = 0;
async function mk(over: Record<string, unknown> = {}) {
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({
    authorId: "author-1",
    title: `Fixture ${seq} zq${seq}`,
    body: `Body ${seq} about topic zq${seq}x`,
    confirmNotDuplicate: true,
    ...over,
  });
}

async function row(id: string) {
  const { getById } = await import("../lib/learnings");
  return getById(id)!;
}

/** Moves the last agent read back, as days passing would, so the next read counts as a new day. */
async function ageRead(id: string, days: number) {
  const { getDb } = await import("../lib/db");
  getDb().prepare("UPDATE learnings SET last_accessed_at = datetime('now', ?) WHERE id = ?").run(`-${days} days`, id);
}

async function inDays(n: number) {
  const { addDaysUtc, todayUtc } = await import("../lib/dates");
  return addDaysUtc(todayUtc(), n);
}

async function auditCount(action: string) {
  const { getDb } = await import("../lib/db");
  return (getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?").get(action) as { n: number }).n;
}

describe("a reaction never moves a valid-until date", () => {
  it("helpful, confirm, kudos and their repeats leave expires_at as it was and write no expiry-extended row", async () => {
    await seedUsers();
    const undated = await mk();
    const dated = await mk({ expiresAt: await inDays(10) }); // close: it used to be pushed out
    const { vote, confirm, giveKudos } = await import("../lib/learnings");
    for (const l of [undated, dated]) {
      vote(l.id, "voter-1", "helpful", "mcp");
      vote(l.id, "voter-1", "helpful", "mcp");
      confirm(l.id, "voter-1", "src/lib/db.ts, 2026-10-07", "mcp");
      confirm(l.id, "voter-1", "src/lib/db.ts, 2026-10-08", "mcp");
      giveKudos(l.id, "voter-2", "thanks", "mcp");
    }
    expect((await row(undated.id)).expires_at).toBeNull();
    expect((await row(dated.id)).expires_at).toBe(await inDays(10));
    expect(await auditCount("expiry-extended")).toBe(0);
  });

  it("use does not rescue a memory whose date has passed: the sweep still archives it", async () => {
    await seedUsers();
    const l = await mk({ expiresAt: await inDays(10) });
    const { getDb } = await import("../lib/db");
    // The date passes between two sweeps, and people keep using the memory in the meantime.
    getDb().prepare("UPDATE learnings SET expires_at = ? WHERE id = ?").run(await inDays(-1), l.id);
    const { vote, confirm, giveKudos } = await import("../lib/learnings");
    vote(l.id, "voter-1", "helpful", "mcp");
    confirm(l.id, "voter-1", "src/lib/db.ts, 2026-10-07", "mcp");
    giveKudos(l.id, "voter-2", null, "mcp");
    const used = await row(l.id);
    expect(used.access_days).toBe(1); // it was read, and that is not enough
    expect(used.expires_at).toBe(await inDays(-1));

    const { runMaintenance } = await import("../lib/maintenance");
    expect(runMaintenance(true)?.learningsExpired).toBe(1);
    expect((await row(l.id)).status).toBe("archived");
  });
});

describe("a refused reaction is not a read", () => {
  it("the author's own helpful, confirm and kudos are refused and leave no read", async () => {
    await seedUsers();
    const l = await mk();
    const { vote, confirm, giveKudos } = await import("../lib/learnings");
    const { ForbiddenError } = await import("../lib/errors");
    expect(() => vote(l.id, "author-1", "helpful")).toThrow(ForbiddenError);
    expect(() => confirm(l.id, "author-1", "src/a.ts, 2026-10-07")).toThrow(ForbiddenError);
    expect(() => giveKudos(l.id, "author-1", null)).toThrow(ForbiddenError);
    const after = await row(l.id);
    expect(after.access_days).toBe(0);
    expect(after.last_accessed_at).toBeNull();
  });

  it("a confirm with no note is refused and leaves no read", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm } = await import("../lib/learnings");
    expect(() => confirm(l.id, "voter-1", "")).toThrow(/note is required/);
    const after = await row(l.id);
    expect(after.access_days).toBe(0);
    expect(after.last_accessed_at).toBeNull();
  });

  it("a repeat kudos is a 409 and not a second read", async () => {
    await seedUsers();
    const l = await mk();
    const { giveKudos } = await import("../lib/learnings");
    const { ConflictError } = await import("../lib/errors");
    giveKudos(l.id, "voter-1", null, "mcp");
    await ageRead(l.id, 3);
    expect(() => giveKudos(l.id, "voter-1", null)).toThrow(ConflictError);
    expect((await row(l.id)).access_days).toBe(1);
  });
});

describe("repeats and switches", () => {
  it("a repeat confirm inside 30 days keeps the note and the date, but is a read on a later day", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm, recentNotes } = await import("../lib/learnings");
    confirm(l.id, "voter-1", "src/a.ts, 2026-10-02");
    await ageRead(l.id, 3);
    const again = confirm(l.id, "voter-1", "src/a.ts, 2026-10-03");
    expect(again.changed).toBe(false);
    expect(recentNotes(l.id)[0].note).toBe("src/a.ts, 2026-10-02"); // the first note is kept
    expect((await row(l.id)).access_days).toBe(2);
  });

  it("only a helpful is a read: not_helpful and a repeat not_helpful are not, the switch to helpful is", async () => {
    await seedUsers();
    const l = await mk();
    const { vote } = await import("../lib/learnings");
    vote(l.id, "voter-1", "not_helpful", "mcp");
    vote(l.id, "voter-1", "not_helpful", "mcp");
    expect((await row(l.id)).access_days).toBe(0);
    vote(l.id, "voter-1", "helpful", "mcp");
    expect((await row(l.id)).access_days).toBe(1);
  });
});

describe("archived and deleted memories", () => {
  it("a helpful on one is not a read, and the status stays", async () => {
    await seedUsers();
    const { vote } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    for (const status of ["archived", "deleted"]) {
      const l = await mk();
      getDb().prepare("UPDATE learnings SET status = ? WHERE id = ?").run(status, l.id);
      vote(l.id, "voter-1", "helpful", "mcp");
      const after = await row(l.id);
      expect(after.status).toBe(status);
      expect(after.access_days).toBe(0);
      expect(after.last_accessed_at).toBeNull();
    }
  });
});

describe("what a reaction emits", () => {
  it("a helpful emits the vote event only, and a repeat helpful emits nothing even though it is a read", async () => {
    await seedUsers();
    const l = await mk();
    const { vote } = await import("../lib/learnings");
    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    const off = subscribe((e) => seen.push(e.type));
    try {
      vote(l.id, "voter-1", "helpful", "mcp");
      expect(seen).toEqual(["vote"]);
      await ageRead(l.id, 3);
      vote(l.id, "voter-1", "helpful", "mcp"); // unchanged vote, but a read on a new day
      expect(seen).toEqual(["vote"]);
      expect((await row(l.id)).access_days).toBe(2);
    } finally {
      off();
    }
  });
});
