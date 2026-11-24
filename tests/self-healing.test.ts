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

  it("allows the author's own Yes twice in a row and refuses the third while a colleague can be asked", async () => {
    const { recheck, AUTHOR_YES_STREAK_MAX } = await import("../lib/checks");
    const { vote } = await import("../lib/learnings");
    const m = await mk({ kind: "decision" });
    vote(m.id, BOB, "helpful", "mcp");
    expect(AUTHOR_YES_STREAK_MAX).toBe(2);
    expect(recheck(m.id, AUTHOR, "yes", null, "mcp").changed).toBe(true);
    expect(recheck(m.id, AUTHOR, "yes", null, "mcp").changed).toBe(true);
    expect(() => recheck(m.id, AUTHOR, "yes", null, "mcp")).toThrow(/two times|colleague|next check/);
  });

  it("has no limit on the author's own Yes when nobody else can be asked", async () => {
    const { recheck } = await import("../lib/checks");
    // A single-person install: no contact for its area and nobody else used it.
    const m = await mk({ kind: "decision" });
    for (let i = 0; i < 4; i++) expect(recheck(m.id, AUTHOR, "yes", null, "mcp").changed).toBe(true);
    // The only colleague who used it has not been seen for two months: still nobody to ask.
    const { vote } = await import("../lib/learnings");
    vote(m.id, BOB, "helpful", "mcp");
    await setLastSeen(BOB, 60);
    expect(recheck(m.id, AUTHOR, "yes", null, "mcp").changed).toBe(true);
    await setLastSeen(BOB, 0);
    expect(() => recheck(m.id, AUTHOR, "yes", null, "mcp")).toThrow(/two times|colleague|next check/);
  });

  it("a colleague's check lets the author say Yes again", async () => {
    const { recheck } = await import("../lib/checks");
    const { vote } = await import("../lib/learnings");
    const m = await mk({ kind: "decision" });
    vote(m.id, BOB, "helpful", "mcp");
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

  it("passes over the author after two Yes answers in a row when a colleague can be asked", async () => {
    const m = await duePersonFact();
    const { vote } = await import("../lib/learnings");
    const { recheck, waitingFor } = await import("../lib/checks");
    vote(m.id, BOB, "helpful", "mcp");
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    (await db()).prepare("UPDATE learnings SET checked_at = datetime('now', '-200 days') WHERE id = ?").run(m.id);
    expect(waitingFor(AUTHOR).map((i) => i.id)).not.toContain(m.id);
    expect(waitingFor(BOB).map((i) => i.id)).toContain(m.id);
  });

  it("asks the author again after two Yes answers when nobody else is left", async () => {
    const m = await duePersonFact();
    const { recheck, waitingFor } = await import("../lib/checks");
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    (await db()).prepare("UPDATE learnings SET checked_at = datetime('now', '-200 days') WHERE id = ?").run(m.id);
    expect(waitingFor(AUTHOR).map((i) => i.id)).toContain(m.id);
    // And the Yes it asks for is accepted.
    expect(recheck(m.id, AUTHOR, "yes", null, "mcp").changed).toBe(true);
  });

  it("finds a due memory behind more than 300 memories that are not due yet", async () => {
    const due = await duePersonFact();
    const conn = await db();
    // 301 decisions agents read more, so they sort first, all inside their window or disputed.
    for (let i = 0; i < 301; i++) {
      const m = await mk({ kind: "decision" });
      conn
        .prepare("UPDATE learnings SET created_at = datetime('now', ?), access_days = 9, last_accessed_at = datetime('now', '-1 days'), dispute_kind = ? WHERE id = ?")
        .run(i % 3 === 0 ? "-200 days" : "-40 days", i % 3 === 0 ? "no" : null, m.id);
    }
    const { waitingFor } = await import("../lib/checks");
    expect(waitingFor(AUTHOR).map((i) => i.id)).toEqual([due.id]);
  }, 180_000);

  it("uses each memory's own window when it lists what is due", async () => {
    const short = await mk({ kind: "decision", checkEveryDays: 30 });
    const long = await mk({ kind: "decision", checkEveryDays: 365 });
    const standard = await mk({ kind: "standard" });
    for (const m of [short, long, standard]) {
      await backdate(m.id, 130);
      await setAccess(m.id, 3, 5);
    }
    const { waitingFor } = await import("../lib/checks");
    // 130 days: past the 30-day window and the standard's 120, inside the 365-day one.
    expect(waitingFor(AUTHOR).map((i) => i.id).sort()).toEqual([short.id, standard.id].sort());
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
  it("takes one session-start set per day, once it reached the person", async () => {
    const m = await duePersonFact();
    const { takeHookChecks, markChecksDelivered } = await import("../lib/checks");
    expect(takeHookChecks(AUTHOR).map((i) => i.id)).toEqual([m.id]);
    // Nobody fetched it (a session with no person in it): the next session names it again,
    // on the same one row.
    expect(takeHookChecks(AUTHOR).map((i) => i.id)).toEqual([m.id]);
    expect((await db()).prepare("SELECT COUNT(*) AS n FROM check_asks").get()).toEqual({ n: 1 });
    markChecksDelivered(AUTHOR, [m.id]);
    expect(takeHookChecks(AUTHOR)).toEqual([]);
  });

  it("does not let sessions with no person in them use up the week's asks", async () => {
    const m = await duePersonFact();
    const conn = await db();
    // Six memories named over the week and never fetched.
    for (let i = 0; i < 6; i++) {
      const other = await mk({ kind: "decision" });
      conn.prepare("INSERT INTO check_asks (learning_id, user_id, via, delivered_at) VALUES (?, ?, 'nudge', datetime('now', '-2 days'))").run(other.id, AUTHOR);
    }
    const { takeHookChecks } = await import("../lib/checks");
    expect(takeHookChecks(AUTHOR).map((i) => i.id)).toEqual([m.id]);
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

  it("names a memory without starting the pass-on and stale clocks", async () => {
    const m = await duePersonFact();
    const { takeHookChecks, waitingFor } = await import("../lib/checks");
    const { freshnessFor } = await import("../lib/freshness");
    expect(takeHookChecks(AUTHOR).map((i) => i.id)).toEqual([m.id]);
    const conn = await db();
    expect(conn.prepare("SELECT via, answer FROM check_asks WHERE learning_id = ?").all(m.id)).toEqual([{ via: "nudge", answer: null }]);
    // Forty days on with nobody at the keyboard: nobody was asked, so it is due, not stale,
    // and the author is still the one to ask.
    conn.prepare("UPDATE check_asks SET delivered_at = datetime('now', '-40 days') WHERE learning_id = ?").run(m.id);
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("due");
    expect(waitingFor(AUTHOR).map((i) => i.id)).toContain(m.id);
  });

  it("counts a named memory as asked once the agent fetched the list", async () => {
    const m = await duePersonFact();
    const { takeHookChecks, markChecksDelivered } = await import("../lib/checks");
    takeHookChecks(AUTHOR);
    const conn = await db();
    conn.prepare("UPDATE check_asks SET delivered_at = datetime('now', '-3 days') WHERE learning_id = ?").run(m.id);
    markChecksDelivered(AUTHOR, [m.id]);
    const row = conn.prepare("SELECT via, delivered_at >= datetime('now', '-1 minutes') AS now FROM check_asks WHERE learning_id = ?").all(m.id);
    expect(row).toEqual([{ via: "hook", now: 1 }]);
    // Nothing named: nothing changes, and nothing is added.
    markChecksDelivered(AUTHOR, [m.id]);
    markChecksDelivered(BOB, [m.id]);
    markChecksDelivered(AUTHOR, []);
    expect(conn.prepare("SELECT COUNT(*) AS n FROM check_asks").get()).toEqual({ n: 1 });
  });

  it("counts a named memory as asked when its answer comes back, from that moment", async () => {
    const m = await duePersonFact();
    const { takeHookChecks, recheck } = await import("../lib/checks");
    const { freshnessFor } = await import("../lib/freshness");
    takeHookChecks(AUTHOR);
    const conn = await db();
    // Named 40 days ago, answered only now: the 30-day stale clock starts at the answer.
    conn.prepare("UPDATE check_asks SET delivered_at = datetime('now', '-40 days') WHERE learning_id = ?").run(m.id);
    recheck(m.id, AUTHOR, "later", null, "mcp");
    expect(
      conn.prepare("SELECT via, answer, delivered_at >= datetime('now', '-1 minutes') AS now FROM check_asks WHERE learning_id = ?").all(m.id),
    ).toEqual([{ via: "hook", answer: "later", now: 1 }]);
    expect(freshnessFor([m.id]).get(m.id)!.freshness).toBe("due");
    // And it is skipped for a week, like any Ask me later.
    expect(takeHookChecks(AUTHOR)).toEqual([]);
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

describe("a stale memory drops one standing level", () => {
  async function standingOf(id: string) {
    const { standingsFor, getById } = await import("../lib/learnings");
    return standingsFor([getById(id)!]).get(id)!;
  }

  /** A decision three colleagues confirmed: 6 points, strong. */
  async function strongDecision(over: Record<string, unknown> = {}) {
    const { confirm } = await import("../lib/learnings");
    const m = await mk({ kind: "decision", ...over });
    for (const v of [BOB, CID, DEE]) confirm(m.id, v, "Checked the policy page", "mcp");
    return m;
  }

  it("strong drops to fair, with the reason, and comes back once someone rechecks it", async () => {
    const m = await strongDecision();
    expect((await standingOf(m.id)).standing).toBe("strong");
    await setDisputeAge(m.id, 20, "no");
    const stale = await standingOf(m.id);
    expect(stale.standing).toBe("fair");
    expect(stale.standingReason).toContain("stale");
    const { recheck } = await import("../lib/checks");
    recheck(m.id, EVE, "yes", "Checked the policy page again", "mcp");
    const back = await standingOf(m.id);
    expect(back.standing).toBe("strong");
    expect(back.standingReason).not.toContain("stale");
  });

  it("fair drops to weak, and weak stays weak", async () => {
    const { confirm } = await import("../lib/learnings");
    const fair = await mk({ kind: "decision" });
    confirm(fair.id, BOB, "Checked the policy page", "mcp");
    expect((await standingOf(fair.id)).standing).toBe("fair");
    await setDisputeAge(fair.id, 20, "unsure");
    expect((await standingOf(fair.id)).standing).toBe("weak");

    const weak = await mk({ kind: "decision" });
    expect((await standingOf(weak.id)).standing).toBe("weak");
    await setDisputeAge(weak.id, 20, "no");
    expect((await standingOf(weak.id)).standing).toBe("weak");
  });

  it("an author's Yes on a stale memory also brings the level back", async () => {
    const m = await strongDecision();
    await setDisputeAge(m.id, 20, "unsure");
    expect((await standingOf(m.id)).standing).toBe("fair");
    const { recheck } = await import("../lib/checks");
    recheck(m.id, AUTHOR, "yes", null, "mcp");
    expect((await standingOf(m.id)).standing).toBe("strong");
  });

  it("fresh, due and disputed memories keep their level", async () => {
    const { freshnessFor } = await import("../lib/freshness");
    const fresh = await strongDecision();
    expect(freshnessFor([fresh.id]).get(fresh.id)!.freshness).toBe("fresh");
    expect((await standingOf(fresh.id)).standing).toBe("strong");

    const disputed = await strongDecision();
    await setDisputeAge(disputed.id, 3, "no");
    expect(freshnessFor([disputed.id]).get(disputed.id)!.freshness).toBe("disputed");
    expect((await standingOf(disputed.id)).standing).toBe("strong");

    // Due: a 30-day window, last checked 40 days ago, well inside the 180-day standing clock.
    const due = await strongDecision({ checkEveryDays: 30 });
    const conn = await db();
    conn.prepare("UPDATE votes SET created_at = datetime('now', '-40 days') WHERE learning_id = ?").run(due.id);
    conn.prepare("UPDATE learnings SET created_at = datetime('now', '-60 days'), checked_at = datetime('now', '-40 days') WHERE id = ?").run(due.id);
    expect(freshnessFor([due.id]).get(due.id)!.freshness).toBe("due");
    expect((await standingOf(due.id)).standing).toBe("strong");
  });

  it("search results and the memory API carry the lower level", async () => {
    const m = await strongDecision({ title: "Refunds need a second approver zqstale", body: "Over 500 needs two people zqstale" });
    await setDisputeAge(m.id, 20, "no");
    const { search } = await import("../lib/learnings");
    const hit = search("zqstale", {}, 20, 0).find((h) => h.id === m.id)!;
    expect(hit.freshness).toBe("stale");
    expect(hit.standing).toBe("fair");
  });

  it("costs one level at most, also when the entry is old as well", async () => {
    const { computeStanding } = await import("../lib/standing");
    const votes = { helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 3, lastConfirmAt: "2025-01-01 00:00:00" };
    const row = { source: "native" as const, created_at: "2025-01-01 00:00:00" };
    const now = Date.parse("2026-11-24T00:00:00Z");
    expect(computeStanding(votes, row, now).standing).toBe("fair");
    expect(computeStanding({ ...votes, freshnessStale: true }, row, now).standing).toBe("fair");
    const recent = { ...votes, lastConfirmAt: "2026-11-20 00:00:00" };
    expect(computeStanding(recent, row, now).standing).toBe("strong");
    expect(computeStanding({ ...recent, freshnessStale: true }, row, now).standing).toBe("fair");
    expect(computeStanding({ ...recent, confirm: 0, freshnessStale: true }, row, now).standing).toBe("weak");
  });
});

describe("who can take back a No, a Not sure or a flag", () => {
  async function stateOf(id: string) {
    const { freshnessFor } = await import("../lib/freshness");
    return freshnessFor([id]).get(id)!;
  }

  it("a keep by someone else leaves a No on a business fact open", async () => {
    const { recheck } = await import("../lib/checks");
    const { keepLearning, confirm, getById } = await import("../lib/learnings");
    const m = await duePersonFact();
    recheck(m.id, BOB, "no", "The limit changed", "mcp");
    keepLearning(m.id, CID, "mcp");
    expect(getById(m.id)!.dispute_kind).toBe("no");
    expect((await stateOf(m.id)).freshness).toBe("disputed");
    // A confirm, with the note on where it was checked, takes the No back.
    confirm(m.id, DEE, "Checked the policy page", "mcp");
    expect(getById(m.id)!.dispute_kind).toBeNull();
    expect((await stateOf(m.id)).freshness).toBe("fresh");
  });

  it("a keep by someone else leaves a Not sure on a business fact open, and a Yes closes it", async () => {
    const { recheck } = await import("../lib/checks");
    const { keepLearning, getById } = await import("../lib/learnings");
    const m = await mk({ kind: "standard" });
    recheck(m.id, BOB, "unsure", null, "mcp");
    keepLearning(m.id, CID, "mcp", "Still in use");
    expect(getById(m.id)!.dispute_kind).toBe("unsure");
    recheck(m.id, CID, "yes", "Asked the owner of the policy", "mcp");
    expect(getById(m.id)!.dispute_kind).toBeNull();
  });

  it("a keep by someone else still closes a No on a tech fact", async () => {
    const { recheck } = await import("../lib/checks");
    const { keepLearning, getById } = await import("../lib/learnings");
    const m = await mk();
    recheck(m.id, BOB, "no", "The script moved", "mcp");
    keepLearning(m.id, CID, "mcp");
    expect(getById(m.id)!.dispute_kind).toBeNull();
    expect((await stateOf(m.id)).freshness).toBe("fresh");
  });

  it("a maintainer's keep answers the flag on their own standard everywhere", async () => {
    (await import("../lib/db"))._resetDbForTests();
    process.env.BAB_MAINTAINERS = AUTHOR;
    vi.resetModules();
    const { flag, keepLearning, flaggedStandardsWaitingIds, standingsFor, getById, search } = await import("../lib/learnings");
    const { trustFor } = await import("../lib/trust");
    const m = await mk({ kind: "standard", title: "Wombat naming rule zqwom", body: "Wombat names use kebab case zqwom" });
    flag(m.id, BOB, "mcp", "Looks outdated");
    await setFlagAge(m.id, 20);
    expect((await stateOf(m.id)).freshness).toBe("stale");
    expect(flaggedStandardsWaitingIds()).toContain(m.id);

    keepLearning(m.id, AUTHOR, "mcp", "Checked, still our rule");
    expect(flaggedStandardsWaitingIds()).not.toContain(m.id);
    expect(await stateOf(m.id)).toMatchObject({ freshness: "fresh" });
    expect((await stateOf(m.id)).disputeKind).toBeUndefined();
    expect(standingsFor([getById(m.id)!]).get(m.id)!.standingReason).not.toMatch(/stale/i);
    const trust = () => trustFor([getById(m.id)!]).get(m.id)!;
    expect(trust()).toMatchObject({ flags: 0, answeredFlags: 1 });
    const hit = search("wombat naming rule", {}, 5, 0).find((r) => r.id === m.id)!;
    expect(hit.freshness).toBe("fresh");
    expect(hit.freshnessWarning).toBeUndefined();
    // Their own keep is still not a check: it gives no points and does not move the clock.
    expect(trust()).toMatchObject({ unchecked: true, lastCheckedAt: null });
    expect(getById(m.id)!.checked_at).toBeNull();
  });

  it("an author who is no maintainer does not answer a flag with their own keep", async () => {
    const { flag, keepLearning } = await import("../lib/learnings");
    const m = await mk({ kind: "standard" });
    flag(m.id, BOB, "mcp", "Looks outdated");
    keepLearning(m.id, AUTHOR, "mcp", "Still our rule");
    expect(await stateOf(m.id)).toMatchObject({ freshness: "disputed", disputeKind: "flag" });
  });
});

describe("repeats add no rows", () => {
  it("records one skip per week however often Ask me later repeats", async () => {
    const { recheck } = await import("../lib/checks");
    const m = await mk({ kind: "decision" });
    for (let i = 0; i < 10; i++) recheck(m.id, BOB, "later", null, "mcp");
    const conn = await db();
    expect(conn.prepare("SELECT COUNT(*) AS n FROM check_asks WHERE learning_id = ?").get(m.id)).toEqual({ n: 1 });
    // A week later the skip is over: the next one is on record again.
    conn.prepare("UPDATE check_asks SET delivered_at = datetime('now', '-8 days'), answered_at = datetime('now', '-8 days') WHERE learning_id = ?").run(m.id);
    recheck(m.id, BOB, "later", null, "mcp");
    expect(conn.prepare("SELECT COUNT(*) AS n FROM check_asks WHERE learning_id = ?").get(m.id)).toEqual({ n: 2 });
    // Another person's skip is their own.
    recheck(m.id, CID, "later", null, "mcp");
    expect(conn.prepare("SELECT COUNT(*) AS n FROM check_asks WHERE learning_id = ?").get(m.id)).toEqual({ n: 3 });
  });

  it("keeps one history row for a flag repeated with the same evidence, and one more for new evidence", async () => {
    const { flag } = await import("../lib/learnings");
    const { trustHistory } = await import("../lib/trust");
    const m = await mk();
    const evidence = { failure: "api_error" as const, saw: "exit 1" };
    for (let i = 0; i < 10; i++) flag(m.id, BOB, "mcp", "Broken", evidence);
    expect(trustHistory(m.id).filter((e) => e.kind === "flag")).toHaveLength(1);
    flag(m.id, BOB, "mcp", "Broken", { failure: "api_error", saw: "exit 2" });
    const flags = trustHistory(m.id).filter((e) => e.kind === "flag");
    expect(flags).toHaveLength(2);
    expect(flags.map((e) => e.evidence?.saw).sort()).toEqual(["exit 1", "exit 2"]);
  });
});
