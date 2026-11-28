import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-related-on-save-test-"));
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
  upsertUser({ id: "author-2", email: "b@example.com", name: "Bob", roles: [] });
}

// A changed fact, worded unlike the memory it replaces: no close match, but the old one is what
// a search on the new text finds first.
const OLD = {
  title: "Integration tests need the shared staging database",
  body: "The integration suite connects to the shared staging database. Export DB_HOST before you start the suite, or every test fails at setup.",
  tags: ["testing"],
};
const NEW = {
  title: "Integration suite runs against a throwaway container now",
  body: "The staging database is no longer used by the integration tests. DB_HOST is ignored; the suite starts Postgres itself.",
  tags: ["testing"],
};
// Shares a word or two with NEW, nothing more.
const UNRELATED = {
  title: "Release notes are written from the merged pull request titles",
  body: "The release job collects the titles since the last tag. Fix a wrong title before the merge, the notes are not edited by hand.",
  tags: ["release"],
};

describe("related memories on a save with no close match", () => {
  it("lists the memory a changed fact replaces, marked related, and the hint names the one call", async () => {
    await seedUsers();
    const { create, findSimilar, nearMatches, similarHint, createWithSupersedes, getById, RELATED_LEAD } = await import("../lib/learnings");
    const old = create({ authorId: "author-1", ...OLD });
    create({ authorId: "author-1", ...UNRELATED });
    // The duplicate check finds nothing: the write is silent without the related list.
    expect(findSimilar(NEW)).toEqual([]);
    const created = create({ authorId: "author-2", ...NEW });

    const similar = nearMatches(created);
    expect(similar.map((m) => m.id)).toEqual([old.id]);
    expect(similar[0]).toMatchObject({ related: true, verdict: "similar", excerpt: OLD.body, authorName: "Ada" });
    expect(similar[0].score).toBeGreaterThan(0);
    expect(similar[0].differs).toBeUndefined();

    const hint = similarHint(created, similar);
    expect(hint.startsWith(RELATED_LEAD)).toBe(true);
    expect(hint).not.toContain("Close matches exist");
    expect(hint).toContain("cannot both be true");
    expect(hint).toContain("Having verified your own fact is the check this needs; you do not have to verify the old one again.");
    // The hint adds no duty of its own: one that asked for the checked source did worse in a benchmark pass.
    expect(hint).not.toContain("in the body");
    expect(hint).toContain(`supersedes: ["<its id>", "${created.id}"]`);

    // The call the hint names: the same text again, replacing the old memory and the copy just saved.
    const final = createWithSupersedes({ authorId: "author-2", ...NEW }, [old.id, created.id], "mcp");
    expect(getById(old.id)?.status).toBe("archived");
    expect(getById(created.id)?.status).toBe("archived");
    expect(getById(final.id)?.status).toBe("active");
  });

  it("lists nothing when the memories only share a few words", async () => {
    await seedUsers();
    const { create, nearMatches } = await import("../lib/learnings");
    create({ authorId: "author-1", ...UNRELATED });
    create({
      authorId: "author-1",
      title: "Database backups run at night",
      body: "The backup job copies the volume to object storage every night and keeps thirty copies.",
      tags: ["operations"],
    });
    const created = create({ authorId: "author-2", ...NEW });
    expect(nearMatches(created)).toEqual([]);
  });

  it("lists nothing in an empty store, and never the new memory itself", async () => {
    await seedUsers();
    const { create, nearMatches } = await import("../lib/learnings");
    const created = create({ authorId: "author-2", ...NEW });
    expect(nearMatches(created)).toEqual([]);
  });

  it("leaves out a standard, a decision and an archived memory", async () => {
    await seedUsers();
    const { create, nearMatches, retire } = await import("../lib/learnings");
    create({ authorId: "author-1", ...OLD, kind: "standard" });
    create({ authorId: "author-1", ...OLD, kind: "decision", confirmNotDuplicate: true });
    const gone = create({ authorId: "author-1", ...OLD, confirmNotDuplicate: true });
    retire(gone.id, "author-1", "mcp");
    const created = create({ authorId: "author-2", ...NEW });
    expect(nearMatches(created)).toEqual([]);
  });

  it("needs a third of the terms, and a count", async () => {
    const { holdsEnoughTerms } = await import("../lib/learnings");
    expect(holdsEnoughTerms("6/16")).toBe(true);
    expect(holdsEnoughTerms("4/12")).toBe(true);
    expect(holdsEnoughTerms("5/16")).toBe(false);
    expect(holdsEnoughTerms("3/10")).toBe(false);
    expect(holdsEnoughTerms("0/0")).toBe(false);
    expect(holdsEnoughTerms(undefined)).toBe(false);
  });

  it("lists nothing for a text with no usable search terms, where search falls back to the plain list", async () => {
    await seedUsers();
    const { create, search, nearMatches } = await import("../lib/learnings");
    create({ authorId: "author-1", ...OLD });
    create({ authorId: "author-1", ...UNRELATED });
    const created = create({ authorId: "author-2", title: "It is on", body: "So it is." });
    // The search itself answers with the newest memories, without a count of matched terms.
    const listed = search(`${created.title} ${created.body}`, {}, 6);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((r) => r.matchedTerms === undefined)).toBe(true);
    expect(nearMatches(created)).toEqual([]);
  });

  it("lists at most RELATED_ON_SAVE_MAX memories", async () => {
    await seedUsers();
    const { create, nearMatches, RELATED_ON_SAVE_MAX } = await import("../lib/learnings");
    for (let i = 0; i < RELATED_ON_SAVE_MAX + 2; i++) {
      create({ authorId: "author-1", ...OLD, confirmNotDuplicate: true });
    }
    const created = create({ authorId: "author-2", ...NEW });
    const similar = nearMatches(created);
    expect(similar).toHaveLength(RELATED_ON_SAVE_MAX);
    expect(similar.every((m) => m.related)).toBe(true);
  });

  it("keeps to the close matches when there is one", async () => {
    await seedUsers();
    const { create, nearMatches, similarHint } = await import("../lib/learnings");
    create({ authorId: "author-1", ...OLD });
    const close = create({
      authorId: "author-1",
      title: "The integration suite needs a container runtime",
      body: "The suite starts Postgres itself, so the machine needs a container runtime. DB_HOST is ignored.",
      tags: ["testing"],
    });
    const created = create({ authorId: "author-2", ...NEW });
    const similar = nearMatches(created);
    // The old memory would be listed as related, but a close match exists: only that one is shown.
    expect(similar.map((m) => m.id)).toEqual([close.id]);
    expect(similar.some((m) => m.related)).toBe(false);
    const hint = similarHint(created, similar);
    expect(hint.startsWith("Close matches exist.")).toBe(true);
    expect(hint).toContain("cannot both be true");
  });
});

describe("similarHint and someone else's standard or decision", () => {
  it("says to flag it, not to replace it", async () => {
    await seedUsers();
    const { create, similarHint } = await import("../lib/learnings");
    const standard = create({ authorId: "author-1", ...OLD, kind: "standard" });
    const hint = similarHint({ id: "new-id", kind: "learning", author_id: "author-2" }, [
      { id: standard.id, title: standard.title, score: 0.4, verdict: "similar", author_id: "author-1" },
    ] as never);
    expect(hint).toBe(
      `Close matches exist. ${standard.id} is someone else's standard or decision: if yours contradicts it, flag it with your evidence. Do not replace it, unless you are a BAB maintainer.`,
    );
  });

  it("names the call for the learning and the flag for the standard when both are listed", async () => {
    await seedUsers();
    const { create, similarHint } = await import("../lib/learnings");
    const standard = create({ authorId: "author-1", ...OLD, kind: "standard" });
    const learning = create({ authorId: "author-1", ...UNRELATED });
    const hint = similarHint({ id: "new-id", kind: "learning", author_id: "author-2" }, [
      { id: standard.id, title: standard.title, score: 0.4, verdict: "similar", author_id: "author-1" },
      { id: learning.id, title: learning.title, score: 0.4, verdict: "similar", author_id: "author-1" },
    ] as never);
    expect(hint).toContain('supersedes: ["<its id>", "new-id"]');
    expect(hint).not.toContain("of another kind");
    expect(hint).toContain(`${standard.id} is someone else's standard or decision`);
    expect(hint).toContain("you do not have to verify the old one again");
  });

  it("treats every standard and decision as someone else's when the author is not given", async () => {
    await seedUsers();
    const { create, similarHint } = await import("../lib/learnings");
    const standard = create({ authorId: "author-2", ...OLD, kind: "standard" });
    const hint = similarHint({ id: "new-id", kind: "learning" }, [
      { id: standard.id, title: standard.title, score: 0.4, verdict: "similar", author_id: "author-2" },
    ] as never);
    expect(hint).toContain(`${standard.id} is someone else's standard or decision`);
    expect(hint).not.toContain("supersedes");
  });

  it("says your own decision needs the user's yes, and names no call for it", async () => {
    await seedUsers();
    const { create, similarHint } = await import("../lib/learnings");
    const decision = create({ authorId: "author-2", ...OLD, kind: "decision" });
    const hint = similarHint({ id: "new-id", kind: "learning", author_id: "author-2" }, [
      { id: decision.id, title: decision.title, score: 0.4, verdict: "similar", author_id: "author-2" },
    ] as never);
    expect(hint).toBe(`Close matches exist. ${decision.id} is your own decision: replacing it needs the user's yes.`);
  });

  it("leaves the sentence out for your own standard and for a learning", async () => {
    await seedUsers();
    const { create, similarHint } = await import("../lib/learnings");
    const standard = create({ authorId: "author-2", ...OLD, kind: "standard" });
    const learning = create({ authorId: "author-1", ...UNRELATED });
    const hint = similarHint({ id: "new-id", kind: "learning", author_id: "author-2" }, [
      { id: standard.id, title: standard.title, score: 0.4, verdict: "similar", author_id: "author-2" },
      { id: learning.id, title: learning.title, score: 0.4, verdict: "similar", author_id: "author-1" },
    ] as never);
    expect(hint).not.toContain("flag it with your evidence");
  });
});
