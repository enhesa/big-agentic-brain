import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-learnings-confirm-test-"));
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
// confirmNotDuplicate: the dedup guard (similarity >= 0.55) must not fire between unrelated fixtures.
async function mk(over: Record<string, unknown> = {}) {
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({ authorId: "author-1", title: `Fixture ${seq} zq${seq}`, body: `Body ${seq} about topic zq${seq}x`, confirmNotDuplicate: true, ...over });
}

async function ageVote(learningId: string, voterId: string, kind: string, days: number) {
  const { getDb } = await import("../lib/db");
  getDb()
    .prepare("UPDATE votes SET created_at = datetime('now', ?) WHERE learning_id = ? AND voter_id = ? AND kind = ?")
    .run(`-${days} days`, learningId, voterId, kind);
}

async function voteRow(learningId: string, voterId: string, kind: string) {
  const { getDb } = await import("../lib/db");
  return getDb()
    .prepare("SELECT note, created_at FROM votes WHERE learning_id = ? AND voter_id = ? AND kind = ?")
    .get(learningId, voterId, kind) as { note: string | null; created_at: string } | undefined;
}

describe("confirm()", () => {
  it("records a confirmation with its note, adds 2 to score, reports changed", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm, voteCounts } = await import("../lib/learnings");
    const r = confirm(l.id, "voter-1", "src/lib/db.ts, 2026-10-01", "mcp");
    expect(r.changed).toBe(true);
    expect(r.learning.score).toBe(2);
    expect(voteCounts(l.id).confirm).toBe(1);
    expect((await voteRow(l.id, "voter-1", "confirm"))?.note).toBe("src/lib/db.ts, 2026-10-01");
  });

  it("refuses the author", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm } = await import("../lib/learnings");
    const { ForbiddenError } = await import("../lib/errors");
    expect(() => confirm(l.id, "author-1", "src/x.ts, 2026-10-01")).toThrow(ForbiddenError);
    expect(() => confirm(l.id, "author-1", "src/x.ts, 2026-10-01")).toThrow(/Cannot confirm your own learning/);
    expect(await voteRow(l.id, "author-1", "confirm")).toBeUndefined();
  });

  it("refuses an unknown learning", async () => {
    await seedUsers();
    const { confirm } = await import("../lib/learnings");
    const { NotFoundError } = await import("../lib/errors");
    expect(() => confirm("nope", "voter-1", "src/x.ts, 2026-10-01")).toThrow(NotFoundError);
  });

  it.each([undefined, null, "", "   "])("requires a note: %j", async (n) => {
    await seedUsers();
    const l = await mk();
    const { confirm } = await import("../lib/learnings");
    const { ValidationError } = await import("../lib/errors");
    expect(() => confirm(l.id, "voter-1", n as string | null | undefined)).toThrow(ValidationError);
    expect(await voteRow(l.id, "voter-1", "confirm")).toBeUndefined();
  });

  it("refuses a note over 300 characters, accepts exactly 300", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm } = await import("../lib/learnings");
    expect(() => confirm(l.id, "voter-1", "a".repeat(301))).toThrow(/300 characters/);
    expect(await voteRow(l.id, "voter-1", "confirm")).toBeUndefined();
    expect(confirm(l.id, "voter-1", "a".repeat(300)).changed).toBe(true);
  });

  it("redacts the note", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm } = await import("../lib/learnings");
    confirm(l.id, "voter-1", "docs/x.md token=abc123secretvalue 2026-10-01");
    const note = (await voteRow(l.id, "voter-1", "confirm"))?.note ?? "";
    expect(note).toContain("[redacted]");
    expect(note).not.toContain("abc123");
  });

  it("confirm refresh: the same person within 30 days is a no-op that keeps the first note", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    confirm(l.id, "voter-1", "first note, 2026-10-01");
    await ageVote(l.id, "voter-1", "confirm", 10);
    const before = await voteRow(l.id, "voter-1", "confirm");
    const r = confirm(l.id, "voter-1", "second note, 2026-10-11");
    expect(r.changed).toBe(false);
    expect(r.learning.score).toBe(2);
    const after = await voteRow(l.id, "voter-1", "confirm");
    expect(after?.note).toBe("first note, 2026-10-01");
    expect(after?.created_at).toBe(before?.created_at);
    const audits = getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'confirm' AND entity_id = ?").get(l.id) as { n: number };
    expect(audits.n).toBe(1);
  });

  it("after 30 days the same person refreshes note and date, and the score still counts them once", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm, voteCounts } = await import("../lib/learnings");
    confirm(l.id, "voter-1", "first note, 2026-08-01");
    await ageVote(l.id, "voter-1", "confirm", 31);
    const before = await voteRow(l.id, "voter-1", "confirm");
    const r = confirm(l.id, "voter-1", "second note, 2026-10-02");
    expect(r.changed).toBe(true);
    expect(r.learning.score).toBe(2);
    expect(voteCounts(l.id).confirm).toBe(1);
    const after = await voteRow(l.id, "voter-1", "confirm");
    expect(after?.note).toBe("second note, 2026-10-02");
    expect(after!.created_at > before!.created_at).toBe(true);
  });

  it("score counts a voter once and different voters add up", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm } = await import("../lib/learnings");
    confirm(l.id, "voter-1", "src/a.ts, 2026-10-01");
    expect(confirm(l.id, "voter-1", "src/a.ts, 2026-10-02").learning.score).toBe(2);
    expect(confirm(l.id, "voter-2", "src/b.ts, 2026-10-02").learning.score).toBe(4);
  });

  it("confirm and helpful coexist, flag stays out of the score", async () => {
    await seedUsers();
    const l = await mk();
    const { confirm, vote, flag, getById } = await import("../lib/learnings");
    vote(l.id, "voter-1", "helpful");
    confirm(l.id, "voter-1", "src/a.ts, 2026-10-01");
    expect(getById(l.id)!.score).toBe(3);
    flag(l.id, "voter-2");
    expect(getById(l.id)!.score).toBe(3);
  });

  it("confirm emits the existing vote event with kind confirm", async () => {
    await seedUsers();
    const l = await mk();
    const { subscribe } = await import("../lib/events");
    const seen: Array<{ type: string; payload?: { kind?: string } }> = [];
    subscribe((e) => { if (e.type === "vote") seen.push(e as never); });
    const { confirm } = await import("../lib/learnings");
    confirm(l.id, "voter-1", "src/a.ts, 2026-10-01");
    expect(seen).toHaveLength(1);
    expect(seen[0].payload?.kind).toBe("confirm");
  });
});

describe("recentNotes()", () => {
  async function moreVoters() {
    const { upsertUser } = await import("../lib/users");
    for (let i = 3; i <= 7; i++) upsertUser({ id: `voter-${i}`, email: `v${i}@example.com`, name: `Voter ${i}`, roles: [] });
  }

  it("returns the latest 5 confirmations and flags, newest first, as plain data", async () => {
    await seedUsers();
    await moreVoters();
    const l = await mk();
    const { confirm, flag, recentNotes, RECENT_NOTES_LIMIT } = await import("../lib/learnings");
    // Seven rows, aged so the order is unambiguous: voter-N is N days old (voter-1 newest).
    confirm(l.id, "voter-1", "note c1");
    confirm(l.id, "voter-2", "note c2");
    confirm(l.id, "voter-3", "note c3");
    confirm(l.id, "voter-4", "note c4");
    flag(l.id, "voter-5", "ui", "note f5");
    flag(l.id, "voter-6", "ui", "note f6");
    flag(l.id, "voter-7", "ui", "note f7");
    for (let i = 1; i <= 7; i++) await ageVote(l.id, `voter-${i}`, i <= 4 ? "confirm" : "flag", i);
    const notes = recentNotes(l.id);
    expect(RECENT_NOTES_LIMIT).toBe(5);
    expect(notes).toHaveLength(5);
    expect(notes.map((n) => n.note)).toEqual(["note c1", "note c2", "note c3", "note c4", "note f5"]);
    expect(notes[0]).toMatchObject({ kind: "confirm", voterName: "Bob", note: "note c1" });
    expect(typeof notes[0].at).toBe("string");
    expect(notes[4].kind).toBe("flag");
  });

  it("voterName falls back to the voter id when the user has no name", async () => {
    await seedUsers();
    const l = await mk();
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE users SET name = NULL WHERE id = 'voter-1'").run();
    const { confirm, recentNotes } = await import("../lib/learnings");
    confirm(l.id, "voter-1", "src/a.ts, 2026-10-01");
    expect(recentNotes(l.id)[0].voterName).toBe("voter-1");
  });

  it("a flag without a note comes back with note null", async () => {
    await seedUsers();
    const l = await mk();
    const { flag, recentNotes } = await import("../lib/learnings");
    flag(l.id, "voter-1");
    expect(recentNotes(l.id)).toEqual([expect.objectContaining({ kind: "flag", note: null, voterName: "Bob" })]);
  });

  it("helpful and kudos rows are not in recentNotes", async () => {
    await seedUsers();
    const l = await mk();
    const { vote, giveKudos, recentNotes } = await import("../lib/learnings");
    vote(l.id, "voter-1", "helpful");
    giveKudos(l.id, "voter-2", "kudos note");
    expect(recentNotes(l.id)).toEqual([]);
  });
});
