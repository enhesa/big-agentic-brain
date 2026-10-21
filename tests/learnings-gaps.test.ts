import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addDaysUtc, todayUtc } from "../lib/dates";
import type { LearningRow } from "../lib/types";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-learnings-gaps-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.restoreAllMocks();
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
  upsertUser({ id: "author-2", email: "b@example.com", name: "Bob", roles: [] });
  upsertUser({ id: "voter-1", email: "c@example.com", name: "Cid", roles: [] });
  upsertUser({ id: "voter-2", email: "d@example.com", name: "Dee", roles: [] });
}

describe("learnings.list filters", () => {
  it("filters by status, tag, repo and author independently", async () => {
    await seedUsers();
    const { create, list } = await import("../lib/learnings");
    const l1 = create({
      authorId: "author-1",
      title: "A",
      body: "Body A",
      tags: ["ci", "dotnet"],
      repo: "acme.api",
    });
    create({
      authorId: "author-2",
      title: "B",
      body: "Body B",
      tags: ["kafka"],
      repo: "acme.job",
    });

    expect(list({ author: "author-1" }).map((l) => l.id)).toEqual([l1.id]);
    expect(list({ repo: "acme.job" }).map((l) => l.title)).toEqual(["B"]);
    expect(list({ tag: "dotnet" }).map((l) => l.id)).toEqual([l1.id]);
    expect(list({ status: "active" }).length).toBe(2);
    expect(list({ status: "archived" }).length).toBe(0);
  });

  it("default listing excludes both archived and deleted, unless asked for explicitly", async () => {
    await seedUsers();
    const { create, list } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const active = create({ authorId: "author-1", title: "Active", body: "B" });
    const archived = create({ authorId: "author-1", title: "Archived", body: "B" });
    const deleted = create({ authorId: "author-1", title: "Deleted", body: "B" });
    getDb().prepare("UPDATE learnings SET status = 'archived' WHERE id = ?").run(archived.id);
    getDb().prepare("UPDATE learnings SET status = 'deleted' WHERE id = ?").run(deleted.id);

    const defaultIds = list().map((l) => l.id);
    expect(defaultIds).toContain(active.id);
    expect(defaultIds).not.toContain(archived.id);
    expect(defaultIds).not.toContain(deleted.id);

    expect(list({ status: "archived" }).map((l) => l.id)).toEqual([archived.id]);

    const allIds = list({ status: "all" }).map((l) => l.id);
    expect(allIds).toContain(active.id);
    expect(allIds).toContain(archived.id);
    expect(allIds).toContain(deleted.id);
  });
});

describe("learnings archived items", () => {
  it("are excluded from default search but included with status=archived or status=all; remain fetchable by id", async () => {
    await seedUsers();
    const { create, search, getById } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const archived = create({ authorId: "author-1", title: "Archived runTest note", body: "About runTest.sh" });
    const deleted = create({
      authorId: "author-1",
      title: "Deleted runTest note",
      body: "About runTest.sh too",
      confirmNotDuplicate: true,
    });
    getDb().prepare("UPDATE learnings SET status = 'archived' WHERE id = ?").run(archived.id);
    getDb().prepare("UPDATE learnings SET status = 'deleted' WHERE id = ?").run(deleted.id);

    const defaultResults = search("runTest");
    expect(defaultResults.map((r) => r.id)).not.toContain(archived.id);
    expect(defaultResults.map((r) => r.id)).not.toContain(deleted.id);

    const archivedOnly = search("runTest", { status: "archived" });
    expect(archivedOnly.map((r) => r.id)).toContain(archived.id);

    const all = search("runTest", { status: "all" });
    expect(all.map((r) => r.id)).toContain(archived.id);
    expect(all.map((r) => r.id)).toContain(deleted.id);

    expect(getById(archived.id)?.status).toBe("archived");
  });

  it("can be excluded explicitly by passing status: 'active'", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const archived = create({ authorId: "author-1", title: "Archived note", body: "About runTest.sh" });
    getDb().prepare("UPDATE learnings SET status = 'archived' WHERE id = ?").run(archived.id);

    const results = search("runTest", { status: "active" });
    expect(results.map((r) => r.id)).not.toContain(archived.id);
  });
});

describe("learnings.expiryState", () => {
  /** A stored row with the given valid-until date; nothing else about it matters to expiryState. */
  function rowWith(expires_at: string | null): LearningRow {
    const today = todayUtc();
    return {
      id: "x",
      author_id: "a",
      title: "t",
      body: "b",
      tags: "[]",
      repo: null,
      project: null,
      confidence: "medium",
      status: "active",
      expires_at,
      expires_explicit: 0,
      last_accessed_at: null,
      access_days: 0,
      supersedes_id: null,
      score: 0,
      kind: "learning",
      source: "native",
      source_url: null,
      source_version: null,
      model: null,
      applies_to: "[]",
      aliases: "[]",
      pinned: 0,
      pinned_by: null,
      pinned_at: null,
      created_at: today,
      updated_at: today,
    };
  }

  it("is 'active' for a valid-until date still ahead, however close: there is no 'expiring' state any more", async () => {
    const { expiryState } = await import("../lib/learnings");
    for (const days of [1, 14, 15, 400]) {
      expect(expiryState(rowWith(addDaysUtc(todayUtc(), days))), `+${days} days`).toBe("active");
    }
  });

  it("is 'expired' the day after the valid-until date, and still 'active' on that last valid day", async () => {
    const { expiryState } = await import("../lib/learnings");
    const today = todayUtc();
    expect(expiryState(rowWith(today))).toBe("active");
    expect(expiryState(rowWith(addDaysUtc(today, -1)))).toBe("expired");
    expect(expiryState(rowWith(addDaysUtc(today, -90)))).toBe("expired");
  });

  it("reads a legacy full ISO datetime by its calendar day", async () => {
    const { expiryState } = await import("../lib/learnings");
    const today = todayUtc();
    expect(expiryState(rowWith(`${addDaysUtc(today, -1)}T23:59:59.000Z`))).toBe("expired");
    expect(expiryState(rowWith(`${today}T00:00:00.000Z`))).toBe("active");
  });

  it("treats a null expires_at as active", async () => {
    const { expiryState } = await import("../lib/learnings");
    expect(expiryState(rowWith(null))).toBe("active");
  });
});

describe("learnings.flag", () => {
  it("flagging twice by the same person still counts as one flag (no auto-archive)", async () => {
    await seedUsers();
    const { create, flag, getById } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "T", body: "B" });

    flag(l.id, "voter-1");
    flag(l.id, "voter-1");

    const { getDb } = await import("../lib/db");
    const { n } = getDb()
      .prepare("SELECT COUNT(*) AS n FROM votes WHERE learning_id = ? AND kind = 'flag'")
      .get(l.id) as { n: number };
    expect(n).toBe(1);
    expect(getById(l.id)!.status).toBe("active");
  });
});

describe("learnings.vote switching", () => {
  it("switching from helpful to not_helpful replaces the prior vote (changed: true)", async () => {
    await seedUsers();
    const { create, vote } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "T", body: "B" });

    const first = vote(l.id, "voter-1", "helpful");
    expect(first.changed).toBe(true);
    expect(first.learning.score).toBe(1);

    // switching kind replaces the prior vote for that voter, it doesn't add a second row
    const after = vote(l.id, "voter-1", "not_helpful");
    expect(after.changed).toBe(true);
    expect(after.learning.score).toBe(-1);
  });
});

describe("learnings tag normalisation", () => {
  it("caps the number of tags at 10 and each tag's length at 40 bytes", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const manyTags = Array.from({ length: 15 }, (_, i) => `tag-${i}`);
    const l = create({ authorId: "author-1", title: "T", body: "B", tags: manyTags });
    const tags = JSON.parse(l.tags) as string[];
    expect(tags.length).toBe(10);
    expect(tags).toEqual(manyTags.slice(0, 10));
  });

  it("rejects (throws, in human units) a tag longer than 40 characters", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const longTag = "x".repeat(41);
    expect(() => create({ authorId: "author-1", title: "T", body: "B", tags: [longTag] })).toThrow(
      /tag must be 40 characters or fewer/i,
    );
  });

  it("lowercases and trims tags", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "T", body: "B", tags: ["  CI  ", "DotNet"] });
    const tags = JSON.parse(l.tags) as string[];
    expect(tags).toEqual(["ci", "dotnet"]);
  });
});

describe("learnings.supersede is transactional", () => {
  it("rolls back the archive-old step when linking supersedes_id fails, so a crash never orphans the link", async () => {
    await seedUsers();
    const { create, supersede, getById } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const oldL = create({ authorId: "author-1", title: "Old", body: "Old body" });
    const newL = create({ authorId: "author-1", title: "New", body: "New body" });

    const db = getDb();
    const original = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("SET supersedes_id")) {
        throw new Error("simulated failure linking supersedes_id");
      }
      return original(sql);
    });

    expect(() => supersede(newL.id, oldL.id, "author-1")).toThrow(/simulated failure/);
    spy.mockRestore();

    // Nothing partial: the old learning must still be active, not archived
    // with no forward link (which findSupersededBy would never find again).
    expect(getById(oldL.id)!.status).toBe("active");
    expect(getById(newL.id)!.supersedes_id).toBeNull();

    // A retry now goes through cleanly.
    supersede(newL.id, oldL.id, "author-1");
    expect(getById(oldL.id)!.status).toBe("archived");
    expect(getById(newL.id)!.supersedes_id).toBe(oldL.id);
  });
});

describe("learnings.flag is transactional", () => {
  it("rolls back the flag vote too when the auto-archive update fails, so a retry can re-trigger it", async () => {
    await seedUsers();
    const { create, flag, getById } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const l = create({ authorId: "author-1", title: "T", body: "B" });
    flag(l.id, "voter-1");

    const db = getDb();
    const original = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("UPDATE learnings SET status = 'archived'")) {
        throw new Error("simulated failure auto-archiving");
      }
      return original(sql);
    });

    expect(() => flag(l.id, "voter-2")).toThrow(/simulated failure/);
    spy.mockRestore();

    // The second flag vote must not have landed either: if it had, a retry's
    // `INSERT OR IGNORE` would silently no-op and the archive that crossed
    // FLAG_THRESHOLD would never actually happen.
    const { n } = getDb()
      .prepare("SELECT COUNT(*) AS n FROM votes WHERE learning_id = ? AND kind = 'flag'")
      .get(l.id) as { n: number };
    expect(n).toBe(1);
    expect(getById(l.id)!.status).toBe("active");

    // A retry now succeeds and does trigger the auto-archive.
    flag(l.id, "voter-2");
    expect(getById(l.id)!.status).toBe("archived");
  });
});
