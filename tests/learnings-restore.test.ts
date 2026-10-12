import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Restore (owner review, 2026-10-02): a retire or two flags can be wrong, and a wrongly retired
 * memory used to be lost because `keep` refused anything archived. Now `keep` on an archived
 * memory (retired, flagged away or archived by the inactivity sweep) restores it to active: anyone
 * may, a non-author with a one-line note (a required field, like retire's). It is audited as
 * `restored`. A deleted memory and one a correction replaced stay out of reach; the second comes
 * back by superseding its replacement. A memory whose own valid-until date has passed is refused
 * too: the sweep would archive it again within the hour.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-restore-test-"));
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

async function audits(id: string, action: string) {
  const { getDb } = await import("../lib/db");
  const rows = getDb()
    .prepare("SELECT actor_id, via, details FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY id")
    .all(action, id) as { actor_id: string; via: string; details: string | null }[];
  return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

async function events(id: string) {
  const { getDb } = await import("../lib/db");
  return getDb()
    .prepare("SELECT voter_id, kind, note FROM votes WHERE learning_id = ? AND kind IN ('retire', 'restore') ORDER BY rowid")
    .all(id) as { voter_id: string; kind: string; note: string | null }[];
}

async function row(id: string) {
  const { getById } = await import("../lib/learnings");
  return getById(id)!;
}

async function inDays(n: number) {
  const { addDaysUtc, todayUtc } = await import("../lib/dates");
  return addDaysUtc(todayUtc(), n);
}

describe("keep on a retired memory restores it", () => {
  it("the author restores their own retired memory: active again, audited as restored, no note needed", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning } = await import("../lib/learnings");
    retire(l.id, "author-1", "mcp");
    expect((await row(l.id)).status).toBe("archived");

    const out = keepLearning(l.id, "author-1", "mcp");
    expect(out.changed).toBe(true);
    expect(out.learning.status).toBe("active");
    expect((await row(l.id)).status).toBe("active");
    expect(await audits(l.id, "restored")).toEqual([
      { actor_id: "author-1", via: "mcp", details: { by: "author", note: null } },
    ]);
  });

  it("a non-author needs a note: without one nothing changes, with one it is restored and audited as other", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning } = await import("../lib/learnings");
    const { ValidationError } = await import("../lib/errors");
    retire(l.id, "voter-1", "mcp", "Looked stale in the old pipeline, 2026-10-01");

    for (const n of [undefined, null, "", "   "]) {
      expect(() => keepLearning(l.id, "voter-2", "mcp", n as string | null | undefined)).toThrow(ValidationError);
    }
    expect(() => keepLearning(l.id, "voter-2", "mcp")).toThrow(/note is required/);
    expect((await row(l.id)).status).toBe("archived");
    expect(await audits(l.id, "restored")).toEqual([]);

    const out = keepLearning(l.id, "voter-2", "mcp", "Still true: azure-pipelines.yml, 2026-10-02");
    expect(out.learning.status).toBe("active");
    expect(await audits(l.id, "restored")).toEqual([
      { actor_id: "voter-2", via: "mcp", details: { by: "other", note: "Still true: azure-pipelines.yml, 2026-10-02" } },
    ]);
  });

  it("the person who retired it may restore it too", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Thought it was gone");
    expect(keepLearning(l.id, "voter-1", "mcp", "Checked again, it is still there").learning.status).toBe("active");
  });

  it("the note is redacted and capped at 300 characters, like a retire note", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Replaced, see docs/x.md 2026-10-01");
    expect(() => keepLearning(l.id, "voter-2", "mcp", "a".repeat(301))).toThrow(/300 characters/);
    keepLearning(l.id, "voter-2", "mcp", "see docs/x.md token=abc123secretvalue 2026-10-02");
    const [restored] = (await audits(l.id, "restored"));
    expect(restored.details.note).toContain("[redacted]");
    expect(JSON.stringify(restored.details)).not.toContain("abc123");
    expect((await events(l.id)).at(-1)!.note).toContain("[redacted]");
  });

  it("stores a restore row after the retire row, and neither touches the score or the counts", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning, voteCounts } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Looked stale");
    keepLearning(l.id, "voter-2", "mcp", "Checked, still true");
    expect(await events(l.id)).toEqual([
      { voter_id: "voter-1", kind: "retire", note: "Looked stale" },
      { voter_id: "voter-2", kind: "restore", note: "Checked, still true" },
    ]);
    expect(voteCounts(l.id)).toEqual({ helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 0 });
    expect((await row(l.id)).score).toBe(0);
  });

  it("emits learning.updated for the restored memory", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning } = await import("../lib/learnings");
    const { subscribe } = await import("../lib/events");
    retire(l.id, "author-1", "mcp");
    const seen: Array<{ type: string; kind?: string }> = [];
    const off = subscribe((e) => seen.push({ type: e.type, kind: e.payload.kind }));
    keepLearning(l.id, "author-1", "mcp");
    off();
    expect(seen).toEqual([{ type: "learning.updated", kind: "active" }]);
  });

  it("the memory is searchable again and out of the archived list", async () => {
    await seedUsers();
    const l = await mk({ title: "Restored and findable", body: "Restoration check wording" });
    const { retire, keepLearning, search } = await import("../lib/learnings");
    retire(l.id, "author-1", "mcp");
    expect(search("restoration check").map((r) => r.id)).not.toContain(l.id);
    keepLearning(l.id, "author-1", "mcp");
    expect(search("restoration check").map((r) => r.id)).toContain(l.id);
    expect(search("", { status: "archived" }).map((r) => r.id)).not.toContain(l.id);
  });

  it("can be retired again after a restore, and the memory ends up archived", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "First retire");
    keepLearning(l.id, "voter-1", "mcp", "Changed my mind");
    expect(retire(l.id, "voter-1", "mcp", "Second retire").status).toBe("archived");
  });
});

describe("keep on a memory that two flags archived restores it", () => {
  it("a learning: restored by its author, the flags stay on record and standing stays weak", async () => {
    await seedUsers();
    const l = await mk();
    const { flag, keepLearning, voteCounts, standingsFor, getById } = await import("../lib/learnings");
    flag(l.id, "voter-1", "mcp", "Moved to src/lib/x.ts, 2026-10-01");
    flag(l.id, "voter-2", "mcp", "Gone in main, 2026-10-01");
    expect((await row(l.id)).status).toBe("archived");

    expect(keepLearning(l.id, "author-1", "mcp").learning.status).toBe("active");
    expect(voteCounts(l.id).flag).toBe(2);
    expect(standingsFor([getById(l.id)!]).get(l.id)!.standing).toBe("weak");
  });

  it("a practice, which two flags now archive too: restored by someone else with a note", async () => {
    await seedUsers();
    const l = await mk({ kind: "practice" });
    const { flag, keepLearning } = await import("../lib/learnings");
    flag(l.id, "voter-1", "mcp", "Moved to src/lib/x.ts, 2026-10-01");
    flag(l.id, "voter-2", "mcp", "Gone in main, 2026-10-01");
    expect((await row(l.id)).status).toBe("archived");
    expect(() => keepLearning(l.id, "voter-1", "mcp")).toThrow(/note is required/);
    expect(keepLearning(l.id, "voter-1", "mcp", "Rechecked: the rule is still in CLAUDE.md").learning.status).toBe("active");
  });
});

describe("a restore is not undone by one more flag", () => {
  it("only flags placed after the restore count toward the two that archive", async () => {
    await seedUsers();
    const l = await mk();
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "voter-3", email: "d@example.com", name: "Dee", roles: [] });
    const { flag, keepLearning, voteCounts } = await import("../lib/learnings");
    flag(l.id, "voter-1", "mcp", "Moved to src/lib/x.ts, 2026-10-01");
    flag(l.id, "voter-2", "mcp", "Gone in main, 2026-10-01");
    expect((await row(l.id)).status).toBe("archived");
    keepLearning(l.id, "author-1", "mcp");

    // A new flagger, then a repeat by an original flagger: neither makes two flags since the restore.
    expect(flag(l.id, "voter-3", "mcp", "Still wrong in src/lib/y.ts, 2026-10-02").status).toBe("active");
    expect(flag(l.id, "voter-1", "mcp", "Same evidence again, 2026-10-02").status).toBe("active");
    expect(voteCounts(l.id).flag).toBe(3); // the old flags stay on record

    // A second flag from someone new since the restore archives it again.
    expect(flag(l.id, "voter-2", "mcp", "Rechecked, gone, 2026-10-02").status).toBe("active");
    upsertUser({ id: "voter-4", email: "e@example.com", name: "Eve", roles: [] });
    expect(flag(l.id, "voter-4", "mcp", "Confirmed gone, 2026-10-02").status).toBe("archived");
  });
});

describe("what keep still refuses", () => {
  it("a deleted memory", async () => {
    await seedUsers();
    const l = await mk();
    const { deleteOwn, keepLearning } = await import("../lib/learnings");
    deleteOwn(l.id, "author-1", "mcp");
    expect(() => keepLearning(l.id, "author-1", "mcp")).toThrow(/deleted by its author/);
    expect((await row(l.id)).status).toBe("deleted");
  });

  it("a memory a correction replaced, naming the replacement", async () => {
    await seedUsers();
    const old = await mk();
    const { createWithSupersedes, keepLearning } = await import("../lib/learnings");
    const fixed = createWithSupersedes(
      { authorId: "author-1", title: "Correction zq", body: "Fixed body about zqy", confirmNotDuplicate: true },
      [old.id],
    );
    expect(() => keepLearning(old.id, "author-1", "mcp")).toThrow(new RegExp(`replaced by ${fixed.id}`));
    expect((await row(old.id)).status).toBe("archived");
    expect(await events(old.id)).toEqual([]);
  });

  it("an unknown id is not found", async () => {
    await seedUsers();
    const { keepLearning } = await import("../lib/learnings");
    expect(() => keepLearning("nope", "author-1", "mcp")).toThrow(/not found/i);
  });
});

describe("a valid-until date the author chose", () => {
  it("is not moved by a restore while it is still ahead; the memory is active again", async () => {
    await seedUsers();
    const l = await mk({ expiresAt: await inDays(10) });
    const { retire, keepLearning } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Thought it was done");
    const out = keepLearning(l.id, "voter-2", "mcp", "Still needed until the freeze ends");
    expect(out.changed).toBe(true);
    expect(out.learning.status).toBe("active");
    expect(out.learning.expires_at).toBe(await inDays(10));
  });

  it("once it has passed, a restore is refused for the author too, and nothing changes", async () => {
    await seedUsers();
    const l = await mk({ expiresAt: await inDays(10) });
    const { retire, keepLearning } = await import("../lib/learnings");
    const { ValidationError } = await import("../lib/errors");
    const { getDb } = await import("../lib/db");
    retire(l.id, "voter-1", "mcp", "Thought it was done");
    getDb().prepare("UPDATE learnings SET expires_at = ? WHERE id = ?").run(await inDays(-1), l.id);

    // Someone else gives the note a restore needs, the author does not: both hear the same thing.
    for (const [actor, note] of [["voter-2", "Still true"], ["author-1", undefined]] as const) {
      expect(() => keepLearning(l.id, actor, "mcp", note)).toThrow(ValidationError);
      expect(() => keepLearning(l.id, actor, "mcp", note)).toThrow(/valid-until date/);
    }
    expect((await row(l.id)).status).toBe("archived");
    expect(await audits(l.id, "restored")).toEqual([]);
    expect((await events(l.id)).map((e) => e.kind)).toEqual(["retire"]);
  });
});

describe("a keep on a live memory is not a restore", () => {
  it("it ignores a note and writes no restore row", async () => {
    await seedUsers();
    const l = await mk();
    const { keepLearning } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const out = keepLearning(l.id, "voter-1", "mcp", "a note nobody needs");
    expect(out.changed).toBe(false);
    expect(out.learning.status).toBe("active");
    expect(await events(l.id)).toEqual([]);
    expect(await audits(l.id, "restored")).toEqual([]);
    // The keep is on record, without the note.
    expect(getDb().prepare("SELECT note FROM votes WHERE learning_id = ? AND kind = 'keep'").all(l.id)).toEqual([{ note: null }]);
  });
});

describe("retire and restore events keep their order", () => {
  it("the same person retiring, restoring and retiring again inside one second leaves the retire newest", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "First");
    keepLearning(l.id, "voter-1", "mcp", "Back");
    retire(l.id, "voter-1", "mcp", "Second");
    // One row per person and kind, in the order the events happened (highest rowid is newest).
    expect(await events(l.id)).toEqual([
      { voter_id: "voter-1", kind: "restore", note: "Back" },
      { voter_id: "voter-1", kind: "retire", note: "Second" },
    ]);
  });
});
