import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * BAB is kept by a fleet of independent agents: anyone identified may retire
 * a memory, a non-author with a one-line evidence note (a required field, so the server checks
 * it). Which memories an agent should leave alone (someone else's standard or decision) is a
 * guardrail in the texts, not a server check. The note is stored as a `retire` vote row and shown
 * as the memory's lastRetire (who, when, why), not among the five recent notes.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-retire-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
  upsertUser({ id: "voter-1", email: "b@example.com", name: "Bob", roles: [] });
}

let seq = 0;
async function mk(kind: "learning" | "practice" | "standard" | "decision" = "learning") {
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({ authorId: "author-1", title: `Fixture ${seq} zq${seq}`, body: `Body ${seq} about topic zq${seq}x`, confirmNotDuplicate: true, kind });
}

async function retireAudits(id: string) {
  const { getDb } = await import("../lib/db");
  const rows = getDb()
    .prepare("SELECT actor_id, via, details FROM audit_log WHERE action = 'retire' AND entity_id = ? ORDER BY id")
    .all(id) as { actor_id: string; via: string; details: string | null }[];
  return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

describe("retire by anyone", () => {
  it("a non-author with a note retires it, and the audit has by and note", async () => {
    await seedUsers();
    const l = await mk();
    const { retire } = await import("../lib/learnings");
    const out = retire(l.id, "voter-1", "mcp", "Replaced by the new pipeline, azure-pipelines.yml 2026-10-02");
    expect(out.status).toBe("archived");
    expect(await retireAudits(l.id)).toEqual([
      {
        actor_id: "voter-1",
        via: "mcp",
        details: { by: "other", note: "Replaced by the new pipeline, azure-pipelines.yml 2026-10-02" },
      },
    ]);
  });

  it("a non-author without a note is refused and nothing changes", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, getById } = await import("../lib/learnings");
    const { ValidationError } = await import("../lib/errors");
    for (const n of [undefined, null, "", "   "]) {
      expect(() => retire(l.id, "voter-1", "mcp", n as string | null | undefined)).toThrow(ValidationError);
    }
    expect(() => retire(l.id, "voter-1", "mcp")).toThrow(/note is required/);
    expect(getById(l.id)!.status).toBe("active");
    expect(await retireAudits(l.id)).toEqual([]);
  });

  it("the author retires without a note", async () => {
    await seedUsers();
    const l = await mk();
    const { retire } = await import("../lib/learnings");
    expect(retire(l.id, "author-1", "mcp").status).toBe("archived");
    expect(await retireAudits(l.id)).toEqual([{ actor_id: "author-1", via: "mcp", details: { by: "author", note: null } }]);
  });

  it("the author may add a note, and it is stored and shown too", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, lastRetire, recentNotes } = await import("../lib/learnings");
    const out = retire(l.id, "author-1", "ui", "No longer true after the move to AKS");
    expect(lastRetire(out)).toEqual({ kind: "retire", voterName: "Ada", note: "No longer true after the move to AKS", at: expect.any(String) });
    // Its own field, not one of the five shared note slots.
    expect(recentNotes(l.id)).toEqual([]);
  });

  it("a practice can be retired by anyone with a note", async () => {
    await seedUsers();
    const l = await mk("practice");
    const { retire } = await import("../lib/learnings");
    expect(retire(l.id, "voter-1", "mcp", "Checked the repo, the rule is gone").status).toBe("archived");
  });

  it("the note is redacted, capped at 300 characters, and shown as lastRetire", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, lastRetire } = await import("../lib/learnings");
    const out = retire(l.id, "voter-1", "mcp", "see docs/x.md token=abc123secretvalue 2026-10-02");
    const shown = lastRetire(out)!;
    expect(shown).toMatchObject({ kind: "retire", voterName: "Bob" });
    expect(shown.note).toContain("[redacted]");
    expect(shown.note).not.toContain("abc123");
    const audit = (await retireAudits(l.id))[0];
    expect(audit.details.note).toContain("[redacted]");
    expect(JSON.stringify(audit.details)).not.toContain("abc123");

    const long = await mk();
    expect(() => retire(long.id, "voter-1", "mcp", "a".repeat(301))).toThrow(/300 characters/);
    expect(retire(long.id, "voter-1", "mcp", "a".repeat(300)).status).toBe("archived");
  });

  it("a retirement note does not touch the score or the vote counts", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, voteCounts, getById } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Checked, outdated");
    expect(voteCounts(l.id)).toEqual({ helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 0 });
    expect(getById(l.id)!.score).toBe(0);
  });

  it("an already archived or unknown learning is still refused", async () => {
    await seedUsers();
    const l = await mk();
    const { retire } = await import("../lib/learnings");
    const { ConflictError, NotFoundError } = await import("../lib/errors");
    retire(l.id, "voter-1", "mcp", "Checked, outdated");
    expect(() => retire(l.id, "voter-1", "mcp", "Again")).toThrow(ConflictError);
    expect(() => retire("nope", "voter-1", "mcp", "x")).toThrow(NotFoundError);
  });

  it("GET /api/learnings/:id carries the retire note as lastRetire, and recentNotes has none", async () => {
    await seedUsers();
    const l = await mk();
    const { retire } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Checked, the service was removed");
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": "bob.reader@example.com", "x-bab-actor-name": "Bob" }),
    }));
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request("http://x/api/learnings/" + l.id) as never, { params: Promise.resolve({ id: l.id }) });
    const json = await res.json();
    expect(json.lastRetire).toEqual({ kind: "retire", voterName: "Bob", note: "Checked, the service was removed", at: expect.any(String) });
    expect(json.recentNotes).toEqual([]);
  });
});
