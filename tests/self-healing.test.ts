import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Freshness } from "../lib/freshness";

/**
 * Self-healing memory (docs/spec.md "Self-healing memory"): the freshness states and windows
 * (lib/freshness.ts), the person questions (lib/checks.ts), the structured evidence
 * (lib/evidence.ts), and the pieces they add to lib/learnings.ts. Every test drives the production
 * functions; where a window has to move, the row is moved in the database with datetime('now', ...)
 * so SQLite's clock and the code's Date.now() line up. The DATA_DIR is a fresh tmp directory per test.
 */

const AUTHOR = "ada.author@example.com";
const BOB = "bob.b@example.com";
const CID = "cid.c@example.com";
const DEE = "dee.d@example.com";
const EVE = "eve.e@example.com";

let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-self-healing-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  const { upsertUser } = await import("../lib/users");
  for (const id of [AUTHOR, BOB, CID, DEE, EVE]) upsertUser({ id, email: id, name: id.split("@")[0], roles: [] });
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  vi.resetModules();
});

let seq = 0;
async function mk(over: Record<string, unknown> = {}) {
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({
    authorId: AUTHOR,
    title: `Self-healing fixture ${seq} zq${seq}`,
    body: `Body ${seq} about zq${seq}x`,
    confirmNotDuplicate: true,
    ...over,
  });
}

async function db() {
  const { getDb } = await import("../lib/db");
  return getDb();
}

async function backdate(id: string, days: number) {
  (await db()).prepare("UPDATE learnings SET created_at = datetime('now', ?) WHERE id = ?").run(`-${days} days`, id);
}

async function setAccess(id: string, accessDays: number, lastReadDaysAgo: number) {
  (await db())
    .prepare("UPDATE learnings SET access_days = ?, last_accessed_at = datetime('now', ?) WHERE id = ?")
    .run(accessDays, `-${lastReadDaysAgo} days`, id);
}

async function setLastSeen(userId: string, days: number) {
  (await db()).prepare("UPDATE users SET last_seen_at = datetime('now', ?) WHERE id = ?").run(`-${days} days`, userId);
}

async function setFlagAge(id: string, days: number) {
  (await db()).prepare("UPDATE votes SET created_at = datetime('now', ?) WHERE learning_id = ? AND kind = 'flag'").run(`-${days} days`, id);
}

async function setDisputeAge(id: string, days: number, kind: "no" | "unsure") {
  (await db())
    .prepare("UPDATE learnings SET dispute_kind = ?, disputed_at = datetime('now', ?) WHERE id = ?")
    .run(kind, `-${days} days`, id);
}

async function insertHookAsk(id: string, userId: string, daysAgo: number, answer: string | null = null) {
  const conn = await db();
  if (answer === null) {
    conn
      .prepare("INSERT INTO check_asks (learning_id, user_id, via, delivered_at) VALUES (?, ?, 'hook', datetime('now', ?))")
      .run(id, userId, `-${daysAgo} days`);
  } else {
    conn
      .prepare(
        "INSERT INTO check_asks (learning_id, user_id, via, delivered_at, answer, answered_at) VALUES (?, ?, 'hook', datetime('now', ?), ?, datetime('now', ?))",
      )
      .run(id, userId, `-${daysAgo} days`, answer, `-${Math.max(0, daysAgo - 2)} days`);
  }
}

/** A due business fact: a decision made 200 days ago, read by agents on 3 days, last 5 days ago. */
async function duePersonFact(over: Record<string, unknown> = {}) {
  const m = await mk({ kind: "decision", ...over });
  await backdate(m.id, 200);
  await setAccess(m.id, 3, 5);
  return m;
}

function fresh(over: Partial<Freshness>): Freshness {
  return { freshness: "fresh", checkBy: "person", checkDue: false, checkedAt: "2026-01-01 00:00:00", ...over };
}

describe("freshness windows by kind", () => {
  it("has the documented default person windows", async () => {
    const { PERSON_CHECK_DAYS } = await import("../lib/freshness");
    expect(PERSON_CHECK_DAYS.decision).toBe(180);
    expect(PERSON_CHECK_DAYS.standard).toBe(120);
    expect(PERSON_CHECK_DAYS.learning).toBe(90);
    expect(PERSON_CHECK_DAYS.practice).toBe(90);
  });

  it("guesses who checks a fact from its kind", async () => {
    const { defaultCheckBy } = await import("../lib/freshness");
    expect(defaultCheckBy("decision")).toBe("person");
    expect(defaultCheckBy("standard")).toBe("person");
    expect(defaultCheckBy("learning")).toBe("agent");
    expect(defaultCheckBy("practice")).toBe("agent");
  });

  it("uses the row's own window over the kind's default", async () => {
    const { personWindowDays } = await import("../lib/freshness");
    expect(personWindowDays({ kind: "decision", check_every_days: null })).toBe(180);
    expect(personWindowDays({ kind: "standard", check_every_days: null })).toBe(120);
    expect(personWindowDays({ kind: "learning", check_every_days: null })).toBe(90);
    expect(personWindowDays({ kind: "practice", check_every_days: null })).toBe(90);
    expect(personWindowDays({ kind: "learning", check_every_days: 45 })).toBe(45);
  });
});

describe("create and the check fields", () => {
  it("sets check_by from the kind by default and stores a custom window", async () => {
    const d = await mk({ kind: "decision" });
    const s = await mk({ kind: "standard" });
    const l = await mk({ kind: "learning" });
    const p = await mk({ kind: "practice" });
    expect(d.check_by).toBe("person");
    expect(s.check_by).toBe("person");
    expect(l.check_by).toBe("agent");
    expect(p.check_by).toBe("agent");
    const custom = await mk({ kind: "decision", checkEveryDays: 60 });
    expect(custom.check_every_days).toBe(60);
  });

  it("accepts checkBy and checkEveryDays from the caller", async () => {
    const m = await mk({ checkBy: "person", checkEveryDays: 120 });
    expect(m.check_by).toBe("person");
    expect(m.check_every_days).toBe(120);
  });

  it("a custom window shorter than the kind's default makes it due sooner", async () => {
    const { freshnessFor } = await import("../lib/freshness");
    const fast = await mk({ kind: "decision", checkEveryDays: 60 });
    await backdate(fast.id, 70);
    expect(freshnessFor([fast.id]).get(fast.id)!.checkDue).toBe(true);
    const slow = await mk({ kind: "decision", checkEveryDays: 365 });
    await backdate(slow.id, 200);
    expect(freshnessFor([slow.id]).get(slow.id)!.checkDue).toBe(false);
  });

  it("refuses a window below 30 or above 365 days", async () => {
    const { create } = await import("../lib/learnings");
    expect(() =>
      create({ authorId: AUTHOR, title: "Short window zqwin", body: "Body zqwin", confirmNotDuplicate: true, checkEveryDays: 10 }),
    ).toThrow();
    expect(() =>
      create({ authorId: AUTHOR, title: "Long window zqwin2", body: "Body zqwin2", confirmNotDuplicate: true, checkEveryDays: 400 }),
    ).toThrow();
  });

  it("parses checkBy case-insensitively and refuses anything else", async () => {
    const { parseCheckBy } = await import("../lib/freshness");
    const { ValidationError } = await import("../lib/errors");
    expect(parseCheckBy("agent")).toBe("agent");
    expect(parseCheckBy(" PERSON ")).toBe("person");
    expect(parseCheckBy(undefined)).toBeUndefined();
    expect(() => parseCheckBy("human")).toThrow(ValidationError);
    expect(() => parseCheckBy(3)).toThrow();
  });

  it("parses checkEveryDays as a whole number of days from 30 to 365", async () => {
    const { parseCheckEveryDays } = await import("../lib/freshness");
    expect(parseCheckEveryDays(30)).toBe(30);
    expect(parseCheckEveryDays("365")).toBe(365);
    expect(parseCheckEveryDays(undefined)).toBeUndefined();
    expect(parseCheckEveryDays(null)).toBeNull();
    expect(() => parseCheckEveryDays(29)).toThrow();
    expect(() => parseCheckEveryDays(366)).toThrow();
    expect(() => parseCheckEveryDays(45.5)).toThrow();
  });
});

describe("freshness states", () => {
  it("a memory inside its window is fresh", async () => {
    const { freshnessFor } = await import("../lib/freshness");
    const m = await mk({ kind: "decision" });
    const f = freshnessFor([m.id]).get(m.id)!;
    expect(f.freshness).toBe("fresh");
    expect(f.checkDue).toBe(false);
  });

  it("a person fact past its window is due, not stale", async () => {
    const { freshnessFor } = await import("../lib/freshness");
    const m = await mk({ kind: "decision" });
    await backdate(m.id, 200);
    const f = freshnessFor([m.id]).get(m.id)!;
    expect(f.checkBy).toBe("person");
    expect(f.checkDue).toBe(true);
    expect(f.freshness).toBe("due");
    expect(f.disputeKind).toBeUndefined();
  });

  it("an old agent fact with no checks is due, not stale", async () => {
    const { freshnessFor } = await import("../lib/freshness");
    const m = await mk();
    await backdate(m.id, 200);
    const f = freshnessFor([m.id]).get(m.id)!;
    expect(f.checkBy).toBe("agent");
    expect(f.freshness).toBe("due");
    expect(f.disputeKind).toBeUndefined();
  });

  it("an archived memory is always fresh", async () => {
    const m = await mk({ kind: "decision" });
    const { retire } = await import("../lib/learnings");
    retire(m.id, AUTHOR, "mcp");
    const { freshnessFor } = await import("../lib/freshness");
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("fresh");
  });

  it("an open flag disputes at once and goes stale after 14 days", async () => {
    const { flag } = await import("../lib/learnings");
    const { freshnessFor } = await import("../lib/freshness");
    const m = await mk({ kind: "decision" });
    flag(m.id, BOB, "mcp", "Wrong now");
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("disputed");
    expect(freshnessFor([m.id]).get(m.id)!.disputeKind).toBe("flag");
    await setFlagAge(m.id, 20);
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("stale");
  });

  it("a No answer disputes at once and goes stale after 14 days", async () => {
    const { recheck } = await import("../lib/checks");
    const { freshnessFor } = await import("../lib/freshness");
    const m = await mk({ kind: "decision" });
    recheck(m.id, BOB, "no", "It changed", "mcp");
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("disputed");
    await setDisputeAge(m.id, 20, "no");
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("stale");
  });

  it("a Not sure disputes at once and goes stale after 14 days", async () => {
    const { recheck } = await import("../lib/checks");
    const { freshnessFor } = await import("../lib/freshness");
    const m = await mk({ kind: "decision" });
    recheck(m.id, BOB, "unsure", null, "mcp");
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("disputed");
    await setDisputeAge(m.id, 5, "unsure");
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("disputed");
    await setDisputeAge(m.id, 20, "unsure");
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("stale");
  });

  it("marks a person fact asked about 40 days ago with no answer as stale", async () => {
    const { freshnessFor } = await import("../lib/freshness");
    const m = await mk({ kind: "decision" });
    await backdate(m.id, 200);
    await insertHookAsk(m.id, AUTHOR, 40);
    const f = freshnessFor([m.id]).get(m.id)!;
    expect(f.checkDue).toBe(true);
    expect(f.freshness).toBe("stale");
  });

  it("keeps a recent unanswered ask due, not stale", async () => {
    const { freshnessFor } = await import("../lib/freshness");
    const m = await mk({ kind: "decision" });
    await backdate(m.id, 200);
    await insertHookAsk(m.id, AUTHOR, 10);
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("due");
  });

  it("writes a plain line for each dispute and none for a fresh memory", async () => {
    const { freshnessWarning } = await import("../lib/freshness");
    expect(freshnessWarning(fresh({ freshness: "stale" }))).toMatch(/Not checked for a long time/);
    expect(freshnessWarning(fresh({ freshness: "disputed", disputeKind: "flag" }))).toMatch(/flagged this as wrong/);
    expect(freshnessWarning(fresh({ freshness: "disputed", disputeKind: "no" }))).toMatch(/no longer true/);
    expect(freshnessWarning(fresh({ freshness: "disputed", disputeKind: "unsure" }))).toMatch(/not sure/);
    expect(freshnessWarning(fresh({ freshness: "fresh" }))).toBeUndefined();
  });

  it("carries freshness and checkDue on search results", async () => {
    const { search } = await import("../lib/learnings");
    const m = await mk({ kind: "decision", title: "Pricing zqprice", body: "Pricing body zqprice" });
    await backdate(m.id, 200);
    const [hit] = search("zqprice");
    expect(hit.id).toBe(m.id);
    expect(hit.freshness).toBe("due");
    expect(hit.checkBy).toBe("person");
    expect(hit.checkDue).toBe(true);
  });

  it("carries the stale warning on a search result", async () => {
    const { search } = await import("../lib/learnings");
    const m = await mk({ kind: "decision", title: "Pricing zqprice2", body: "Pricing body zqprice2" });
    await backdate(m.id, 200);
    await insertHookAsk(m.id, AUTHOR, 40);
    const [hit] = search("zqprice2");
    expect(hit.freshness).toBe("stale");
    expect(hit.freshnessWarning).toBe("Not checked for a long time, or disputed with no fix. Treat it with caution.");
  });
});

describe("recheck answers", () => {
  it("a Yes from someone other than the author is a confirm: +2 points and a fresh checked_at", async () => {
    const { recheck } = await import("../lib/checks");
    const { getById, voteCounts } = await import("../lib/learnings");
    const m = await mk({ kind: "decision" });
    const before = getById(m.id)!.score;
    const r = recheck(m.id, BOB, "yes", "Checked the pricing page", "mcp");
    expect(r.changed).toBe(true);
    expect(r.answer).toBe("yes");
    expect(getById(m.id)!.checked_at).toBeTruthy();
    expect(voteCounts(m.id).confirm).toBe(1);
    expect(getById(m.id)!.score).toBe(before + 2);
  });

  it("a Yes from someone else needs a note", async () => {
    const { recheck } = await import("../lib/checks");
    const m = await mk({ kind: "decision" });
    expect(() => recheck(m.id, BOB, "yes", null, "mcp")).toThrow();
    expect(() => recheck(m.id, BOB, "yes", "   ", "mcp")).toThrow();
  });

  it("the author's own Yes resets the clock without points", async () => {
    const { recheck } = await import("../lib/checks");
    const { getById, voteCounts } = await import("../lib/learnings");
    const { freshnessFor } = await import("../lib/freshness");
    const m = await duePersonFact();
    const before = getById(m.id)!.score;
    expect(freshnessFor([m.id]).get(m.id)!.checkDue).toBe(true);
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    expect(getById(m.id)!.score).toBe(before);
    expect(voteCounts(m.id).confirm).toBe(0);
    expect(freshnessFor([m.id]).get(m.id)!.checkDue).toBe(false);
  });

  it("allows the author's own Yes twice in a row and refuses the third", async () => {
    const { recheck, AUTHOR_YES_STREAK_MAX } = await import("../lib/checks");
    const m = await mk({ kind: "decision" });
    expect(AUTHOR_YES_STREAK_MAX).toBe(2);
    expect(recheck(m.id, AUTHOR, "yes", null, "mcp").changed).toBe(true);
    expect(recheck(m.id, AUTHOR, "yes", null, "mcp").changed).toBe(true);
    expect(() => recheck(m.id, AUTHOR, "yes", null, "mcp")).toThrow(/two times|colleague|next check/);
  });

  it("a colleague's check lets the author say Yes again", async () => {
    const { recheck } = await import("../lib/checks");
    const m = await mk({ kind: "decision" });
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    expect(() => recheck(m.id, AUTHOR, "yes", null, "mcp")).toThrow();
    recheck(m.id, BOB, "yes", "Checked it, still true", "mcp");
    expect(() => recheck(m.id, AUTHOR, "yes", null, "mcp")).not.toThrow();
  });

  it("counts the author's own Yes streak since the last check by someone else", async () => {
    const { recheck, authorYesStreaks } = await import("../lib/checks");
    const m = await mk({ kind: "decision" });
    expect(authorYesStreaks([m.id]).get(m.id)).toBeUndefined();
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    expect(authorYesStreaks([m.id]).get(m.id)).toBe(1);
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    expect(authorYesStreaks([m.id]).get(m.id)).toBe(2);
    recheck(m.id, BOB, "yes", "Checked it", "mcp");
    expect(authorYesStreaks([m.id]).get(m.id)).toBeUndefined();
  });

  it("the author's own Yes on a tech fact needs the evidence note and counts no points", async () => {
    const { recheck } = await import("../lib/checks");
    const { getById, voteCounts } = await import("../lib/learnings");
    const m = await mk();
    expect(() => recheck(m.id, AUTHOR, "yes", null, "mcp")).toThrow();
    const r = recheck(m.id, AUTHOR, "yes", "Ran the check against src/x.ts", "mcp");
    expect(r.changed).toBe(true);
    expect(getById(m.id)!.checked_at).toBeTruthy();
    expect(voteCounts(m.id).confirm).toBe(0);
  });

  it("No marks the memory disputed and waits for a fix", async () => {
    const { recheck } = await import("../lib/checks");
    const { getById } = await import("../lib/learnings");
    const m = await mk({ kind: "decision" });
    const r = recheck(m.id, BOB, "no", "Price changed", "mcp");
    expect(r.changed).toBe(true);
    expect(r.answer).toBe("no");
    const row = getById(m.id)!;
    expect(row.dispute_kind).toBe("no");
    expect(row.disputed_at).toBeTruthy();
  });

  it("Not sure marks the memory disputed without points", async () => {
    const { recheck } = await import("../lib/checks");
    const { getById, voteCounts } = await import("../lib/learnings");
    const m = await mk({ kind: "decision" });
    const r = recheck(m.id, BOB, "unsure", null, "mcp");
    expect(r.changed).toBe(true);
    expect(getById(m.id)!.dispute_kind).toBe("unsure");
    expect(voteCounts(m.id).confirm).toBe(0);
  });

  it("Ask me later skips for a week and changes nothing", async () => {
    const { recheck } = await import("../lib/checks");
    const { getById } = await import("../lib/learnings");
    const m = await mk({ kind: "decision" });
    const before = getById(m.id)!;
    const r = recheck(m.id, BOB, "later", null, "mcp");
    expect(r.changed).toBe(false);
    expect(r.next).toContain("7 days");
    const after = getById(m.id)!;
    expect(after.checked_at).toBe(before.checked_at);
    expect(after.dispute_kind).toBeNull();
  });

  it("Let agents check switches a person fact to agent", async () => {
    const { recheck } = await import("../lib/checks");
    const { getById } = await import("../lib/learnings");
    const m = await mk({ kind: "decision" });
    const r = recheck(m.id, BOB, "agent", "The source moved", "mcp");
    expect(r.changed).toBe(true);
    expect(getById(m.id)!.check_by).toBe("agent");
  });

  it("Let agents check on an agent fact is a no-op", async () => {
    const { recheck } = await import("../lib/checks");
    const m = await mk();
    const r = recheck(m.id, BOB, "agent", null, "mcp");
    expect(r.changed).toBe(false);
  });

  it("refuses an unknown answer", async () => {
    const { recheck } = await import("../lib/checks");
    const { ValidationError } = await import("../lib/errors");
    const m = await mk({ kind: "decision" });
    expect(() => recheck(m.id, BOB, "maybe", null, "mcp")).toThrow(ValidationError);
  });

  it("only works on a live memory", async () => {
    const { recheck } = await import("../lib/checks");
    const { retire } = await import("../lib/learnings");
    const { ConflictError } = await import("../lib/errors");
    const m = await mk({ kind: "decision" });
    retire(m.id, AUTHOR, "mcp");
    expect(() => recheck(m.id, BOB, "yes", "Checked", "mcp")).toThrow(ConflictError);
  });

  it("a colleague's Yes closes an open No", async () => {
    const { recheck } = await import("../lib/checks");
    const { getById } = await import("../lib/learnings");
    const { freshnessFor } = await import("../lib/freshness");
    const m = await mk({ kind: "decision" });
    recheck(m.id, BOB, "no", "Looks wrong", "mcp");
    expect(getById(m.id)!.dispute_kind).toBe("no");
    recheck(m.id, CID, "yes", "I checked, it is right", "mcp");
    expect(getById(m.id)!.dispute_kind).toBeNull();
    expect(freshnessFor([m.id]).get(m.id)!.freshness).not.toBe("disputed");
  });
});

describe("changeCheckBy", () => {
  it("the author can change who checks without a note", async () => {
    const { changeCheckBy } = await import("../lib/checks");
    const m = await mk();
    const r = changeCheckBy(m.id, AUTHOR, "person", null, "mcp");
    expect(r.changed).toBe(true);
    expect(r.learning.check_by).toBe("person");
  });

  it("someone else needs a note and the note lands in the history", async () => {
    const { changeCheckBy } = await import("../lib/checks");
    const { trustHistory } = await import("../lib/trust");
    const m = await mk();
    expect(() => changeCheckBy(m.id, BOB, "person", null, "mcp")).toThrow();
    changeCheckBy(m.id, BOB, "person", "Only a person can tell", "mcp");
    const ev = trustHistory(m.id).find((e) => e.kind === "check_by_changed")!;
    expect(ev.note).toBe("now person: Only a person can tell");
    expect(ev.byAuthor).toBe(false);
  });

  it("does not record a change to the same value", async () => {
    const { changeCheckBy } = await import("../lib/checks");
    const { trustHistory } = await import("../lib/trust");
    const m = await mk();
    const r = changeCheckBy(m.id, AUTHOR, "agent", null, "mcp");
    expect(r.changed).toBe(false);
    expect(trustHistory(m.id).some((e) => e.kind === "check_by_changed")).toBe(false);
  });

  it("refuses an unknown value", async () => {
    const { changeCheckBy } = await import("../lib/checks");
    const { ValidationError } = await import("../lib/errors");
    const m = await mk();
    expect(() => changeCheckBy(m.id, AUTHOR, "robot", null, "mcp")).toThrow(ValidationError);
  });

  it("only works on a live memory", async () => {
    const { changeCheckBy } = await import("../lib/checks");
    const { retire } = await import("../lib/learnings");
    const { ConflictError } = await import("../lib/errors");
    const m = await mk();
    retire(m.id, AUTHOR, "mcp");
    expect(() => changeCheckBy(m.id, AUTHOR, "person", null, "mcp")).toThrow(ConflictError);
  });
});

describe("waitingFor", () => {
  it("asks the author first when they are active; others are not asked", async () => {
    const m = await duePersonFact();
    const { waitingFor } = await import("../lib/checks");
    expect(waitingFor(AUTHOR).map((i) => i.id)).toContain(m.id);
    expect(waitingFor(BOB).map((i) => i.id)).not.toContain(m.id);
    expect(waitingFor(EVE).map((i) => i.id)).not.toContain(m.id);
  });

  it("falls back to a recent helper when the author has not been active", async () => {
    const m = await duePersonFact();
    const { vote } = await import("../lib/learnings");
    vote(m.id, BOB, "helpful", "mcp");
    await setLastSeen(AUTHOR, 60);
    const { waitingFor } = await import("../lib/checks");
    expect(waitingFor(BOB).map((i) => i.id)).toContain(m.id);
    expect(waitingFor(AUTHOR).map((i) => i.id)).not.toContain(m.id);
  });

  it("falls back to an area contact whose area is one of its tags", async () => {
    const m = await duePersonFact({ tags: ["qarea"] });
    await (await db()).prepare("INSERT INTO area_contacts (area, user_id) VALUES (?, ?)").run("qarea", DEE);
    await setLastSeen(AUTHOR, 60);
    const { waitingFor } = await import("../lib/checks");
    expect(waitingFor(DEE).map((i) => i.id)).toContain(m.id);
  });

  it("passes over a person who skipped twice", async () => {
    const m = await duePersonFact();
    const { vote } = await import("../lib/learnings");
    vote(m.id, BOB, "helpful", "mcp");
    await insertHookAsk(m.id, AUTHOR, 1, "later");
    await insertHookAsk(m.id, AUTHOR, 1, "later");
    const { waitingFor } = await import("../lib/checks");
    expect(waitingFor(AUTHOR).map((i) => i.id)).not.toContain(m.id);
    expect(waitingFor(BOB).map((i) => i.id)).toContain(m.id);
  });

  it("never asks about a memory agents barely read", async () => {
    const m = await duePersonFact();
    await setAccess(m.id, 1, 5);
    const { waitingFor } = await import("../lib/checks");
    expect(waitingFor(AUTHOR).find((i) => i.id === m.id)).toBeUndefined();
  });

  it("never asks about a memory no agent read in the last 90 days", async () => {
    const m = await duePersonFact();
    await setAccess(m.id, 5, 120);
    const { waitingFor } = await import("../lib/checks");
    expect(waitingFor(AUTHOR).find((i) => i.id === m.id)).toBeUndefined();
  });

  it("does not ask about a business fact inside its window", async () => {
    const m = await mk({ kind: "decision" });
    await setAccess(m.id, 3, 5);
    const { waitingFor } = await import("../lib/checks");
    expect(waitingFor(AUTHOR).find((i) => i.id === m.id)).toBeUndefined();
  });

  it("never asks a person about a tech fact", async () => {
    const m = await mk();
    await backdate(m.id, 200);
    await setAccess(m.id, 3, 5);
    const { waitingFor } = await import("../lib/checks");
    expect(waitingFor(AUTHOR).find((i) => i.id === m.id)).toBeUndefined();
  });

  it("lists a memory a person answered No about as a follow-up", async () => {
    const m = await duePersonFact();
    const { recheck, waitingFor } = await import("../lib/checks");
    recheck(m.id, AUTHOR, "no", "Changed", "mcp");
    const item = waitingFor(AUTHOR).find((i) => i.id === m.id)!;
    expect(item.reason).toBe("followUp");
  });

  it("shows at most five lines of the memory text, then a link", async () => {
    const body = ["one zqline", "two zqline", "three zqline", "four zqline", "five zqline", "six zqline"].join("\n");
    const m = await duePersonFact({ body });
    const { waitingFor, CHECK_TEXT_LINES } = await import("../lib/checks");
    expect(CHECK_TEXT_LINES).toBe(5);
    const item = waitingFor(AUTHOR).find((i) => i.id === m.id)!;
    expect(item.truncated).toBe(true);
    expect(item.text.split("\n")).toHaveLength(5);
    expect(item.text).not.toContain("six zqline");
  });
});

describe("takeHookChecks", () => {
  it("takes one session-start set per day", async () => {
    await duePersonFact();
    const { takeHookChecks } = await import("../lib/checks");
    expect(takeHookChecks(AUTHOR).length).toBeGreaterThan(0);
    expect(takeHookChecks(AUTHOR)).toEqual([]);
  });

  it("takes at most three memories in a set", async () => {
    for (let i = 0; i < 5; i++) await duePersonFact();
    const { takeHookChecks, ASK_SET_MAX } = await import("../lib/checks");
    expect(ASK_SET_MAX).toBe(3);
    expect(takeHookChecks(AUTHOR)).toHaveLength(3);
  });

  it("stops after six asked memories in any seven days", async () => {
    const m = await duePersonFact();
    for (let i = 0; i < 6; i++) await insertHookAsk(m.id, AUTHOR, 2);
    const { takeHookChecks } = await import("../lib/checks");
    expect(takeHookChecks(AUTHOR)).toEqual([]);
  });

  it("does not ask again about a memory it asked about in the last week", async () => {
    const m = await duePersonFact();
    await insertHookAsk(m.id, AUTHOR, 2);
    const { takeHookChecks } = await import("../lib/checks");
    expect(takeHookChecks(AUTHOR).find((i) => i.id === m.id)).toBeUndefined();
  });

  it("takes only due questions, not follow-ups", async () => {
    const m = await duePersonFact();
    const { recheck, takeHookChecks } = await import("../lib/checks");
    recheck(m.id, AUTHOR, "no", "Changed", "mcp");
    expect(takeHookChecks(AUTHOR)).toEqual([]);
  });
});

describe("evidence", () => {
  it("has the failure vocabulary and the 300-character field cap", async () => {
    const { EVIDENCE_FAILURES, EVIDENCE_FIELD_MAX } = await import("../lib/evidence");
    expect(EVIDENCE_FAILURES).toContain("command_failed");
    expect(EVIDENCE_FAILURES).toContain("path_missing");
    expect(EVIDENCE_FAILURES).toContain("contradicts_memory");
    expect(EVIDENCE_FIELD_MAX).toBe(300);
  });

  it("treats absent and empty evidence as none", async () => {
    const { parseEvidence } = await import("../lib/evidence");
    expect(parseEvidence(null)).toBeNull();
    expect(parseEvidence(undefined)).toBeNull();
    expect(parseEvidence({})).toBeNull();
    expect(parseEvidence({ failure: null, tried: "   " })).toBeNull();
  });

  it("refuses an unknown key, an unknown failure and a non-text field", async () => {
    const { parseEvidence } = await import("../lib/evidence");
    expect(() => parseEvidence({ when: "now" })).toThrow();
    expect(() => parseEvidence({ failure: "exploded" })).toThrow();
    expect(() => parseEvidence({ saw: 42 })).toThrow();
    expect(() => parseEvidence(["command_failed"])).toThrow();
  });

  it("refuses a field over 300 characters", async () => {
    const { parseEvidence } = await import("../lib/evidence");
    expect(() => parseEvidence({ tried: "x".repeat(301) })).toThrow();
    expect(() => parseEvidence({ tried: "x".repeat(300) })).not.toThrow();
  });

  it("redacts secrets in evidence text", async () => {
    const { parseEvidence } = await import("../lib/evidence");
    // Built at run time, so the scanners do not see a token in the source.
    const token = ["ghp_", "1234567890abcdef", "1234567890abcdef", "1234"].join("");
    const e = parseEvidence({ failure: "api_error", tried: `curl with ${token}`, saw: `401 for ${token}` })!;
    expect(e.tried).toBeDefined();
    expect(e.tried).not.toContain(token);
    expect(e.saw).not.toContain(token);
  });

  it("stores flag evidence in the validation history", async () => {
    const { flag } = await import("../lib/learnings");
    const { trustHistory } = await import("../lib/trust");
    const m = await mk();
    flag(m.id, BOB, "mcp", "The API changed", {
      failure: "api_error",
      tried: "GET the pricing endpoint",
      saw: "not found",
      where: "main branch",
    });
    const ev = trustHistory(m.id).find((e) => e.kind === "flag")!;
    expect(ev.evidence).toEqual({ failure: "api_error", tried: "GET the pricing endpoint", saw: "not found", where: "main branch" });
  });

  it("stores correction evidence on the replaced memory", async () => {
    const old = await mk();
    const { createWithSupersedes } = await import("../lib/learnings");
    const { trustHistory } = await import("../lib/trust");
    createWithSupersedes(
      { authorId: BOB, title: "Corrected zqsfresh", body: "The new value zqsfresh", confirmNotDuplicate: true },
      [old.id],
      "mcp",
      { failure: "contradicts_memory", saw: "the docs say otherwise" },
    );
    const ev = trustHistory(old.id).find((e) => e.kind === "supersede")!;
    expect(ev.evidence).toEqual({ failure: "contradicts_memory", saw: "the docs say otherwise" });
  });

  it("refuses evidence on a plain create with no supersedes", async () => {
    const { createWithSupersedes } = await import("../lib/learnings");
    expect(() =>
      createWithSupersedes(
        { authorId: BOB, title: "Plain zqevi", body: "No supersedes zqevi", confirmNotDuplicate: true },
        [],
        "mcp",
        { failure: "api_error" },
      ),
    ).toThrow();
  });
});

describe("against spam and consolidations", () => {
  it("a person may flag at most five memories a day", async () => {
    const { flag } = await import("../lib/learnings");
    const { TooManyRequestsError } = await import("../lib/errors");
    const { DAILY_FLAG_MAX } = await import("../lib/freshness");
    expect(DAILY_FLAG_MAX).toBe(5);
    const targets: Awaited<ReturnType<typeof mk>>[] = [];
    for (let i = 0; i < 6; i++) targets.push(await mk());
    for (let i = 0; i < 5; i++) flag(targets[i].id, BOB, "mcp", "Wrong now");
    expect(() => flag(targets[5].id, BOB, "mcp", "Wrong too")).toThrow(TooManyRequestsError);
  });

  it("counts new flags per person: a repeat is free and another person still may flag", async () => {
    const { flag } = await import("../lib/learnings");
    const targets: Awaited<ReturnType<typeof mk>>[] = [];
    for (let i = 0; i < 6; i++) targets.push(await mk());
    for (let i = 0; i < 5; i++) flag(targets[i].id, BOB, "mcp", "Wrong now");
    expect(() => flag(targets[0].id, BOB, "mcp", "Still wrong, a new note")).not.toThrow();
    expect(() => flag(targets[5].id, BOB, "mcp", "Wrong too")).toThrow();
    expect(() => flag(targets[5].id, CID, "mcp", "Also wrong")).not.toThrow();
  });

  it("a person may correct at most five of other people's memories a day", async () => {
    const { createWithSupersedes } = await import("../lib/learnings");
    const { TooManyRequestsError } = await import("../lib/errors");
    const { DAILY_SUPERSEDE_MAX } = await import("../lib/freshness");
    expect(DAILY_SUPERSEDE_MAX).toBe(5);
    const olds: Awaited<ReturnType<typeof mk>>[] = [];
    for (let i = 0; i < 6; i++) olds.push(await mk());
    for (let i = 0; i < 5; i++) {
      createWithSupersedes(
        { authorId: BOB, title: `Fix ${i} zqfx${i}`, body: `Fixed body ${i} zqfx${i}`, confirmNotDuplicate: true },
        [olds[i].id],
        "mcp",
      );
    }
    expect(() =>
      createWithSupersedes(
        { authorId: BOB, title: "Fix six zqfx6", body: "Fixed body six zqfx6", confirmNotDuplicate: true },
        [olds[5].id],
        "mcp",
      ),
    ).toThrow(TooManyRequestsError);
  });

  it("refuses a consolidation of different kinds before anything is written", async () => {
    const a = await mk({ kind: "learning" });
    const b = await mk({ kind: "standard" });
    const { createWithSupersedes, getById, list } = await import("../lib/learnings");
    expect(() =>
      createWithSupersedes(
        { authorId: BOB, title: "Merge zqm", body: "Merged zqm", confirmNotDuplicate: true },
        [a.id, b.id],
        "mcp",
      ),
    ).toThrow();
    expect(getById(a.id)!.status).toBe("active");
    expect(getById(b.id)!.status).toBe("active");
    expect(list({ author: BOB })).toHaveLength(0);
  });

  it("refuses a consolidation that would pass the daily cap, atomically", async () => {
    const olds: Awaited<ReturnType<typeof mk>>[] = [];
    for (let i = 0; i < 6; i++) olds.push(await mk());
    const { createWithSupersedes, getById } = await import("../lib/learnings");
    const { TooManyRequestsError } = await import("../lib/errors");
    for (let i = 0; i < 4; i++) {
      createWithSupersedes(
        { authorId: BOB, title: `Pre ${i} zqp${i}`, body: `Pre body ${i} zqp${i}`, confirmNotDuplicate: true },
        [olds[i].id],
        "mcp",
      );
    }
    expect(() =>
      createWithSupersedes(
        { authorId: BOB, title: "Merge zqmerge", body: "Merged zqmerge", confirmNotDuplicate: true, kind: "learning" },
        [olds[4].id, olds[5].id],
        "mcp",
      ),
    ).toThrow(TooManyRequestsError);
    expect(getById(olds[4].id)!.status).toBe("active");
    expect(getById(olds[5].id)!.status).toBe("active");
  });
});

describe("a correction carries the check settings", () => {
  it("keeps the check_by of the memory it replaces", async () => {
    const { createWithSupersedes } = await import("../lib/learnings");
    const old = await mk({ kind: "decision" });
    expect(old.check_by).toBe("person");
    const fresh = createWithSupersedes(
      { authorId: BOB, title: "New value zqcarry", body: "New body zqcarry", confirmNotDuplicate: true },
      [old.id],
      "mcp",
    );
    expect(fresh.kind).toBe("decision");
    expect(fresh.check_by).toBe("person");
  });

  it("may choose its own check_by", async () => {
    const { createWithSupersedes } = await import("../lib/learnings");
    const old = await mk({ kind: "decision" });
    const fresh = createWithSupersedes(
      { authorId: BOB, title: "New value zqchoose", body: "New body zqchoose", confirmNotDuplicate: true, checkBy: "agent" },
      [old.id],
      "mcp",
    );
    expect(fresh.check_by).toBe("agent");
  });

  it("keeps the replaced window or sets its own", async () => {
    const { createWithSupersedes } = await import("../lib/learnings");
    const a = await mk({ kind: "decision", checkEveryDays: 60 });
    const kept = createWithSupersedes(
      { authorId: BOB, title: "Kept window zqck", body: "Body zqck", confirmNotDuplicate: true },
      [a.id],
      "mcp",
    );
    expect(kept.check_every_days).toBe(60);
    const b = await mk({ kind: "decision", checkEveryDays: 60 });
    const own = createWithSupersedes(
      { authorId: BOB, title: "Own window zqco", body: "Body zqco", confirmNotDuplicate: true, checkEveryDays: 120 },
      [b.id],
      "mcp",
    );
    expect(own.check_every_days).toBe(120);
  });
});

describe("search ranks disputed memories lower", () => {
  it("drops a memory with an open No below an equal match", async () => {
    const { search } = await import("../lib/learnings");
    const { recheck } = await import("../lib/checks");
    const a = await mk({ title: "Rotate the zqrank key", body: "Rotate the zqrank key every month." });
    const b = await mk({ title: "Rotate the zqrank key", body: "Rotate the zqrank key every month." });
    await backdate(a.id, 1);
    await backdate(b.id, 1);
    recheck(a.id, BOB, "no", "Nope", "mcp");
    const order = search("zqrank key").map((r) => r.id);
    expect(order).toContain(a.id);
    expect(order).toContain(b.id);
    expect(order.indexOf(a.id)).toBeGreaterThan(order.indexOf(b.id));
  });
});

describe("the unchecked serve rate", () => {
  it("has no rate until something was served", async () => {
    const { serveStats } = await import("../lib/checks");
    const s = serveStats();
    expect(s.served).toBe(0);
    expect(s.rate).toBeNull();
    expect(s.answerRate).toBeNull();
  });

  it("counts only the top three results of a search", async () => {
    const { recordServed, serveStats } = await import("../lib/checks");
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await mk()).id);
    recordServed(ids.map((id) => ({ id, freshness: "fresh" as const })));
    const s = serveStats();
    expect(s.served).toBe(3);
    expect(s.unchecked).toBe(0);
    expect(s.rate).toBe(0);
  });

  it("counts due and stale results as unchecked", async () => {
    const { recordServed, serveStats } = await import("../lib/checks");
    const a = await mk();
    const b = await mk();
    const c = await mk();
    recordServed([
      { id: a.id, freshness: "due" },
      { id: b.id, freshness: "stale" },
      { id: c.id, freshness: "fresh" },
    ]);
    const s = serveStats();
    expect(s).toMatchObject({ served: 3, unchecked: 2 });
    expect(s.rate).toBeCloseTo(2 / 3);
  });

  it("does not count a dispute younger than the 7-day grace", async () => {
    const m = await mk({ kind: "decision" });
    const { flag } = await import("../lib/learnings");
    flag(m.id, BOB, "mcp", "Wrong now");
    const { recordServed, serveStats } = await import("../lib/checks");
    recordServed([{ id: m.id, freshness: "disputed" }]);
    const s = serveStats();
    expect(s.served).toBe(1);
    expect(s.unchecked).toBe(0);
  });

  it("counts a dispute older than the 7-day grace", async () => {
    const m = await mk({ kind: "decision" });
    const { flag } = await import("../lib/learnings");
    flag(m.id, BOB, "mcp", "Wrong now");
    await setFlagAge(m.id, 10);
    const { recordServed, serveStats } = await import("../lib/checks");
    recordServed([{ id: m.id, freshness: "disputed" }]);
    expect(serveStats().unchecked).toBe(1);
  });

  it("counts only the last 30 days", async () => {
    const m = await mk();
    const { recordServed, serveStats } = await import("../lib/checks");
    recordServed([{ id: m.id, freshness: "due" }]);
    await (await db())
      .prepare(
        `INSERT INTO freshness_daily (day, served, served_fresh, served_due, served_disputed, served_stale, served_unchecked)
         VALUES (date('now', '-40 days'), 10, 10, 0, 0, 0, 10)`,
      )
      .run();
    const s = serveStats();
    expect(s.served).toBe(1);
    expect(s.unchecked).toBe(1);
  });

  it("computes the answer rate from hook asks older than a week", async () => {
    const m = await mk();
    await insertHookAsk(m.id, AUTHOR, 10, "yes");
    await insertHookAsk(m.id, AUTHOR, 10, "yes");
    await insertHookAsk(m.id, AUTHOR, 10, "later");
    await insertHookAsk(m.id, AUTHOR, 10);
    const { serveStats } = await import("../lib/checks");
    const s = serveStats();
    expect(s.asked).toBe(4);
    expect(s.answered).toBe(2);
    expect(s.answerRate).toBeCloseTo(0.5);
  });
});
