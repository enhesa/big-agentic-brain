import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-learnings-test-"));
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

describe("learnings.create", () => {
  it("redacts secrets in title and body", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const l = create({
      authorId: "author-1",
      title: "Token leaked",
      body: "Use Bearer abc123.def456-ghi to call the API",
    });
    expect(l.body).toContain("[redacted]");
    expect(l.body).not.toContain("abc123");
  });

  it("redacts a secret in repo and in a tag", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const l = create({
      authorId: "author-1",
      title: "T",
      body: "B",
      repo: "org/repo token=abc123secretvalue",
      tags: ["Bearer abc123.def456-ghi"],
    });
    expect(l.repo).toContain("[redacted]");
    expect(l.repo).not.toContain("abc123secretvalue");
    const tags = JSON.parse(l.tags) as string[];
    expect(tags[0]).toContain("[redacted]");
    expect(tags[0]).not.toContain("abc123");
  });
});

describe("learnings.search", () => {
  it("finds a learning by word via FTS", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");
    create({
      authorId: "author-1",
      title: "Use runTest.sh not dotnet test",
      body: "CI wires up loggers and containers via runTest.sh.",
      tags: ["ci"],
    });
    create({
      authorId: "author-1",
      title: "Unrelated learning",
      body: "Something about Kafka consumer groups.",
    });

    const results = search("runTest");
    expect(results.length).toBe(1);
    expect(results[0].title).toContain("runTest.sh");
    expect(results[0].snippet).toBeTruthy();
  });
});

// Search used to ORDER BY vote score alone, ignoring how well a row matched at all,
// so a perfect title hit with no votes lost to a passing body mention with two
// upvotes. These pin the ranking contract: relevance leads, votes and recency nudge.
describe("search ranking", () => {
  it("a title match beats a body mention that has more votes", async () => {
    await seedUsers();
    const { create, search, vote } = await import("../lib/learnings");

    const popular = create({
      authorId: "author-1",
      title: "Deployment checklist",
      body: "Remember to check the dashboard. Someone once asked about kafka here.",
    });
    create({
      authorId: "author-1",
      title: "Kafka message size limit is 200KB",
      body: "Offload anything larger to Blob and pass a reference.",
    });
    // Stack the deck the way the old ordering rewarded.
    vote(popular.id, "voter-1", "helpful");
    vote(popular.id, "voter-2", "helpful");

    const results = search("kafka");
    expect(results.length).toBe(2);
    expect(results[0].title).toContain("Kafka message size");
  });

  // Two entries that match the query about equally well, so only the boosts can
  // separate them. They cannot be identical: create() rejects a near-copy as a 409.
  it("among equally good matches, the more useful one wins", async () => {
    await seedUsers();
    const { create, search, vote } = await import("../lib/learnings");

    create({
      authorId: "author-1",
      title: "Widget rotation clockwise",
      body: "Turn the dial to the right until it stops.",
    });
    const voted = create({
      authorId: "author-1",
      title: "Widget rotation anticlockwise",
      body: "Turn the dial to the left until it stops.",
    });
    vote(voted.id, "voter-1", "helpful");
    vote(voted.id, "voter-2", "helpful");

    const results = search("widget rotation");
    expect(results.length).toBe(2);
    expect(results[0].id).toBe(voted.id);
  });

  it("a tag hit outranks the same word buried in a body", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");

    create({
      authorId: "author-1",
      title: "Release notes for the March drop",
      body: "Lots of prose here and somewhere in it the word egress appears once.",
    });
    const tagged = create({
      authorId: "author-1",
      title: "Opening an outbound host",
      body: "Ask an admin, who approves the rule.",
      tags: ["egress"],
    });

    const results = search("egress");
    expect(results[0].id).toBe(tagged.id);
  });
});

describe("search recall", () => {
  it("falls back to any-term when no entry contains every word", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");

    create({
      authorId: "author-1",
      title: "Kafka message size limit is 200KB",
      body: "Offload larger payloads to Blob and pass a reference.",
    });

    // Typed as a question: no single entry holds all of these words, and the old
    // implicit AND therefore returned nothing at all.
    const results = search("how do we size kafka messages");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain("Kafka message size");
  });

  it("still returns nothing when no term matches anything", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");
    create({ authorId: "author-1", title: "Kafka limits", body: "Payload sizes." });

    expect(search("helicopter marzipan").length).toBe(0);
  });

  it("a single-word miss does not widen into unrelated results", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");
    create({ authorId: "author-1", title: "Kafka limits", body: "Payload sizes." });

    expect(search("helicopter").length).toBe(0);
  });
});

describe("search pagination (offset/searchTotal)", () => {
  it("offset walks further into the same ranked order, and searchTotal counts every match", async () => {
    await seedUsers();
    const { create, search, searchTotal } = await import("../lib/learnings");
    for (let i = 0; i < 5; i++) {
      create({ authorId: "author-1", title: `Kafka tuning note ${i}`, body: "Retry with backoff.", confirmNotDuplicate: true });
    }

    const total = searchTotal("Kafka tuning", {});
    expect(total).toBe(5);

    const page1 = search("Kafka tuning", {}, 2, 0);
    const page2 = search("Kafka tuning", {}, 2, 2);
    const page3 = search("Kafka tuning", {}, 2, 4);
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page3).toHaveLength(1);
    // No row repeats or gets skipped across the three pages.
    const ids = [...page1, ...page2, ...page3].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("an offset past the end returns no rows, without the any-term widening a page 1 miss would get", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");
    create({ authorId: "author-1", title: "Kafka limits", body: "Payload sizes." });

    expect(search("Kafka limits", {}, 5, 5)).toEqual([]);
  });

  it("page 2 of a widened (any-term) search still widens, matching searchTotal", async () => {
    await seedUsers();
    const { create, search, searchTotal } = await import("../lib/learnings");
    create({ authorId: "author-1", title: "Kafka notes", body: "Broker settings." });
    create({ authorId: "author-1", title: "Tuning guide", body: "Heap sizes.", confirmNotDuplicate: true });

    expect(searchTotal("kafka tuning", {})).toBe(2);
    const page1 = search("kafka tuning", {}, 1, 0);
    const page2 = search("kafka tuning", {}, 1, 1);
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page2[0].id).not.toBe(page1[0].id);
  });

  it("offset also paginates the plain (no-FTS-query) listing", async () => {
    await seedUsers();
    const { create, search, searchTotal } = await import("../lib/learnings");
    for (let i = 0; i < 3; i++) {
      create({ authorId: "author-1", title: `Plain note ${i}`, body: "Body text.", confirmNotDuplicate: true });
    }

    expect(searchTotal("", {})).toBe(3);
    expect(search("", {}, 2, 0)).toHaveLength(2);
    expect(search("", {}, 2, 2)).toHaveLength(1);
  });
});

describe("learnings votes", () => {
  it("rejects a self-vote", async () => {
    await seedUsers();
    const { create, vote } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "T", body: "B" });
    expect(() => vote(l.id, "author-1", "helpful")).toThrow(/own learning/i);
  });

  it("allows only one vote per identity per kind", async () => {
    await seedUsers();
    const { create, vote } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "T", body: "B" });

    const v1 = vote(l.id, "voter-1", "helpful");
    expect(v1.learning.score).toBe(1);
    expect(v1.changed).toBe(true);

    // second vote of the same kind from the same voter is an explicit no-op
    const v2 = vote(l.id, "voter-1", "helpful");
    expect(v2.learning.score).toBe(1);
    expect(v2.changed).toBe(false);
  });

  it("archives after two distinct flags", async () => {
    await seedUsers();
    const { create, flag, getById } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "T", body: "B" });

    flag(l.id, "voter-1");
    expect(getById(l.id)!.status).toBe("active");

    flag(l.id, "voter-2");
    expect(getById(l.id)!.status).toBe("archived");
  });
});

describe("ageInfo", () => {
  it("computes whole days since created_at and until expires_at", async () => {
    const { ageInfo } = await import("../lib/learnings");
    const now = new Date("2026-06-01T00:00:00Z").getTime();
    const info = ageInfo(
      { created_at: "2026-03-01 00:00:00", expires_at: "2026-06-15" },
      now,
    );
    expect(info.ageDays).toBe(92);
    expect(info.expiresInDays).toBe(14);
  });

  it("returns a negative expiresInDays once the valid-until date has passed, and null with no date", async () => {
    const { ageInfo } = await import("../lib/learnings");
    const now = new Date("2026-06-01T00:00:00Z").getTime();
    expect(ageInfo({ created_at: "2026-01-01 00:00:00", expires_at: "2026-05-20" }, now).expiresInDays).toBe(-12);
    expect(ageInfo({ created_at: "2026-01-01 00:00:00", expires_at: null }, now).expiresInDays).toBeNull();
  });
});

describe("learnings.keepLearning ('keep')", () => {
  it("on a live memory it moves nothing: same status, no date put on it, no message, changed false", async () => {
    await seedUsers();
    const { create, keepLearning, getById } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const l = create({ authorId: "author-1", title: "Still true", body: "B" });
    getDb().prepare("UPDATE learnings SET updated_at = '2026-01-01 00:00:00' WHERE id = ?").run(l.id);

    const kept = keepLearning(l.id, "author-1");
    expect(kept.changed).toBe(false);
    expect(kept).not.toHaveProperty("message");
    expect(kept.learning.status).toBe("active");
    expect(kept.learning.expires_at).toBeNull();
    // A keep is a statement that the memory holds, not an edit of it.
    expect(getById(l.id)!.updated_at).toBe("2026-01-01 00:00:00");
  });

  it("every keep is on record, from anyone and with or without a valid-until date: a keep row in votes and a keep audit row", async () => {
    await seedUsers();
    const { create, keepLearning, getById } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const { todayUtc, addDaysUtc } = await import("../lib/dates");
    const soon = addDaysUtc(todayUtc(), 10);
    const undated = create({ authorId: "author-1", title: "Not yours, still true", body: "B" });
    const dated = create({
      authorId: "author-1",
      title: "Freeze until the end of the month",
      body: "B2",
      expiresAt: soon,
      confirmNotDuplicate: true,
    });

    keepLearning(undated.id, "voter-1", "mcp"); // anyone identified may keep, not only the author
    keepLearning(dated.id, "author-1", "ui");

    const audits = (id: string, action: string) =>
      getDb().prepare("SELECT actor_id, via FROM audit_log WHERE action = ? AND entity_id = ?").all(action, id);
    const keeps = (id: string) =>
      getDb().prepare("SELECT voter_id, note FROM votes WHERE learning_id = ? AND kind = 'keep'").all(id);
    expect(audits(undated.id, "keep")).toEqual([{ actor_id: "voter-1", via: "mcp" }]);
    expect(keeps(undated.id)).toEqual([{ voter_id: "voter-1", note: null }]);
    expect(audits(dated.id, "keep")).toEqual([{ actor_id: "author-1", via: "ui" }]);
    expect(keeps(dated.id)).toEqual([{ voter_id: "author-1", note: null }]);
    // Nothing is extended any more, so nothing says so, and a date its author chose stays as it was.
    for (const id of [undated.id, dated.id]) expect(audits(id, "expiry-extended")).toEqual([]);
    expect(getById(dated.id)!.expires_at).toBe(soon);
  });

  it("keeping twice is fine: each keep is audited, and the person still has one keep row", async () => {
    await seedUsers();
    const { create, keepLearning } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const l = create({ authorId: "author-1", title: "Healthy, kept twice", body: "B" });

    expect(keepLearning(l.id, "author-1").learning.status).toBe("active");
    expect(keepLearning(l.id, "author-1").learning.status).toBe("active");

    const count = (sql: string) => (getDb().prepare(sql).get(l.id) as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'keep' AND entity_id = ?")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM votes WHERE kind = 'keep' AND learning_id = ?")).toBe(1);
  });

  it("refuses a deleted memory", async () => {
    await seedUsers();
    const { create, deleteOwn, keepLearning } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "Gone", body: "B" });
    deleteOwn(l.id, "author-1");
    expect(() => keepLearning(l.id, "voter-1")).toThrow(/deleted by its author/i);
  });

  it("404s on an unknown learning id", async () => {
    await seedUsers();
    const { keepLearning } = await import("../lib/learnings");
    expect(() => keepLearning("nope", "author-1")).toThrow(/not found/i);
  });

  it("restores a learning that two independent flags archived (see learnings-restore.test.ts)", async () => {
    await seedUsers();
    const { create, flag, keepLearning, getById } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "Will get flagged", body: "B" });

    flag(l.id, "voter-1");
    flag(l.id, "voter-2");
    expect(getById(l.id)!.status).toBe("archived");

    const kept = keepLearning(l.id, "author-1");
    expect(kept.changed).toBe(true);
    expect(kept.learning.status).toBe("active");
    expect(getById(l.id)!.status).toBe("active");
  });

  it("refuses to keep a learning that a correction has superseded, and names its replacement", async () => {
    await seedUsers();
    const { create, supersede, keepLearning, getById } = await import("../lib/learnings");
    const original = create({ authorId: "author-1", title: "Original advice", body: "B" });
    const correction = create({ authorId: "author-1", title: "Corrected advice", body: "C", supersedesId: original.id });
    supersede(correction.id, original.id, "author-1");

    expect(getById(original.id)!.status).toBe("archived");
    expect(() => keepLearning(original.id, "author-1")).toThrow(new RegExp(`replaced by ${correction.id}`));
    expect(getById(original.id)!.status).toBe("archived");
  });
});

describe("learnings.retire (bab_react's `retire` action)", () => {
  it("author-only: archives an active learning, with no replacement", async () => {
    await seedUsers();
    const { create, retire, getById } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "No longer useful", body: "B" });

    const retired = retire(l.id, "author-1");
    expect(retired.status).toBe("archived");
    expect(getById(l.id)!.status).toBe("archived");
  });

  it("retiring someone else's learning needs a note (see learnings-retire-by-anyone.test.ts)", async () => {
    await seedUsers();
    const { create, retire } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "Not yours", body: "B" });
    expect(() => retire(l.id, "voter-1")).toThrow(/note is required/i);
  });

  it("404s on an unknown learning id", async () => {
    await seedUsers();
    const { retire } = await import("../lib/learnings");
    expect(() => retire("nope", "author-1")).toThrow(/not found/i);
  });

  it("refuses a learning that is already archived", async () => {
    await seedUsers();
    const { create, retire } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "Retire me", body: "B" });
    retire(l.id, "author-1");
    expect(() => retire(l.id, "author-1")).toThrow(/already archived/i);
  });

  it("refuses a deleted learning", async () => {
    await seedUsers();
    const { create, retire } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "Will be deleted", body: "B" });
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET status = 'deleted' WHERE id = ?").run(l.id);
    expect(() => retire(l.id, "author-1")).toThrow(/already deleted/i);
  });

  it("does not require replacing the memory with a new one (unlike supersede)", async () => {
    await seedUsers();
    const { create, retire, getById } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "Stale guardrail", body: "B" });
    const retired = retire(l.id, "author-1");
    // No supersedes_id ever gets set: retiring is a plain close-out, not a correction.
    expect(retired.supersedes_id).toBeNull();
    expect(getById(l.id)!.supersedes_id).toBeNull();
  });
});

describe("learnings.supersede", () => {
  it("archives the old learning and links supersession", async () => {
    await seedUsers();
    const { create, supersede, getById } = await import("../lib/learnings");
    const oldL = create({ authorId: "author-1", title: "Old", body: "Old body" });
    const newL = create({ authorId: "author-1", title: "New", body: "New body" });

    supersede(newL.id, oldL.id, "author-1");

    expect(getById(oldL.id)!.status).toBe("archived");
    expect(getById(newL.id)!.supersedes_id).toBe(oldL.id);
  });

  it("rejects a learning superseding itself", async () => {
    await seedUsers();
    const { create, supersede } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "T", body: "B" });
    expect(() => supersede(l.id, l.id, "author-1")).toThrow(/itself/i);
  });

  it("rejects superseding a missing or deleted learning", async () => {
    await seedUsers();
    const { create, supersede } = await import("../lib/learnings");
    const newL = create({ authorId: "author-1", title: "New", body: "New body" });
    expect(() => supersede(newL.id, "does-not-exist", "author-1")).toThrow(/not found/i);
  });

  it("rejects when the new learning is not active", async () => {
    await seedUsers();
    const { create, supersede } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const oldL = create({ authorId: "author-1", title: "Old", body: "Old body" });
    const newL = create({ authorId: "author-1", title: "New", body: "New body" });
    getDb()
      .prepare("UPDATE learnings SET status = 'archived' WHERE id = ?")
      .run(newL.id);

    expect(() => supersede(newL.id, oldL.id, "author-1")).toThrow(/active/i);
  });
});

describe("learnings.renderSnippetHtml", () => {
  it("escapes HTML in the body so an injected script can't execute", async () => {
    const { renderSnippetHtml } = await import("../lib/learnings");
    const raw = 'before <img src=x onerror=alert(1)> after';
    const html = renderSnippetHtml(raw);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("turns match markers into <mark> tags after escaping", async () => {
    const { renderSnippetHtml } = await import("../lib/learnings");
    const raw = "before runTest.sh after";
    const html = renderSnippetHtml(raw);
    expect(html).toContain("<mark>runTest.sh</mark>");
  });
});

describe("learnings.search FTS-special queries never 500", () => {
  const specialQueries = ['"', "AND", "(", "NEAR", "*", "-", "^", '"unterminated', "(()"];

  for (const q of specialQueries) {
    it(`sanitizes ${JSON.stringify(q)} into quoted tokens instead of throwing`, async () => {
      await seedUsers();
      const { create, search } = await import("../lib/learnings");
      create({ authorId: "author-1", title: "Use runTest.sh not dotnet test", body: "CI wiring." });

      expect(() => search(q)).not.toThrow();
    });
  }

  it("'*' has no usable tokens and falls back to the normal unfiltered list", async () => {
    await seedUsers();
    const { create, search, list } = await import("../lib/learnings");
    create({ authorId: "author-1", title: "Use runTest.sh not dotnet test", body: "CI wiring." });

    const results = search("*");
    expect(results.length).toBe(list().length);
  });

  it("a real word still finds the matching learning after sanitizing", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");
    create({ authorId: "author-1", title: "Use runTest.sh not dotnet test", body: "CI wiring." });
    create({ authorId: "author-1", title: "Unrelated", body: "Kafka consumer groups." });

    const results = search('"runTest"');
    expect(results.length).toBe(1);
    expect(results[0].title).toContain("runTest.sh");
  });
});
