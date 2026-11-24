import { getDb, inTransaction } from "./db";
import { audit } from "./audit";
import { emit } from "./events";
import { redact, assertRawLength } from "./redact";
import { todayUtc, parseDbTime } from "./dates";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { confirm, getById, noteArg, openFlagSql } from "./learnings";
import { recordTrustEvent } from "./trust";
import { freshnessFor, parseCheckBy, PERSON_WINDOW_DAYS_SQL, sqlTimeBefore, type CheckBy, type Freshness } from "./freshness";
import type { AuditVia, LearningKind, LearningRow } from "./types";

/**
 * Self-healing memory, the people side (docs/spec.md "Self-healing memory"). A business fact
 * (check_by person, lib/freshness.ts) breaks quietly, so after its window BAB asks a person "Is
 * this still true?": Yes, No, Not sure, Let agents check this, or Ask me later.
 *
 * - recheck(): records one answer. A Yes from someone other than the author is a confirm (it
 *   reuses confirm(), so it adds points and closes open flags). The author's own Yes resets the
 *   clock with no points, at most AUTHOR_YES_STREAK_MAX times in a row for a business fact while
 *   someone else can be asked (a single-person install has no limit). No
 *   and Not sure make the memory disputed until a fix. Nothing here writes a correction: the
 *   person's agent proposes it and the person approves it (bab_learn with supersedes).
 * - waitingFor(): what is waiting for one person (GET /api/checks/mine, bab_search waitingForMe,
 *   the "Waiting for you" view on /memory/review).
 * - takeHookChecks(): the session-start set, at most ASK_SET_MAX memories, once a day and
 *   ASK_WEEK_MAX a week. Only memories agents still read are ever asked about. A memory the hook
 *   named (check_asks via `nudge`) counts as asked (via `hook`) only once the agent fetched the
 *   list (markChecksDelivered) or reported an answer, so a session with no person in it uses up no
 *   ask and starts no clock.
 * - recordServed() and serveStats(): the unchecked serve rate.
 *
 * BAB does not record who read a memory (a deliberate choice), so "in use" is any agent's read.
 */

export const RECHECK_ANSWERS = ["yes", "no", "unsure", "agent", "later"] as const;
export type RecheckAnswer = (typeof RECHECK_ANSWERS)[number];

export const RECHECK_NOTE_MAX = 300;
/** The author may say Yes to their own business fact at most this many times in a row. */
export const AUTHOR_YES_STREAK_MAX = 2;
/** One session-start set holds at most this many memories, once a day. */
export const ASK_SET_MAX = 3;
/** At most this many memories asked per person in any 7 days. */
export const ASK_WEEK_MAX = 6;
/** A memory a person skipped (or was just asked about) is not asked again for this many days. */
export const ASK_SKIP_DAYS = 7;
/** After this many days without an answer, or two skips, the next person on the list is asked. */
export const PASS_ON_DAYS = 14;
export const PASS_ON_SKIPS = 2;
/** Only memories agents read on at least this many days in all, and once in the last IN_USE_RECENT_DAYS. */
export const IN_USE_MIN_DAYS = 2;
export const IN_USE_RECENT_DAYS = 90;
/** Only people who used BAB in the last this many days are asked. */
export const ASKER_ACTIVE_DAYS = 30;
/** A recent user marked it helpful, cited or confirmed it in the last this many days. */
export const RECENT_USER_DAYS = 60;
/** A question shows this many lines of the memory's text; a longer one shows these and a link. */
export const CHECK_TEXT_LINES = 5;

const DAY_MS = 86_400_000;

export function parseRecheckAnswer(raw: unknown): RecheckAnswer {
  if (typeof raw !== "string" || !(RECHECK_ANSWERS as readonly string[]).includes(raw.trim().toLowerCase())) {
    throw new ValidationError(`answer must be one of ${RECHECK_ANSWERS.join(", ")}; required, has no default`);
  }
  return raw.trim().toLowerCase() as RecheckAnswer;
}

function normalizeRecheckNote(raw: unknown, required: boolean): string | null {
  const text = noteArg(raw)?.trim() ?? "";
  if (!text) {
    if (required) throw new ValidationError("note is required: say where you checked or what you saw");
    return null;
  }
  assertRawLength("note", text, RECHECK_NOTE_MAX);
  const redacted = redact(text);
  if (redacted.length > RECHECK_NOTE_MAX) {
    throw new ValidationError(`note must be ${RECHECK_NOTE_MAX} characters or fewer after redaction (emails and numbers are replaced)`);
  }
  return redacted;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * How many times in a row the author said Yes to their own memory, since the last check by
 * someone else (a confirm, keep or restore), from the validation history. One query.
 */
export function authorYesStreaks(ids: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT t.learning_id AS id, COUNT(*) AS n FROM trust_events t
       WHERE t.learning_id IN (${marks}) AND t.kind = 'recheck_yes' AND t.by_author = 1
         AND t.id > COALESCE((SELECT MAX(c.id) FROM trust_events c
           WHERE c.learning_id = t.learning_id AND c.kind IN ('confirm', 'keep', 'restore') AND c.by_author = 0), 0)
       GROUP BY t.learning_id`,
    )
    .all(...ids) as Array<{ id: string; n: number | bigint }>;
  for (const r of rows) out.set(r.id, Number(r.n));
  return out;
}

/** Marks the person's newest open question about the memory answered, or records the answer as asked now. */
function recordAnswer(db: ReturnType<typeof getDb>, learningId: string, userId: string, answer: RecheckAnswer): void {
  const open = db
    .prepare(
      "SELECT id FROM check_asks WHERE learning_id = ? AND lower(user_id) = lower(?) AND answer IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(learningId, userId) as { id: number | bigint } | undefined;
  if (open) {
    // An answer to a memory the hook only named shows it did reach the person: asked as of now.
    db.prepare(
      `UPDATE check_asks SET answer = ?, answered_at = datetime('now'),
         delivered_at = CASE via WHEN 'nudge' THEN datetime('now') ELSE delivered_at END,
         via = CASE via WHEN 'nudge' THEN 'hook' ELSE via END
       WHERE id = ?`,
    ).run(answer, open.id);
  } else {
    if (answer === "later") {
      // A skip inside the skip window is already on record: a repeat adds no row.
      const last = db
        .prepare("SELECT answer, delivered_at FROM check_asks WHERE learning_id = ? AND lower(user_id) = lower(?) ORDER BY id DESC LIMIT 1")
        .get(learningId, userId) as { answer: string | null; delivered_at: string } | undefined;
      if (last?.answer === "later" && last.delivered_at >= sqlTimeBefore(Date.now(), ASK_SKIP_DAYS)) return;
    }
    db.prepare(
      "INSERT INTO check_asks (learning_id, user_id, via, answer, answered_at) VALUES (?, ?, 'direct', ?, datetime('now'))",
    ).run(learningId, userId, answer);
  }
}

export interface RecheckResult {
  learning: LearningRow;
  answer: RecheckAnswer;
  /** false when nothing about the memory moved (a repeat confirm inside 30 days, Let agents check on a tech fact, Ask me later). */
  changed: boolean;
  /** What to do next, in one line, for the agent or the page. */
  next: string;
}

const NEXT: Record<RecheckAnswer, string> = {
  yes: "Thanks. The check clock starts again.",
  no:
    'Marked disputed. Ask the user: "Do you know what it is now?" If yes, write it with bab_learn supersedes and show the exact text first. ' +
    "If not, offer to look in shared project sources only (read only, about 5 tool calls), then propose a supersede or a retire. Nothing is saved without the user's yes.",
  unsure:
    "Marked disputed, with no rank penalty. Look in shared project sources only (read only, about 5 tool calls). If nothing is clear, offer to ask the author or an area contact with bab_send, with the user's yes.",
  agent: "Agents now check this memory in real work, and no person is asked about it.",
  later: `Skipped. BAB will not ask about it again for ${ASK_SKIP_DAYS} days.`,
};

/**
 * One answer to "Is this still true?" (bab_react recheck, the "Waiting for you" page). Anyone may
 * answer about a live memory. See the module comment for what each answer does. `note` is
 * required for a Yes by someone other than the author (it is a confirm), and for the author's own
 * Yes on a tech fact (the evidence).
 */
export function recheck(
  learningId: string,
  actorId: string,
  answerRaw: unknown,
  noteRaw: unknown,
  via: AuditVia = "ui",
): RecheckResult {
  const answer = parseRecheckAnswer(answerRaw);
  const learning = getById(learningId);
  if (!learning || learning.status === "deleted") throw new NotFoundError("Learning not found");
  if (learning.status !== "active") throw new ConflictError(`Memory is ${learning.status}; only a live memory can be checked`);
  const isAuthor = same(learning.author_id, actorId);
  const checkBy: CheckBy = learning.check_by === "person" ? "person" : "agent";
  const db = getDb();

  if (answer === "yes" && !isAuthor) {
    // Stored as a confirm: the same note rule, points, the 30-day repeat rule and flag answering.
    const note = normalizeRecheckNote(noteRaw, true);
    const { learning: after, changed } = confirm(learningId, actorId, note, via);
    inTransaction(db, () => recordAnswer(db, learningId, actorId, "yes"));
    return { learning: after, answer, changed, next: NEXT.yes };
  }

  const note = normalizeRecheckNote(noteRaw, answer === "yes" && checkBy === "agent");
  if (answer === "yes" && checkBy === "person") {
    const streak = authorYesStreaks([learningId]).get(learningId) ?? 0;
    // The limit hands the next check to someone else. With nobody else to ask (a single-person
    // install, or no contact and no recent user for this memory) the author stays the one who checks.
    if (streak >= AUTHOR_YES_STREAK_MAX && someoneElseCanBeAsked(learning)) {
      throw new ConflictError(
        `You said Yes to your own memory ${AUTHOR_YES_STREAK_MAX} times in a row. The next check goes to someone else: ask a colleague to confirm it (bab_react confirm), or leave it for BAB to ask an area contact.`,
      );
    }
  }

  let changed = true;
  inTransaction(db, () => {
    if (answer === "yes") {
      // The author's own Yes: the clock starts again, no points, and open flags stay open (only a
      // check by someone else answers a flag).
      db.prepare("UPDATE learnings SET checked_at = datetime('now'), disputed_at = NULL, dispute_kind = NULL WHERE id = ?").run(learningId);
      recordTrustEvent(db, { learningId, actorId, kind: "recheck_yes", authorId: learning.author_id, note });
    } else if (answer === "no") {
      // A dispute keeps the date it began, so answering again does not make it look newer.
      db.prepare(
        "UPDATE learnings SET dispute_kind = 'no', disputed_at = COALESCE(disputed_at, datetime('now')) WHERE id = ?",
      ).run(learningId);
      recordTrustEvent(db, { learningId, actorId, kind: "recheck_no", authorId: learning.author_id, note });
    } else if (answer === "unsure") {
      db.prepare(
        "UPDATE learnings SET dispute_kind = COALESCE(dispute_kind, 'unsure'), disputed_at = COALESCE(disputed_at, datetime('now')) WHERE id = ?",
      ).run(learningId);
      recordTrustEvent(db, { learningId, actorId, kind: "recheck_unsure", authorId: learning.author_id, note });
    } else if (answer === "agent") {
      if (checkBy === "agent") changed = false;
      else {
        db.prepare("UPDATE learnings SET check_by = 'agent' WHERE id = ?").run(learningId);
        recordTrustEvent(db, { learningId, actorId, kind: "recheck_agent", authorId: learning.author_id, note });
      }
    } else {
      changed = false;
    }
    recordAnswer(db, learningId, actorId, answer);
    if (changed) audit(db, actorId, "recheck", "learning", learningId, via, { details: { answer } });
  });
  if (changed) emit("learning.updated", learningId, { id: learningId, title: learning.title, kind: "active" });
  return { learning: getById(learningId)!, answer, changed, next: NEXT[answer] };
}

/**
 * Changes who checks a memory (bab_react check_by): the author at any time, anyone else with a
 * note, for example when an agent finds a "due" tech fact it cannot test. Logged in the history.
 */
export function changeCheckBy(
  learningId: string,
  actorId: string,
  checkByRaw: unknown,
  noteRaw: unknown,
  via: AuditVia = "ui",
): { learning: LearningRow; changed: boolean } {
  const checkBy = parseCheckBy(checkByRaw);
  if (!checkBy) throw new ValidationError("checkBy is required: agent or person");
  const learning = getById(learningId);
  if (!learning || learning.status === "deleted") throw new NotFoundError("Learning not found");
  if (learning.status !== "active") throw new ConflictError(`Memory is ${learning.status}; only a live memory can change who checks it`);
  const isAuthor = same(learning.author_id, actorId);
  const note = normalizeRecheckNote(noteRaw, !isAuthor);
  if (learning.check_by === checkBy) return { learning, changed: false };
  const db = getDb();
  inTransaction(db, () => {
    db.prepare("UPDATE learnings SET check_by = ? WHERE id = ?").run(checkBy, learningId);
    recordTrustEvent(db, {
      learningId,
      actorId,
      kind: "check_by_changed",
      authorId: learning.author_id,
      note: note ? `now ${checkBy}: ${note}` : `now ${checkBy}`,
    });
    audit(db, actorId, "check_by", "learning", learningId, via, { details: { checkBy } });
  });
  emit("learning.updated", learningId, { id: learningId, title: learning.title, kind: "active" });
  return { learning: getById(learningId)!, changed: true };
}

export interface CheckItem {
  id: string;
  title: string;
  kind: LearningKind;
  /** The memory's exact text, at most CHECK_TEXT_LINES lines. */
  text: string;
  /** true when the text was longer: show the link to the full memory. */
  truncated: boolean;
  checkBy: CheckBy;
  freshness: Freshness["freshness"];
  /** true when the caller wrote it. */
  own: boolean;
  /** Whole days since its last check (made, confirmed or answered Yes). */
  checkedDaysAgo: number;
  /** Days on which agents read it, in all. */
  readDays: number;
  /** due: BAB asks whether it is still true. followUp: you answered No or Not sure and it waits for a fix. */
  reason: "due" | "followUp";
  /** Your newest answer about it, when you gave one since its last check. */
  lastAnswer?: RecheckAnswer;
}

type CandidateRow = Pick<LearningRow, "id" | "title" | "kind" | "author_id" | "body" | "tags" | "access_days"> & { pinned: number };

function clip(body: string): { text: string; truncated: boolean } {
  const lines = body.split(/\r?\n/);
  return lines.length > CHECK_TEXT_LINES
    ? { text: lines.slice(0, CHECK_TEXT_LINES).join("\n"), truncated: true }
    : { text: body, truncated: false };
}

function parseTagList(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()) : [];
  } catch {
    return [];
  }
}

interface AskRow {
  learning_id: string;
  user_id: string;
  via: string;
  delivered_at: string;
  answer: string | null;
}

/**
 * Who BAB asks about each due business fact, in order: the author, then area contacts whose area
 * is one of its tags, then people who marked it helpful, cited or confirmed it in the last
 * RECENT_USER_DAYS days. It stops at the first who used BAB in the last ASKER_ACTIVE_DAYS days and
 * was not passed over: two skips, or no answer for PASS_ON_DAYS days, since its last check. The
 * author is passed over after AUTHOR_YES_STREAK_MAX Yes answers in a row, unless nobody else is
 * left: then the author is asked again. `exceptAuthor` leaves the author out altogether (who else
 * could be asked). Nobody left: undefined, and maintainers see it on /memory/review.
 */
function askersFor(
  rows: Array<Pick<LearningRow, "id" | "author_id" | "tags">>,
  fresh: Map<string, Freshness>,
  now: number,
  exceptAuthor = false,
): Map<string, string | undefined> {
  const db = getDb();
  const out = new Map<string, string | undefined>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const lastSeen = new Map(
    (db.prepare("SELECT lower(id) AS id, last_seen_at AS at FROM users").all() as Array<{ id: string; at: string }>).map((u) => [u.id, u.at]),
  );
  const contacts = db.prepare("SELECT area, user_id AS userId FROM area_contacts ORDER BY created_at, user_id").all() as Array<{
    area: string;
    userId: string;
  }>;
  const recentSince = sqlTimeBefore(now, RECENT_USER_DAYS);
  const recent = new Map<string, string[]>();
  for (const v of db
    .prepare(
      `SELECT learning_id AS id, voter_id AS userId FROM votes WHERE learning_id IN (${marks})
       AND kind IN ('helpful', 'cited', 'confirm') AND created_at >= ? ORDER BY created_at DESC`,
    )
    .all(...ids, recentSince) as Array<{ id: string; userId: string }>) {
    recent.set(v.id, [...(recent.get(v.id) ?? []), v.userId]);
  }
  const asks = new Map<string, AskRow[]>();
  for (const a of db
    .prepare(`SELECT learning_id, user_id, via, delivered_at, answer FROM check_asks WHERE learning_id IN (${marks}) ORDER BY id`)
    .all(...ids) as unknown as AskRow[]) {
    asks.set(a.learning_id, [...(asks.get(a.learning_id) ?? []), a]);
  }
  const streaks = authorYesStreaks(ids);
  const activeSince = now - ASKER_ACTIVE_DAYS * DAY_MS;
  const passOnBefore = now - PASS_ON_DAYS * DAY_MS;
  for (const r of rows) {
    const since = fresh.get(r.id)?.checkedAt ?? "";
    const mine = (asks.get(r.id) ?? []).filter((a) => a.delivered_at > since);
    const tags = new Set(parseTagList(r.tags));
    const list = [
      r.author_id,
      ...contacts.filter((c) => tags.has(c.area)).map((c) => c.userId),
      ...(recent.get(r.id) ?? []).filter((u) => !same(u, r.author_id)),
    ];
    const seen = new Set<string>();
    let asker: string | undefined;
    // The author after AUTHOR_YES_STREAK_MAX Yes answers in a row: asked only when nobody else is.
    let authorAtLimit: string | undefined;
    for (const u of list) {
      const key = u.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const isAuthor = same(u, r.author_id);
      if (isAuthor && exceptAuthor) continue;
      const at = lastSeen.get(key);
      if (!at || parseDbTime(at).getTime() < activeSince) continue;
      const theirs = mine.filter((a) => same(a.user_id, u));
      const skips = theirs.filter((a) => a.answer === "later").length;
      const ignored = theirs.some((a) => a.via === "hook" && a.answer === null && parseDbTime(a.delivered_at).getTime() < passOnBefore);
      if (skips >= PASS_ON_SKIPS || ignored) continue;
      if (isAuthor && (streaks.get(r.id) ?? 0) >= AUTHOR_YES_STREAK_MAX) {
        authorAtLimit = u;
        continue;
      }
      asker = u;
      break;
    }
    out.set(r.id, asker ?? authorAtLimit);
  }
  return out;
}

/** true when someone other than the author could be asked about this memory now (see askersFor). */
function someoneElseCanBeAsked(learning: LearningRow, now: number = Date.now()): boolean {
  return askersFor([learning], freshnessFor([learning.id], now), now, true).get(learning.id) !== undefined;
}

/** Due business facts still in use, most important first (pinned, decisions, standards, most read), at most `limit`. */
function dueCandidates(now: number, limit = 300): { rows: CandidateRow[]; fresh: Map<string, Freshness> } {
  const rows = getDb()
    .prepare(
      // Each memory's own window and the dispute tests come before the LIMIT, so memories that are
      // not due yet, or disputed, never push a due one off the list. freshnessFor has the last word.
      `SELECT id, title, kind, author_id, body, tags, access_days, pinned FROM learnings
       WHERE status = 'active' AND check_by = 'person' AND access_days >= ? AND last_accessed_at >= ?
         AND COALESCE(checked_at, created_at) < datetime(?, '-' || ${PERSON_WINDOW_DAYS_SQL} || ' days')
         AND dispute_kind IS NULL AND NOT ${openFlagSql()}
       ORDER BY pinned DESC, CASE kind WHEN 'decision' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END, access_days DESC, id
       LIMIT ?`,
    )
    .all(IN_USE_MIN_DAYS, sqlTimeBefore(now, IN_USE_RECENT_DAYS), sqlTimeBefore(now, 0), limit) as unknown as CandidateRow[];
  const fresh = freshnessFor(rows.map((r) => r.id), now);
  return { rows: rows.filter((r) => fresh.get(r.id)?.checkDue && !fresh.get(r.id)?.disputeKind), fresh };
}

function item(r: CandidateRow, f: Freshness, userId: string, reason: CheckItem["reason"], now: number, lastAnswer?: string | null): CheckItem {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    ...clip(r.body),
    checkBy: f.checkBy,
    freshness: f.freshness,
    own: same(r.author_id, userId),
    checkedDaysAgo: Math.max(0, Math.floor((now - parseDbTime(f.checkedAt).getTime()) / DAY_MS)),
    readDays: Number(r.access_days ?? 0),
    reason,
    ...(lastAnswer ? { lastAnswer: lastAnswer as RecheckAnswer } : {}),
  };
}

/**
 * What waits for one person: the due business facts BAB would ask them about (see askersFor),
 * then the ones they answered No or Not sure about that still wait for a fix. No daily limit here:
 * the limits are for questions BAB starts (takeHookChecks).
 */
export function waitingFor(userId: string, now: number = Date.now()): CheckItem[] {
  const { rows, fresh } = dueCandidates(now);
  const askers = askersFor(rows, fresh, now);
  const latest = latestAnswers(userId, rows.map((r) => r.id));
  const due = rows
    .filter((r) => {
      const a = askers.get(r.id);
      return a !== undefined && same(a, userId);
    })
    .map((r) => item(r, fresh.get(r.id)!, userId, "due", now, latest.get(r.id)?.answer));
  const followRows = getDb()
    .prepare(
      `SELECT l.id, l.title, l.kind, l.author_id, l.body, l.tags, l.access_days, l.pinned FROM learnings l
       WHERE l.status = 'active' AND l.dispute_kind IS NOT NULL
         AND (SELECT a.answer FROM check_asks a WHERE a.learning_id = l.id AND lower(a.user_id) = lower(?) AND a.answer IS NOT NULL
              ORDER BY a.id DESC LIMIT 1) IN ('no', 'unsure')
       ORDER BY l.disputed_at, l.id LIMIT 50`,
    )
    .all(userId) as unknown as CandidateRow[];
  const followFresh = freshnessFor(followRows.map((r) => r.id), now);
  const followLatest = latestAnswers(userId, followRows.map((r) => r.id));
  const followUp = followRows
    .filter((r) => followFresh.has(r.id))
    .map((r) => item(r, followFresh.get(r.id)!, userId, "followUp", now, followLatest.get(r.id)?.answer));
  return [...due, ...followUp];
}

/** The person's newest ask or answer per memory. A memory the hook only named (via `nudge`) is neither. */
function latestAnswers(userId: string, ids: string[]): Map<string, { answer: string | null; delivered_at: string; via: string }> {
  const out = new Map<string, { answer: string | null; delivered_at: string; via: string }>();
  if (ids.length === 0) return out;
  const marks = ids.map(() => "?").join(",");
  for (const r of getDb()
    .prepare(
      `SELECT learning_id AS id, answer, delivered_at, via FROM check_asks
       WHERE lower(user_id) = lower(?) AND learning_id IN (${marks}) AND via <> 'nudge' ORDER BY id`,
    )
    .all(userId, ...ids) as Array<{ id: string; answer: string | null; delivered_at: string; via: string }>) {
    out.set(r.id, r);
  }
  return out;
}

/**
 * The session-start set for one person (app/api/hook/route.ts): at most ASK_SET_MAX of the
 * memories waiting for them, once per UTC day and at most ASK_WEEK_MAX in any 7 days, never one
 * they were asked about or skipped in the last ASK_SKIP_DAYS days. Each one is recorded as named
 * (check_asks, via `nudge`, one open row per person and memory). It becomes a delivered ask (via
 * `hook`, from that moment) when the agent fetches the list (markChecksDelivered) or reports an
 * answer. Only delivered asks count for the limits and start the pass-on and stale clocks, so a
 * session with no person in it uses up nothing, and the next session names the same memories
 * again; "answered" is only recorded when the agent reports back with bab_react recheck.
 */
export function takeHookChecks(userId: string, now: number = Date.now()): CheckItem[] {
  const db = getDb();
  const today = `${todayUtc()} 00:00:00`;
  const askedToday = db
    .prepare("SELECT 1 FROM check_asks WHERE lower(user_id) = lower(?) AND via = 'hook' AND delivered_at >= ? LIMIT 1")
    .get(userId, today);
  if (askedToday) return [];
  const { n: week } = db
    .prepare("SELECT COUNT(*) AS n FROM check_asks WHERE lower(user_id) = lower(?) AND via = 'hook' AND delivered_at >= ?")
    .get(userId, sqlTimeBefore(now, 7)) as { n: number };
  const room = Math.min(ASK_SET_MAX, ASK_WEEK_MAX - Number(week));
  if (room <= 0) return [];
  const waiting = waitingFor(userId, now).filter((i) => i.reason === "due");
  const latest = latestAnswers(userId, waiting.map((i) => i.id));
  const skipSince = now - ASK_SKIP_DAYS * DAY_MS;
  const pick = waiting
    .filter((i) => {
      const last = latest.get(i.id);
      return !last || parseDbTime(last.delivered_at).getTime() < skipSince;
    })
    .slice(0, room);
  if (pick.length === 0) return [];
  inTransaction(db, () => {
    // A memory named before and never fetched keeps its one row.
    const insert = db.prepare(
      `INSERT INTO check_asks (learning_id, user_id, via) SELECT ?, ?, 'nudge'
       WHERE NOT EXISTS (SELECT 1 FROM check_asks WHERE learning_id = ? AND lower(user_id) = lower(?) AND via = 'nudge')`,
    );
    for (const i of pick) insert.run(i.id, userId, i.id, userId);
  });
  return pick;
}

/**
 * The agent fetched the person's list (bab_search waitingForMe): the memories its session hook
 * named are now delivered asks, from this moment. Only the newest open one per memory.
 */
export function markChecksDelivered(userId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(",");
  getDb()
    .prepare(
      `UPDATE check_asks SET via = 'hook', delivered_at = datetime('now')
       WHERE id IN (SELECT MAX(id) FROM check_asks
                    WHERE lower(user_id) = lower(?) AND via = 'nudge' AND answer IS NULL AND learning_id IN (${marks})
                    GROUP BY learning_id)`,
    )
    .run(userId, ...ids);
}

/** A served result counts as unchecked when it is due or stale, or disputed for more than this many days. */
export const SERVE_DISPUTE_GRACE_DAYS = 7;
/** Only the top results count: those are the ones agents act on. */
export const SERVE_TOP = 3;
/** The rate looks back this many days. */
export const SERVE_WINDOW_DAYS = 30;

/**
 * Counts the top SERVE_TOP results of one agent search into freshness_daily, for the unchecked serve
 * rate. A new dispute does not count for its first SERVE_DISPUTE_GRACE_DAYS days, so catching a
 * mistake does not make the number worse.
 */
export function recordServed(results: Array<{ freshness?: Freshness["freshness"]; id: string }>, now: number = Date.now()): void {
  const top = results.slice(0, SERVE_TOP).filter((r) => r.freshness);
  if (top.length === 0) return;
  const fresh = freshnessFor(top.filter((r) => r.freshness === "disputed").map((r) => r.id), now);
  const graceBefore = now - SERVE_DISPUTE_GRACE_DAYS * DAY_MS;
  const n = { fresh: 0, due: 0, disputed: 0, stale: 0, unchecked: 0 };
  for (const r of top) {
    n[r.freshness!] += 1;
    const since = fresh.get(r.id)?.disputedSince;
    if (r.freshness === "due" || r.freshness === "stale") n.unchecked += 1;
    else if (r.freshness === "disputed" && since && parseDbTime(since).getTime() < graceBefore) n.unchecked += 1;
  }
  getDb()
    .prepare(
      `INSERT INTO freshness_daily (day, served, served_fresh, served_due, served_disputed, served_stale, served_unchecked)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET served = served + excluded.served, served_fresh = served_fresh + excluded.served_fresh,
         served_due = served_due + excluded.served_due, served_disputed = served_disputed + excluded.served_disputed,
         served_stale = served_stale + excluded.served_stale, served_unchecked = served_unchecked + excluded.served_unchecked`,
    )
    .run(new Date(now).toISOString().slice(0, 10), top.length, n.fresh, n.due, n.disputed, n.stale, n.unchecked);
}

export interface ServeStats {
  /** Top results served to agents in the window. */
  served: number;
  /** Of those, the due, stale, or disputed for more than 7 days. */
  unchecked: number;
  /** unchecked / served, 0 to 1, or null when nothing was served. Lower is better. */
  rate: number | null;
  byState: { fresh: number; due: number; disputed: number; stale: number };
  /** Questions asked at session start, at least 7 days ago, inside the window. */
  asked: number;
  /** Of those, answered within 7 days (Ask me later is not an answer). */
  answered: number;
  /** answered / asked, or null when nobody was asked. */
  answerRate: number | null;
}

/**
 * The unchecked serve rate over the last SERVE_WINDOW_DAYS days, and the answer rate next to it. It
 * measures how often agents get unchecked advice, not how often they get wrong advice: a memory
 * that went wrong last week but is inside its window looks fresh.
 */
export function serveStats(now: number = Date.now()): ServeStats {
  const db = getDb();
  const since = new Date(now - SERVE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(served), 0) AS served, COALESCE(SUM(served_unchecked), 0) AS unchecked, COALESCE(SUM(served_fresh), 0) AS fresh,
              COALESCE(SUM(served_due), 0) AS due, COALESCE(SUM(served_disputed), 0) AS disputed, COALESCE(SUM(served_stale), 0) AS stale
       FROM freshness_daily WHERE day >= ?`,
    )
    .get(since) as Record<string, number | bigint>;
  const a = db
    .prepare(
      `SELECT COUNT(*) AS asked,
              SUM(CASE WHEN answer IS NOT NULL AND answer <> 'later' AND answered_at <= datetime(delivered_at, '+7 days') THEN 1 ELSE 0 END) AS answered
       FROM check_asks WHERE via = 'hook' AND delivered_at >= ? AND delivered_at < ?`,
    )
    .get(sqlTimeBefore(now, SERVE_WINDOW_DAYS), sqlTimeBefore(now, 7)) as { asked: number | bigint; answered: number | bigint | null };
  const served = Number(r.served);
  const unchecked = Number(r.unchecked);
  const asked = Number(a.asked);
  const answered = Number(a.answered ?? 0);
  return {
    served,
    unchecked,
    rate: served > 0 ? unchecked / served : null,
    byState: { fresh: Number(r.fresh), due: Number(r.due), disputed: Number(r.disputed), stale: Number(r.stale) },
    asked,
    answered,
    answerRate: asked > 0 ? answered / asked : null,
  };
}
