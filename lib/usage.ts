import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { flaggedStandardsWaitingIds, INACTIVITY_CLOCK_START, LEARNING_KINDS, standingsFor } from "./learnings";
import { generalProjectCount, topProjects } from "./stats";
import type { StandingLevel } from "./standing";

/**
 * The numbers behind /usage (docs/spec.md "Usage page"). Weekly numbers cover the last 12 months,
 * USAGE_WEEKS ISO weeks (Monday to Sunday, UTC), from audit_log; "what's in BAB" counts the live memories
 * (status active) in learnings. Every audit query is bounded by `at >=` the first
 * Monday (or the last 30 days) and runs on idx_audit_action_at, idx_audit_path_at or idx_audit_at;
 * every learnings query is bounded by status, created_at or last_accessed_at.
 * The standing mix reads at most STANDING_SAMPLE_MAX memories.
 *
 * Everyone can open the page, so the page reads cachedUsageReport(): one computed report shared
 * for USAGE_CACHE_MS. The report holds the maintainer-only rows too; the page decides what to show.
 *
 * Some numbers start when they started being recorded (USAGE_COLLECTING_SINCE): Stop nudges,
 * identify refusals, the `cx` session detail and the model behind a memory.
 */

/** The window of every windowed number on the page: 52 ISO weeks, about 12 months (audit rows are kept 365 days by default). */
export const USAGE_WEEKS = 52;
/** A Stop nudge counts as followed when the same person calls bab_learn within this many minutes. */
export const NUDGE_FOLLOW_MINUTES = 10;
/** More bab_identify calls than this from one device or connection on one day is a loop. */
export const IDENTIFY_LOOP_THRESHOLD = 3;
/**
 * The day the Stop-nudge and identify-refused audit rows, the `cx` detail and learnings.model
 * started. Before it those numbers read 0 because nothing recorded them.
 */
export const USAGE_COLLECTING_SINCE = "2026-10-06";
/** "This month" on the page: the last 30 days. */
export const MONTH_DAYS = 30;
/** A live memory no agent has read for this long is "quiet": three months from being archived (INACTIVITY_ARCHIVE_DAYS in lib/learnings.ts). */
export const QUIET_DAYS = 270;
/** How long one computed report is served to everyone. */
export const USAGE_CACHE_MS = 5 * 60_000;
/** The standing mix reads the newest this many live memories, so its vote queries stay bounded. */
export const STANDING_SAMPLE_MAX = 5000;
/** The growth line keeps at most this many weeks; older ones fold into its starting value. */
export const GROWTH_WEEKS_MAX = 156;
/** Model names beyond this many fold into "other". */
export const MODELS_SHOWN = 6;

const LEARN_PATH = "/mcp#tools/call:bab_learn";
/** A search is a bab_search call or a GET on the REST search (the documented curl fallback). */
const SEARCH_TOOL_PATH = "/mcp#tools/call:bab_search";
const SEARCH_API_PATH = "/api/learnings";
/** Reactions that say a memory helped: helpful, kudos and confirm (not not_helpful or flag). */
const HELPFUL_ACTIONS = "('helpful', 'kudos', 'confirm')";
/** Audit actor ids that are not a person. */
const NOT_PEOPLE = "('anonymous', 'system')";
const LIVE = "('active')";
const DAY_MS = 86_400_000;

/** The team tags from the bab_learn tool description. */
export const TEAM_TAGS = [
  "engineering", "product", "marketing", "sales", "content", "legal", "regulatory",
  "finance", "hr", "management", "operations", "it", "data",
] as const;

/** Monday of the week containing a UTC date, as YYYY-MM-DD. */
export function weekStart(d: Date): string {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const back = (day.getUTCDay() + 6) % 7; // Monday = 0
  day.setUTCDate(day.getUTCDate() - back);
  return day.toISOString().slice(0, 10);
}

/** ISO 8601 week label ("2026-W41") for a Monday given as YYYY-MM-DD. */
export function isoWeekLabel(monday: string): string {
  const d = new Date(`${monday}T00:00:00Z`);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3); // the Thursday decides which ISO year the week is in
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const week = Math.round((d.getTime() - week1Monday.getTime()) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The last `count` Mondays, oldest first, ending with the current week. */
export function lastWeeks(now: Date, count = USAGE_WEEKS): string[] {
  const current = new Date(`${weekStart(now)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(current);
    d.setUTCDate(current.getUTCDate() - 7 * (count - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

/** SQL for the Monday of the week a timestamp column falls in (matches weekStart). */
function weekSql(column: string): string {
  return `date(${column}, '-6 days', 'weekday 1')`;
}

/** A Date as SQLite's datetime text ("YYYY-MM-DD HH:MM:SS", UTC), the format audit_log.at uses. */
function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function sqlDate(monday: string): string {
  return `${monday} 00:00:00`;
}

function num(v: number | bigint | null | undefined): number {
  return Number(v ?? 0);
}

export interface CaptureWeek {
  week: string;
  label: string;
  learnCalls: number;
  /** Distinct devices or connections that called bab_learn (rows written before `cx` existed do not count). */
  sessions: number;
  /** Distinct people (audit actors) that called bab_learn. */
  people: number;
  nudges: number;
  followed: number;
}

export interface IdentifyWeek {
  week: string;
  label: string;
  identifies: number;
  none: number;
  refused: number;
}

export interface IdentifyLoop {
  day: string;
  /** What the calls were grouped by: device, connection, or address (older rows). */
  by: "device" | "connection" | "address";
  who: string;
  calls: number;
}

export interface FlaggedItem {
  id: string;
  title: string;
  kind: string;
  authorId: string;
  flaggedAt: string;
  flaggers: number;
}

export interface QualityWeek {
  week: string;
  label: string;
  created: number;
  duplicateRejected: number;
}

export interface TeamWeek {
  week: string;
  label: string;
  /** Distinct authors per team tag among learnings created that week. */
  byTeam: Record<string, number>;
  /** Distinct authors with a learning that week that has no team tag. */
  noTeamTag: number;
}

/** The four headline counts, for one week or the whole window. */
export interface ActivityCounts {
  /** Memories stored (audit `create` on a learning). */
  saves: number;
  /** bab_search calls and GETs on /api/learnings. */
  searches: number;
  /** helpful, kudos and confirm reactions. */
  reactions: number;
  /** Distinct people (audit actors, not anonymous or system) who used any BAB tool or page. */
  people: number;
}

export interface ActivityWeek extends ActivityCounts {
  week: string;
  label: string;
  /** People whose first activity in the window is this week (they sum to the window's distinct people). */
  newPeople: number;
}

export interface GrowthPoint {
  week: string;
  /** Live memories saved up to the end of this week. */
  total: number;
}

export interface Growth {
  /** One point per week from the week of the oldest live memory (at most GROWTH_WEEKS_MAX). */
  points: GrowthPoint[];
  /** Live memories now (status active). */
  live: number;
  /** Live memories saved in the last MONTH_DAYS days. */
  lastMonth: number;
}

export interface Count {
  key: string;
  n: number;
}

export interface Contents {
  byKind: Count[];
  /** Live memories per team tag; a memory with two team tags counts for both. */
  byTeam: Count[];
  noTeamTag: number;
  standing: Record<StandingLevel, number>;
  /** How many memories the standing mix read (at most STANDING_SAMPLE_MAX). */
  standingRead: number;
}

export interface HelpfulItem {
  id: string;
  title: string;
  kind: string;
  helpful: number;
  kudos: number;
  confirm: number;
  total: number;
}

export interface Upkeep {
  /** Live learnings and practices no agent has read for QUIET_DAYS or more: archived at INACTIVITY_ARCHIVE_DAYS unless read or kept. */
  quiet: number;
  /** In the last MONTH_DAYS days: memories the sweep archived because no agent read them for a year. */
  archivedUnread: number;
  /** In the last MONTH_DAYS days. */
  kept: number;
  restored: number;
  retired: number;
}

/** One week of the Clean-up card (swarm garbage collection, docs/spec.md), from audit_log. */
export interface CleanupWeek {
  week: string;
  label: string;
  /** Archived by the sweep because no agent read them for a year (`auto-archive`, reason `inactive`). */
  inactive: number;
  /** Learnings and practices archived because colleagues marked them not helpful and no agent read them for 90 days (`downvote_archived`). */
  downvoted: number;
  /** Archived by two flags (`auto_archive`). */
  flagged: number;
  /** Retired by someone (`retire`). */
  retired: number;
  /** Brought back or kept (`restored`, `keep`). */
  kept: number;
  /** Confirms on old memories nobody had checked in 90 days (`confirm` with details.verified). */
  verified: number;
}

export interface UsageReport {
  weeks: string[];
  activity: ActivityWeek[];
  /** The hero tiles: saves, searches and reactions summed over the window; people are distinct, not a sum of weekly counts. */
  totals: ActivityCounts;
  growth: Growth;
  contents: Contents;
  topHelpful: HelpfulItem[];
  topProjects: Array<{ project: string; n: number }>;
  /** Live memories with no project (the "General" bucket on /memory). */
  generalCount: number;
  /** Memories saved since USAGE_COLLECTING_SINCE by the model their author named; "" is not stated. */
  models: Count[];
  upkeep: Upkeep;
  capture: CaptureWeek[];
  identify: IdentifyWeek[];
  identifyLoops: IdentifyLoop[];
  refusalsByReason: Array<{ reason: string; n: number }>;
  quality: QualityWeek[];
  teams: TeamWeek[];
  cleanup: CleanupWeek[];
  flagged: FlaggedItem[];
  /** When the oldest audit row was written (SQL datetime), or null for an empty audit log. */
  dataSince: string | null;
  /** When this report was computed (ISO 8601, UTC). */
  generatedAt: string;
}

/* ------------------------------------------------------------------ activity */

/**
 * Saves, searches, reactions, active people and first-time people per week between `from`
 * (inclusive) and `to` (exclusive), keyed by Monday. Four queries, each on an (action|path, at) or (at) index range.
 * `+entity` keeps the planner off idx_audit_entity, which is not bounded by time.
 */
function activityRows(from: string, to: string): Map<string, ActivityCounts & { newPeople: number }> {
  const db = getDb();
  const out = new Map<string, ActivityCounts & { newPeople: number }>();
  const slot = (week: string) => {
    let c = out.get(week);
    if (!c) {
      c = { saves: 0, searches: 0, reactions: 0, people: 0, newPeople: 0 };
      out.set(week, c);
    }
    return c;
  };
  const writes = db
    .prepare(
      `SELECT ${weekSql("at")} AS week,
              SUM(action = 'create') AS saves, SUM(action IN ${HELPFUL_ACTIONS}) AS reactions
       FROM audit_log
       WHERE action IN ('create', 'helpful', 'kudos', 'confirm') AND at >= ? AND at < ? AND +entity = 'learning'
       GROUP BY week`,
    )
    .all(from, to) as Array<{ week: string; saves: number; reactions: number }>;
  for (const r of writes) Object.assign(slot(r.week), { saves: num(r.saves), reactions: num(r.reactions) });
  const searches = db
    .prepare(
      `SELECT ${weekSql("at")} AS week, COUNT(*) AS n
       FROM audit_log
       WHERE path IN (?, ?) AND at >= ? AND at < ? AND (path = ? OR action = 'GET')
       GROUP BY week`,
    )
    .all(SEARCH_TOOL_PATH, SEARCH_API_PATH, from, to, SEARCH_TOOL_PATH) as Array<{ week: string; n: number }>;
  for (const r of searches) slot(r.week).searches = num(r.n);
  const people = db
    .prepare(
      `SELECT ${weekSql("at")} AS week, COUNT(DISTINCT actor_id) AS n
       FROM audit_log WHERE at >= ? AND at < ? AND actor_id NOT IN ${NOT_PEOPLE}
       GROUP BY week`,
    )
    .all(from, to) as Array<{ week: string; n: number }>;
  for (const r of people) slot(r.week).people = num(r.n);
  // Each person counts once, in the week of their first activity in the range: the weekly values
  // add up to the range's distinct people.
  const firsts = db
    .prepare(
      `SELECT ${weekSql("first_at")} AS week, COUNT(*) AS n
       FROM (SELECT MIN(at) AS first_at FROM audit_log
             WHERE at >= ? AND at < ? AND actor_id NOT IN ${NOT_PEOPLE} GROUP BY actor_id)
       GROUP BY week`,
    )
    .all(from, to) as Array<{ week: string; n: number }>;
  for (const r of firsts) slot(r.week).newPeople = num(r.n);
  return out;
}

export function activityByWeek(weeks: string[]): ActivityWeek[] {
  const rows = activityRows(sqlDate(weeks[0]), "9999-12-31 23:59:59");
  return weeks.map((week) => ({
    week,
    label: isoWeekLabel(week),
    ...(rows.get(week) ?? { saves: 0, searches: 0, reactions: 0, people: 0, newPeople: 0 }),
  }));
}

/** The window's totals for the hero tiles: the weekly counts added up, and the distinct people (each counted once). */
export function activityTotals(activity: ActivityWeek[]): ActivityCounts {
  const sum = (key: "saves" | "searches" | "reactions" | "newPeople") => activity.reduce((n, w) => n + w[key], 0);
  return { saves: sum("saves"), searches: sum("searches"), reactions: sum("reactions"), people: sum("newPeople") };
}

/* ------------------------------------------------------------- what's in BAB */

/**
 * Live memories by the week they were saved, added up. There is no archive date to subtract, so
 * this is "memories still live, by the week they were saved": the last point is today's count.
 */
export function growth(now: Date): Growth {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ${weekSql("created_at")} AS week, COUNT(*) AS n
       FROM learnings WHERE status IN ${LIVE} GROUP BY week ORDER BY week`,
    )
    .all() as Array<{ week: string | null; n: number }>;
  const byWeek = new Map<string, number>();
  for (const r of rows) if (r.week) byWeek.set(r.week, num(r.n));
  const live = [...byWeek.values()].reduce((a, b) => a + b, 0);
  const monthAgo = sqlTime(new Date(now.getTime() - MONTH_DAYS * DAY_MS));
  const lastMonth = num(
    (db.prepare(`SELECT COUNT(*) AS n FROM learnings WHERE status IN ${LIVE} AND created_at >= ?`).get(monthAgo) as {
      n: number;
    }).n,
  );
  if (byWeek.size === 0) return { points: [], live, lastMonth };

  const current = weekStart(now);
  const first = [...byWeek.keys()].sort()[0];
  const all: string[] = [];
  for (let d = new Date(`${first}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 7)) {
    const w = d.toISOString().slice(0, 10);
    if (w > current && all.length > 0) break;
    all.push(w);
    if (w >= current) break;
  }
  const shown = all.slice(-GROWTH_WEEKS_MAX);
  // Older weeks fold into the starting value; memories dated after this week (clock skew) into the last.
  let total = 0;
  for (const [w, n] of byWeek) if (w < shown[0]) total += n;
  const points = shown.map((week, i) => {
    total += byWeek.get(week) ?? 0;
    if (i === shown.length - 1) for (const [w, n] of byWeek) if (w > week) total += n;
    return { week, total };
  });
  return { points, live, lastMonth };
}

export function contents(): Contents {
  const db = getDb();
  const kindRows = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM learnings WHERE status IN ${LIVE} GROUP BY kind`)
    .all() as Array<{ kind: string; n: number }>;
  const kinds = new Map(kindRows.map((r) => [r.kind, num(r.n)]));
  const byKind = [
    ...LEARNING_KINDS.map((k) => ({ key: k as string, n: kinds.get(k) ?? 0 })),
    ...kindRows.filter((r) => !(LEARNING_KINDS as readonly string[]).includes(r.kind)).map((r) => ({ key: r.kind, n: num(r.n) })),
  ];

  // tags is a JSON array of strings; an unreadable value counts as untagged instead of failing the page.
  const teamList = TEAM_TAGS.map((t) => `'${t}'`).join(", ");
  const safeTags = "json_each(CASE WHEN json_valid(l.tags) THEN l.tags ELSE '[]' END)";
  const teamRows = db
    .prepare(
      `SELECT lower(j.value) AS tag, COUNT(DISTINCT l.id) AS n
       FROM learnings l, ${safeTags} j
       WHERE l.status IN ${LIVE} AND j.type = 'text' AND lower(j.value) IN (${teamList})
       GROUP BY tag ORDER BY n DESC, tag`,
    )
    .all() as Array<{ tag: string; n: number }>;
  const noTeam = db
    .prepare(
      `SELECT COUNT(*) AS n FROM learnings l
       WHERE l.status IN ${LIVE}
         AND NOT EXISTS (SELECT 1 FROM ${safeTags} j WHERE j.type = 'text' AND lower(j.value) IN (${teamList}))`,
    )
    .get() as { n: number };

  const rows = db
    .prepare(
      `SELECT id, source, created_at, author_id FROM learnings
       WHERE status IN ${LIVE} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(STANDING_SAMPLE_MAX) as Array<{ id: string; source: "native" | "confluence"; created_at: string; author_id: string }>;
  const standing: Record<StandingLevel, number> = { strong: 0, fair: 0, weak: 0 };
  // standingsFor puts every id in one IN (...): keep each call small.
  for (let i = 0; i < rows.length; i += 500) {
    for (const s of standingsFor(rows.slice(i, i + 500)).values()) standing[s.standing]++;
  }

  return {
    byKind,
    byTeam: teamRows.map((r) => ({ key: r.tag, n: num(r.n) })),
    noTeamTag: num(noTeam.n),
    standing,
    standingRead: rows.length,
  };
}

/** The memories with the most helpful, kudos and confirm reactions in the last MONTH_DAYS days. */
export function topHelpful(now: Date, limit = 5): HelpfulItem[] {
  const since = sqlTime(new Date(now.getTime() - MONTH_DAYS * DAY_MS));
  const rows = getDb()
    .prepare(
      `SELECT l.id AS id, l.title AS title, l.kind AS kind,
              SUM(a.action = 'helpful') AS helpful, SUM(a.action = 'kudos') AS kudos,
              SUM(a.action = 'confirm') AS confirm, COUNT(*) AS total, MAX(a.at) AS last
       FROM audit_log a JOIN learnings l ON l.id = a.entity_id
       WHERE a.action IN ${HELPFUL_ACTIONS} AND a.at >= ? AND +a.entity = 'learning' AND l.status != 'deleted'
       GROUP BY l.id ORDER BY total DESC, last DESC LIMIT ?`,
    )
    .all(since, limit) as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    kind: String(r.kind),
    helpful: num(r.helpful as number),
    kudos: num(r.kudos as number),
    confirm: num(r.confirm as number),
    total: num(r.total as number),
  }));
}

/** Memories saved since USAGE_COLLECTING_SINCE (not deleted) by the model their author named. */
export function modelsUsed(): Count[] {
  const rows = getDb()
    .prepare(
      `SELECT COALESCE(trim(model), '') AS model, COUNT(*) AS n FROM learnings
       WHERE status IN ('active', 'archived') AND created_at >= ?
       GROUP BY 1 ORDER BY n DESC, model`,
    )
    .all(sqlDate(USAGE_COLLECTING_SINCE)) as Array<{ model: string; n: number }>;
  const named = rows.filter((r) => r.model !== "");
  const notStated = rows.find((r) => r.model === "");
  const shown = named.slice(0, MODELS_SHOWN).map((r) => ({ key: r.model, n: num(r.n) }));
  const other = named.slice(MODELS_SHOWN).reduce((n, r) => n + num(r.n), 0);
  if (other > 0) shown.push({ key: "other", n: other });
  if (notStated) shown.push({ key: "", n: num(notStated.n) });
  return shown;
}

export function upkeep(now: Date): Upkeep {
  const db = getDb();
  // The same rule as the sweep (lib/maintenance.ts sweepInactive), only with a shorter window, so
  // the tile shows what is about to be archived: the clock is the last agent read, else the day it
  // was saved, and never starts before INACTIVITY_CLOCK_START.
  const quiet = db
    .prepare(
      `SELECT COUNT(*) AS n FROM learnings
       WHERE status = 'active' AND kind IN ('learning', 'practice') AND pinned = 0
         AND max(COALESCE(last_accessed_at, created_at), ?) < ?`,
    )
    .get(INACTIVITY_CLOCK_START, sqlTime(new Date(now.getTime() - QUIET_DAYS * DAY_MS))) as { n: number };
  const since = sqlTime(new Date(now.getTime() - MONTH_DAYS * DAY_MS));
  const archivedUnread = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_log
       WHERE action = 'auto-archive' AND at >= ? AND +entity = 'learning' AND json_extract(details, '$.reason') = 'inactive'`,
    )
    .get(since) as { n: number };
  const acts = db
    .prepare(
      `SELECT action, COUNT(*) AS n FROM audit_log
       WHERE action IN ('keep', 'restored', 'retire') AND at >= ? AND +entity = 'learning' GROUP BY action`,
    )
    .all(since) as Array<{ action: string; n: number }>;
  const n = (a: string) => num(acts.find((r) => r.action === a)?.n);
  return {
    quiet: num(quiet.n),
    archivedUnread: num(archivedUnread.n),
    kept: n("keep"),
    restored: n("restored"),
    retired: n("retire"),
  };
}

/* -------------------------------------------------------------------- health */

export function captureByWeek(weeks: string[]): CaptureWeek[] {
  const db = getDb();
  const since = sqlDate(weeks[0]);
  const calls = db
    .prepare(
      `SELECT ${weekSql("at")} AS week, COUNT(*) AS calls,
              COUNT(DISTINCT json_extract(details, '$.cx')) AS sessions,
              COUNT(DISTINCT actor_id) AS people
       FROM audit_log WHERE path = ? AND at >= ? GROUP BY week`,
    )
    .all(LEARN_PATH, since) as Array<{ week: string; calls: number; sessions: number; people: number }>;
  const nudges = db
    .prepare(
      `SELECT ${weekSql("n.at")} AS week, COUNT(*) AS issued,
              SUM(EXISTS (SELECT 1 FROM audit_log a
                          WHERE a.actor_id = n.actor_id AND a.path = ?
                            AND a.at >= n.at AND a.at <= datetime(n.at, '+${NUDGE_FOLLOW_MINUTES} minutes'))) AS followed
       FROM audit_log n WHERE n.action = 'stop_nudge' AND n.at >= ? GROUP BY week`,
    )
    .all(LEARN_PATH, since) as Array<{ week: string; issued: number; followed: number }>;
  return weeks.map((week) => {
    const c = calls.find((r) => r.week === week);
    const n = nudges.find((r) => r.week === week);
    return {
      week,
      label: isoWeekLabel(week),
      learnCalls: c?.calls ?? 0,
      sessions: c?.sessions ?? 0,
      people: c?.people ?? 0,
      nudges: n?.issued ?? 0,
      followed: n?.followed ?? 0,
    };
  });
}

export function identifyByWeek(weeks: string[]): IdentifyWeek[] {
  const rows = getDb()
    .prepare(
      `SELECT ${weekSql("at")} AS week,
              SUM(action = 'identify') AS identifies,
              SUM(action = 'identify' AND json_extract(details, '$.source') = 'none') AS none,
              SUM(action = 'identify_refused') AS refused
       FROM audit_log WHERE action IN ('identify', 'identify_refused') AND at >= ? GROUP BY week`,
    )
    .all(sqlDate(weeks[0])) as Array<{ week: string; identifies: number; none: number; refused: number }>;
  return weeks.map((week) => {
    const r = rows.find((x) => x.week === week);
    return { week, label: isoWeekLabel(week), identifies: r?.identifies ?? 0, none: r?.none ?? 0, refused: r?.refused ?? 0 };
  });
}

/** Days on which one device, connection or address called bab_identify more than the threshold, newest first. */
export function identifyLoops(weeks: string[], limit = 50): IdentifyLoop[] {
  const rows = getDb()
    .prepare(
      `SELECT date(at) AS day,
              COALESCE(json_extract(details, '$.cx'), 'd:' || json_extract(details, '$.deviceId'), 'a:' || json_extract(details, '$.ip'), '-') AS who,
              MAX(actor_email) AS email, COUNT(*) AS calls
       FROM audit_log WHERE action = 'identify' AND at >= ?
       GROUP BY day, who HAVING COUNT(*) > ? ORDER BY day DESC, calls DESC LIMIT ?`,
    )
    .all(sqlDate(weeks[0]), IDENTIFY_LOOP_THRESHOLD, limit) as Array<{ day: string; who: string; email: string | null; calls: number }>;
  return rows.map((r) => {
    const by = r.who.startsWith("d:") ? "device" : r.who.startsWith("c:") ? "connection" : "address";
    // Shown by the person it identified as: a maintainer needs a name to ask, not an id.
    return { day: r.day, by, who: r.email ?? r.who, calls: r.calls };
  });
}

export function refusalsByReason(weeks: string[]): Array<{ reason: string; n: number }> {
  return getDb()
    .prepare(
      `SELECT COALESCE(json_extract(details, '$.reason'), 'unknown') AS reason, COUNT(*) AS n
       FROM audit_log WHERE action = 'identify_refused' AND at >= ? GROUP BY reason ORDER BY n DESC`,
    )
    .all(sqlDate(weeks[0])) as Array<{ reason: string; n: number }>;
}

/** bab_learn writes against the duplicate guard: stored vs refused with a 409. Only learnings count (feedback and reminders audit the same actions). */
export function qualityByWeek(weeks: string[]): QualityWeek[] {
  const rows = getDb()
    .prepare(
      `SELECT ${weekSql("at")} AS week, SUM(action = 'create' AND entity = 'learning') AS created,
              SUM(action = 'create_rejected_duplicate' AND entity = 'learning') AS dup
       FROM audit_log WHERE action IN ('create', 'create_rejected_duplicate') AND at >= ? GROUP BY week`,
    )
    .all(sqlDate(weeks[0])) as Array<{ week: string; created: number; dup: number }>;
  return weeks.map((week) => {
    const r = rows.find((x) => x.week === week);
    return { week, label: isoWeekLabel(week), created: r?.created ?? 0, duplicateRejected: r?.dup ?? 0 };
  });
}

/** Distinct authors per team tag, by the week a learning was created (any status but deleted). */
export function authorsPerTeamByWeek(weeks: string[]): TeamWeek[] {
  const rows = getDb()
    .prepare(
      `SELECT author_id, tags, ${weekSql("created_at")} AS week
       FROM learnings WHERE created_at >= ? AND status != 'deleted'`,
    )
    .all(sqlDate(weeks[0])) as Array<{ author_id: string; tags: string; week: string }>;
  const known = new Set<string>(TEAM_TAGS);
  return weeks.map((week) => {
    const authors = new Map<string, Set<string>>();
    const noTeam = new Set<string>();
    for (const r of rows) {
      if (r.week !== week) continue;
      let tags: string[] = [];
      try {
        tags = (JSON.parse(r.tags) as string[]).map((t) => String(t).toLowerCase());
      } catch {
        // an unreadable tags value counts as untagged
      }
      const teams = tags.filter((t) => known.has(t));
      if (teams.length === 0) noTeam.add(r.author_id);
      for (const t of teams) {
        if (!authors.has(t)) authors.set(t, new Set());
        authors.get(t)!.add(r.author_id);
      }
    }
    const byTeam: Record<string, number> = {};
    for (const [t, set] of authors) byTeam[t] = set.size;
    return { week, label: isoWeekLabel(week), byTeam, noTeamTag: noTeam.size };
  });
}

/**
 * The clean-up per week (swarm garbage collection and the unread sweep): six counts from audit_log,
 * one query on idx_audit_action_at. Weeks before an action was first recorded read 0, like the other
 * audit numbers (`auto-archive` started with agent reads, `downvote_archived` with this card).
 */
export function cleanupByWeek(weeks: string[]): CleanupWeek[] {
  const rows = getDb()
    .prepare(
      `SELECT ${weekSql("at")} AS week,
              SUM(action = 'auto-archive' AND json_extract(details, '$.reason') = 'inactive') AS inactive,
              SUM(action = 'downvote_archived') AS downvoted,
              SUM(action = 'auto_archive') AS flagged,
              SUM(action = 'retire') AS retired,
              SUM(action IN ('keep', 'restored')) AS kept,
              SUM(action = 'confirm' AND json_extract(details, '$.verified') = 1) AS verified
       FROM audit_log
       WHERE action IN ('auto-archive', 'downvote_archived', 'auto_archive', 'retire', 'keep', 'restored', 'confirm')
         AND at >= ? AND +entity = 'learning'
       GROUP BY week`,
    )
    .all(sqlDate(weeks[0])) as Array<Record<string, number | string | null>>;
  return weeks.map((week) => {
    const r = rows.find((x) => x.week === week);
    const n = (key: string) => num((r?.[key] ?? 0) as number);
    return {
      week,
      label: isoWeekLabel(week),
      inactive: n("inactive"),
      downvoted: n("downvoted"),
      flagged: n("flagged"),
      retired: n("retired"),
      kept: n("kept"),
      verified: n("verified"),
    };
  });
}

/**
 * The flagged standards and decisions, and the protected memories marked not helpful, that a
 * maintainer still has to decide (flaggedStandardsWaitingIds), newest first. "Flaggers" counts the
 * people who flagged or marked it not helpful.
 */
export function flaggedWaiting(): FlaggedItem[] {
  const ids = flaggedStandardsWaitingIds();
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT l.id AS id, l.title AS title, l.kind AS kind, l.author_id AS authorId,
              MAX(v.created_at) AS flaggedAt, COUNT(DISTINCT lower(v.voter_id)) AS flaggers
       FROM learnings l JOIN votes v ON v.learning_id = l.id AND v.kind IN ('flag', 'not_helpful')
       WHERE l.id IN (${marks}) GROUP BY l.id`,
    )
    .all(...ids) as unknown as FlaggedItem[];
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/** The oldest audit row's time. Rows are append-only, so the first rowid is the oldest (no scan). */
export function auditDataSince(): string | null {
  const r = getDb().prepare("SELECT at FROM audit_log ORDER BY rowid LIMIT 1").get() as { at: string } | undefined;
  return r?.at ?? null;
}

/* -------------------------------------------------------------------- report */

export function usageReport(now: Date = new Date()): UsageReport {
  const weeks = lastWeeks(now);
  const activity = activityByWeek(weeks);
  return {
    dataSince: auditDataSince(),
    generatedAt: now.toISOString(),
    weeks,
    activity,
    totals: activityTotals(activity),
    growth: growth(now),
    contents: contents(),
    topHelpful: topHelpful(now),
    topProjects: topProjects(5),
    generalCount: generalProjectCount(),
    models: modelsUsed(),
    upkeep: upkeep(now),
    capture: captureByWeek(weeks),
    identify: identifyByWeek(weeks),
    identifyLoops: identifyLoops(weeks),
    refusalsByReason: refusalsByReason(weeks),
    quality: qualityByWeek(weeks),
    teams: authorsPerTeamByWeek(weeks),
    cleanup: cleanupByWeek(weeks),
    flagged: flaggedWaiting(),
  };
}

// One report for everyone, for USAGE_CACHE_MS. Tied to the connection it was read from, so a test
// that swaps the database (or a reopened connection) never sees another database's numbers.
let cached: { db: DatabaseSync; at: number; report: UsageReport } | null = null;

/** usageReport(), computed at most once per USAGE_CACHE_MS for everyone who opens /usage. */
export function cachedUsageReport(now: Date = new Date()): UsageReport {
  const db = getDb();
  const age = cached ? now.getTime() - cached.at : Infinity;
  if (cached && cached.db === db && age >= 0 && age < USAGE_CACHE_MS) return cached.report;
  const report = usageReport(now);
  cached = { db, at: now.getTime(), report };
  return report;
}

/** Test-only: forget the cached report. */
export function _resetUsageCacheForTests(): void {
  cached = null;
}
