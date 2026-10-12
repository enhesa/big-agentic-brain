import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-learnings-flag-note-test-"));
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

describe("flag notes", () => {
  it("flag stores an optional note, redacted, in votes.note", async () => {
    await seedUsers();
    const l = await mk();
    const { flag } = await import("../lib/learnings");
    flag(l.id, "voter-1", "ui", "stale: moved to src/lib/x.ts 2026-10-01");
    expect((await voteRow(l.id, "voter-1", "flag"))?.note).toBe("stale: moved to src/lib/x.ts 2026-10-01");
    // Redaction is shared with confirm (which tests the secret shape); an outside address shows it here.
    flag(l.id, "voter-2", "ui", "see docs/y.md, ask someone@outside-example.org");
    const redacted = (await voteRow(l.id, "voter-2", "flag"))?.note ?? "";
    expect(redacted).toContain("[redacted email]");
    expect(redacted).not.toContain("outside-example");
  });

  it("flag without a note still works and stores null", async () => {
    await seedUsers();
    const l = await mk();
    const { flag } = await import("../lib/learnings");
    flag(l.id, "voter-1", "ui", "   ");
    expect((await voteRow(l.id, "voter-1", "flag"))?.note).toBeNull();
  });

  it("flag refuses a note over 300 characters and records no flag", async () => {
    await seedUsers();
    const l = await mk();
    const { flag, voteCounts } = await import("../lib/learnings");
    expect(() => flag(l.id, "voter-1", "ui", "a".repeat(301))).toThrow(/300 characters/);
    expect(voteCounts(l.id).flag).toBe(0);
    expect(() => flag(l.id, "voter-1", "ui", "a".repeat(300))).not.toThrow();
  });

  it("a repeat flag keeps created_at and only replaces the note when a new one is given", async () => {
    await seedUsers();
    const l = await mk();
    const { flag } = await import("../lib/learnings");
    flag(l.id, "voter-1", "ui", "note A");
    await ageVote(l.id, "voter-1", "flag", 5);
    const old = await voteRow(l.id, "voter-1", "flag");
    flag(l.id, "voter-1", "ui");
    expect(await voteRow(l.id, "voter-1", "flag")).toEqual(old);
    flag(l.id, "voter-1", "ui", "note B");
    expect(await voteRow(l.id, "voter-1", "flag")).toEqual({ note: "note B", created_at: old!.created_at });
  });

  it("flag calls without a note behave as before on the web path; the agent path needs one", async () => {
    await seedUsers();
    const l = await mk();
    const { flag, voteCounts } = await import("../lib/learnings");
    flag(l.id, "voter-1");
    flag(l.id, "voter-2", "ui");
    expect(voteCounts(l.id).flag).toBe(2);
    expect((await voteRow(l.id, "voter-1", "flag"))?.note).toBeNull();
  });
});

describe("auto-archive by kind", () => {
  // Learnings and practices are kept by the fleet (owner, 2026-10-02); a maintainer decides about
  // a standard or a decision, so two flags leave those visible with standing weak.
  it("two flags archive a learning or a practice, not a standard or decision", async () => {
    await seedUsers();
    const { flag, getById } = await import("../lib/learnings");
    for (const kind of ["learning", "practice", "standard", "decision"] as const) {
      const l = await mk({ kind });
      flag(l.id, "voter-1");
      flag(l.id, "voter-2");
      expect(getById(l.id)!.status).toBe(kind === "learning" || kind === "practice" ? "archived" : "active");
    }
  });

  it("a flagged practice is audited as an auto-archive and drops out of the default list", async () => {
    await seedUsers();
    const l = await mk({ kind: "practice", title: "Flagged practice gone", body: "gone after two flags" });
    const { flag, list, getById } = await import("../lib/learnings");
    flag(l.id, "voter-1");
    expect(getById(l.id)!.status).toBe("active");
    flag(l.id, "voter-2");
    expect(getById(l.id)!.status).toBe("archived");
    expect(list().map((x) => x.id)).not.toContain(l.id);
    const { getDb } = await import("../lib/db");
    const audits = getDb().prepare("SELECT action FROM audit_log WHERE entity_id = ?").all(l.id) as Array<{ action: string }>;
    expect(audits.filter((a) => a.action === "auto_archive")).toHaveLength(1);
  });

  it("a flagged standard stays visible in the default list and search", async () => {
    await seedUsers();
    const l = await mk({ kind: "standard", title: "Flagged rule visible", body: "visible after flags" });
    const { flag, list, search } = await import("../lib/learnings");
    flag(l.id, "voter-1");
    flag(l.id, "voter-2");
    expect(list().map((x) => x.id)).toContain(l.id);
    expect(search("").map((x) => x.id)).toContain(l.id);
    expect(search("flagged rule visible").map((x) => x.id)).toContain(l.id);
  });

  it("a standard with 2 flags has standing weak and a reason mentioning 2 flags", async () => {
    await seedUsers();
    const l = await mk({ kind: "standard" });
    const { flag, standingsFor, getById } = await import("../lib/learnings");
    flag(l.id, "voter-1");
    flag(l.id, "voter-2");
    expect(standingsFor([getById(l.id)!]).get(l.id)).toMatchObject({ standing: "weak" });
    expect(standingsFor([getById(l.id)!]).get(l.id)!.standingReason).toContain("2 flags");
  });

  it("a flagged mirror with 2 flags is weak; flags are still audited and counted", async () => {
    await seedUsers();
    process.env.BAB_MAINTAINERS = "author-1";
    try {
      const l = await mk({
        kind: "decision",
        source: "confluence",
        sourceUrl: "https://wiki.example.com/wiki/spaces/E/pages/5",
        sourceVersion: 1,
        expiresAt: null,
      });
      const { flag, voteCounts, standingsFor, getById } = await import("../lib/learnings");
      flag(l.id, "voter-1");
      flag(l.id, "voter-2");
      expect(voteCounts(l.id).flag).toBe(2);
      expect(standingsFor([getById(l.id)!]).get(l.id)).toMatchObject({ standing: "weak", points: -4 });
      const { getDb } = await import("../lib/db");
      const audits = getDb().prepare("SELECT action FROM audit_log WHERE entity_id = ?").all(l.id) as Array<{ action: string }>;
      expect(audits.filter((a) => a.action === "flag")).toHaveLength(2);
      expect(audits.some((a) => a.action === "auto_archive")).toBe(false);
    } finally {
      delete process.env.BAB_MAINTAINERS;
    }
  });

  it("a learning flagged by the same person twice does not archive", async () => {
    await seedUsers();
    const l = await mk();
    const { flag, getById } = await import("../lib/learnings");
    flag(l.id, "voter-1");
    flag(l.id, "voter-1", "ui", "second look");
    expect(getById(l.id)!.status).toBe("active");
  });
});
