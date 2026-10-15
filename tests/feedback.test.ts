import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A fake API-key shape for the redaction tests. Assembled at runtime so a push-time secret scanner's
// secret scanner never sees the literal pattern (same trick as tests/redact-gaps.test.ts).
const FAKE_KEY = ["sk", "-", "abcdefghijklmnopqrstuvwxyz", "0123456789"].join("");

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-feedback-test-"));
  process.env.DATA_DIR = dataDir;
  delete process.env.BAB_MAINTAINERS;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
});

const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";
const MAINT = "maria.m@example.com";

async function seed() {
  const { upsertUser } = await import("../lib/users");
  for (const id of [ALICE, BOB, MAINT]) upsertUser({ id, email: id, name: null, roles: [] });
}

const base = {
  source: "agent" as const,
  kind: "bug" as const,
  area: "hooks" as const,
  title: "Stop hook nudges twice in one turn",
  body: "After a merge the Stop hook asks for a learning and then asks again on the next turn.",
};

async function make(overrides: Partial<Parameters<typeof import("../lib/feedback").create>[0]> = {}) {
  const { create } = await import("../lib/feedback");
  return create({ authorId: ALICE, ...base, ...overrides });
}

describe("migration v25", () => {
  it("creates the feedback tables with their constraints", async () => {
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') AND name LIKE '%feedback%'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["feedback", "feedback_votes", "feedback_comments", "feedback_fts", "maintainer_feedback_seen"]));
    await seed();
    expect(() =>
      db
        .prepare("INSERT INTO feedback (id, author_id, source, kind, area, title, body) VALUES ('x', ?, 'agent', 'nope', 'web', 't', 'b')")
        .run(ALICE),
    ).toThrow();
  });
});

describe("create", () => {
  it("stores a redacted item as open with zero votes", async () => {
    await seed();
    const item = await make({ title: `Token ${FAKE_KEY} leaks`, body: "Mail bob.someone@other.test please" });
    expect(item.status).toBe("open");
    expect(item.votes).toBe(0);
    expect(item.title).not.toContain(FAKE_KEY.slice(0, 29));
    expect(item.body).not.toContain("bob.someone@other.test");
  });

  it("redacts clientVersion too", async () => {
    await seed();
    const item = await make({ clientVersion: `plugin 1.0 ${FAKE_KEY}` });
    expect(item.client_version).not.toContain(FAKE_KEY.slice(0, 29));
  });

  it("rejects over-long fields and bad enums", async () => {
    await seed();
    const { create } = await import("../lib/feedback");
    expect(() => create({ authorId: ALICE, ...base, title: "x".repeat(161) })).toThrow(/160/);
    expect(() => create({ authorId: ALICE, ...base, body: "x".repeat(8001) })).toThrow(/8000/);
    expect(() => create({ authorId: ALICE, ...base, title: "x".repeat(5000) })).toThrow();
    expect(() => create({ authorId: ALICE, ...base, kind: "rant" as never })).toThrow(/kind/);
    expect(() => create({ authorId: ALICE, ...base, area: "sky" as never })).toThrow(/area/);
    expect(() => create({ authorId: ALICE, ...base, title: "  ", body: "b" })).toThrow();
  });

  it("409s with candidates on a near-duplicate unless confirmNotDuplicate", async () => {
    await seed();
    const first = await make();
    const { create } = await import("../lib/feedback");
    const { ConflictError } = await import("../lib/errors");
    let caught: unknown;
    try {
      create({ authorId: BOB, ...base, title: "Stop hook nudges twice in one turn!" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as InstanceType<typeof ConflictError>).candidates[0].id).toBe(first.id);

    const forced = create({ authorId: BOB, ...base, title: "Stop hook nudges twice in one turn!", confirmNotDuplicate: true });
    expect(forced.id).not.toBe(first.id);
  });

  it("does not treat a closed item as a duplicate", async () => {
    await seed();
    process.env.BAB_MAINTAINERS = MAINT;
    const first = await make();
    const { setStatus, create } = await import("../lib/feedback");
    setStatus(first.id, { id: MAINT }, "done", {});
    expect(() => create({ authorId: BOB, ...base })).not.toThrow();
  });

  it("caps FEEDBACK_DAILY_LIMIT (50) new items per author per UTC day", async () => {
    await seed();
    const { create, FEEDBACK_DAILY_LIMIT } = await import("../lib/feedback");
    expect(FEEDBACK_DAILY_LIMIT).toBe(50);
    // Filled directly: 50 distinct duplicate-checked creations would test the duplicate guard, not the cap.
    const { getDb } = await import("../lib/db");
    const ins = getDb().prepare(
      "INSERT INTO feedback (id, author_id, source, kind, area, title, body) VALUES (?, ?, 'agent', 'bug', 'hooks', ?, ?)",
    );
    for (let i = 0; i < FEEDBACK_DAILY_LIMIT; i++) ins.run(`f-${i}`, ALICE, `filler ${i}`, `filler body ${i}`);
    let err: Error | undefined;
    try {
      create({ authorId: ALICE, ...base, title: "sixth unrelated thing about uploads", body: "uploads misbehave when huge" });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe("Daily feedback limit reached: vote on or comment on an existing item instead");
    expect((err as { status?: number }).status).toBe(429);
    // Another author is unaffected.
    expect(() => create({ authorId: BOB, ...base, title: "bob has his own budget", body: "totally different words here" })).not.toThrow();
  });

  it("emits feedback.created and audits", async () => {
    await seed();
    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    subscribe((e) => seen.push(e.type));
    const item = await make();
    expect(seen).toContain("feedback.created");
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT action FROM audit_log WHERE entity = 'feedback' AND entity_id = ?").get(item.id) as { action: string };
    expect(row.action).toBe("create");
  });
});

describe("list", () => {
  it("defaults to open and planned, top first then newest", async () => {
    await seed();
    process.env.BAB_MAINTAINERS = MAINT;
    const { setStatus, vote, list } = await import("../lib/feedback");
    const a = await make({ title: "alpha widget crashes", body: "alpha body words here" });
    const b = await make({ title: "bravo gadget flickers", body: "bravo body text there", authorId: BOB });
    const c = await make({ title: "charlie lever sticks", body: "charlie content over there" });
    setStatus(c.id, { id: MAINT }, "done", {});
    vote(b.id, MAINT);
    vote(b.id, ALICE);
    const page = list({});
    expect(page.items.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(page.total).toBe(2);
    expect(page.nextOffset).toBeNull();
    expect(page.items[0].votes).toBe(2);
    expect(list({ status: "done" }).items.map((i) => i.id)).toEqual([c.id]);
    expect(list({ status: "all" }).total).toBe(3);
  });

  it("filters by kind, area, author and text, and pages with nextOffset", async () => {
    await seed();
    await make({ title: "alpha widget crashes", body: "alpha body words here", kind: "bug", area: "memory" });
    await make({ title: "bravo gadget flickers", body: "bravo body text there", kind: "idea", area: "web", authorId: BOB });
    await make({ title: "charlie lever sticks", body: "charlie content over there", kind: "idea", area: "web" });
    const { list } = await import("../lib/feedback");
    expect(list({ kind: "idea" }).total).toBe(2);
    expect(list({ area: "memory" }).total).toBe(1);
    expect(list({ author: BOB }).items).toHaveLength(1);
    expect(list({ q: "gadget" }).items.map((i) => i.title)).toEqual(["bravo gadget flickers"]);
    const p1 = list({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextOffset).toBe(2);
    const p2 = list({ limit: 2, offset: 2 });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextOffset).toBeNull();
  });

  it("rejects an unknown filter value", async () => {
    const { list } = await import("../lib/feedback");
    expect(() => list({ status: "weird" })).toThrow(/status/);
    expect(() => list({ kind: "weird" })).toThrow(/kind/);
    expect(() => list({ area: "weird" })).toThrow(/area/);
  });
});

describe("vote", () => {
  it("is idempotent and ignores the author", async () => {
    await seed();
    const item = await make();
    const { vote, get } = await import("../lib/feedback");
    expect(vote(item.id, BOB).changed).toBe(true);
    expect(vote(item.id, BOB).changed).toBe(false);
    expect(vote(item.id, ALICE).changed).toBe(false);
    expect(get(item.id)!.item.votes).toBe(1);
  });

  it("404s on an unknown item", async () => {
    await seed();
    const { vote } = await import("../lib/feedback");
    expect(() => vote("nope", BOB)).toThrow(/not found/i);
  });
});

describe("comment", () => {
  it("stores a redacted comment and bounds it", async () => {
    await seed();
    const item = await make();
    const { comment, get } = await import("../lib/feedback");
    comment(item.id, BOB, "Seen too. Contact bob.someone@other.test");
    const got = get(item.id)!;
    expect(got.comments).toHaveLength(1);
    expect(got.comments[0].body).not.toContain("bob.someone@other.test");
    expect(got.comments[0].kind).toBe("comment");
    expect(() => comment(item.id, BOB, "x".repeat(4001))).toThrow(/4000/);
    expect(() => comment(item.id, BOB, "   ")).toThrow();
  });
});

describe("setStatus", () => {
  it("refuses everyone with a clear 403 when BAB_MAINTAINERS is unset", async () => {
    await seed();
    const item = await make();
    const { setStatus } = await import("../lib/feedback");
    let err: Error | undefined;
    try {
      setStatus(item.id, { id: MAINT }, "planned", {});
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe("BAB_MAINTAINERS is not configured");
    expect((err as { status?: number }).status).toBe(403);
  });

  it("refuses a non-maintainer and allows a maintainer, case-insensitively", async () => {
    await seed();
    process.env.BAB_MAINTAINERS = ` Someone.Else@example.com , ${MAINT.toUpperCase()} `;
    const item = await make();
    const { setStatus, get } = await import("../lib/feedback");
    expect(() => setStatus(item.id, { id: BOB }, "planned", {})).toThrow(/maintainer/i);
    const updated = setStatus(item.id, { id: MAINT }, "planned", { note: "Next sprint" });
    expect(updated.status).toBe("planned");
    const comments = get(item.id)!.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ kind: "status", author_id: MAINT });
    expect(comments[0].body).toBe("status: open -> planned\nNext sprint");
  });

  it("rejects an unknown status", async () => {
    await seed();
    process.env.BAB_MAINTAINERS = MAINT;
    const item = await make();
    const { setStatus } = await import("../lib/feedback");
    expect(() => setStatus(item.id, { id: MAINT }, "weird" as never, {})).toThrow(/status/);
  });

  it("duplicate needs an existing target, moves votes over and never double counts", async () => {
    await seed();
    process.env.BAB_MAINTAINERS = MAINT;
    const target = await make({ title: "alpha widget crashes", body: "alpha body words here" });
    const dup = await make({ title: "bravo gadget flickers", body: "bravo body text there", authorId: BOB });
    const { setStatus, vote, get } = await import("../lib/feedback");
    vote(dup.id, ALICE);
    vote(dup.id, MAINT);
    vote(target.id, MAINT);

    expect(() => setStatus(dup.id, { id: MAINT }, "duplicate", {})).toThrow(/duplicateOf/);
    expect(() => setStatus(dup.id, { id: MAINT }, "duplicate", { duplicateOf: "missing" })).toThrow(/not found/i);
    expect(() => setStatus(dup.id, { id: MAINT }, "duplicate", { duplicateOf: dup.id })).toThrow();

    const moved = setStatus(dup.id, { id: MAINT }, "duplicate", { duplicateOf: target.id });
    expect(moved.duplicate_of).toBe(target.id);
    expect(get(dup.id)!.item.votes).toBe(0);
    // ALICE is the target's author, so her vote is dropped; MAINT already voted: nothing doubles.
    expect(get(target.id)!.item.votes).toBe(1);
  });

  it("emits feedback.updated and audits", async () => {
    await seed();
    process.env.BAB_MAINTAINERS = MAINT;
    const item = await make();
    const { subscribe } = await import("../lib/events");
    const seen: string[] = [];
    subscribe((e) => seen.push(e.type));
    const { setStatus } = await import("../lib/feedback");
    setStatus(item.id, { id: MAINT }, "wontfix", {});
    expect(seen).toContain("feedback.updated");
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT action FROM audit_log WHERE entity = 'feedback' AND action = 'status'").get();
    expect(row).toBeTruthy();
  });
});

describe("maintainerFeedbackNudge", () => {
  it("is null for a non-maintainer and when BAB_MAINTAINERS is unset", async () => {
    await seed();
    await make();
    const { maintainerFeedbackNudge } = await import("../lib/feedback");
    expect(maintainerFeedbackNudge(MAINT)).toBeNull();
    process.env.BAB_MAINTAINERS = MAINT;
    expect(maintainerFeedbackNudge(BOB)).toBeNull();
  });

  it("counts new items once, excludes the maintainer's own, then stays quiet", async () => {
    await seed();
    process.env.BAB_MAINTAINERS = MAINT;
    await make({ title: "alpha widget crashes", body: "alpha body words here" });
    await make({ title: "bravo gadget flickers", body: "bravo body text there", authorId: BOB });
    await make({ title: "mine own report", body: "own words different", authorId: MAINT });
    const { maintainerFeedbackNudge, create } = await import("../lib/feedback");

    expect(maintainerFeedbackNudge(MAINT)).toBe(
      "Big Agentic Brain: 2 new feedback items about BAB since you last looked. Call bab_feedback with action list to triage.",
    );
    expect(maintainerFeedbackNudge(MAINT)).toBeNull();

    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE maintainer_feedback_seen SET seen_at = '2000-01-01 00:00:00'").run();
    create({ authorId: BOB, ...base, title: "delta cursor jumps", body: "delta jumps around oddly" });
    expect(maintainerFeedbackNudge(MAINT)).toContain("3 new feedback items");
  });

  it("says item, not items, for one", async () => {
    await seed();
    process.env.BAB_MAINTAINERS = MAINT;
    await make();
    const { maintainerFeedbackNudge } = await import("../lib/feedback");
    expect(maintainerFeedbackNudge(MAINT)).toContain("1 new feedback item about BAB");
  });
});
