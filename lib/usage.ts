import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { flaggedStandardsWaitingIds, INACTIVITY_CLOCK_START, LEARNING_KINDS, standingsFor } from "./learnings";
import { generalProjectCount, topProjects } from "./stats";
import { teamTags } from "./teams";
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
/** The day search audit rows started to carry their result count (details.results) and redacted query (details.q). */
export const SEARCH_RESULTS_SINCE = "2026-10-27";
/** How many zero-result queries the maintainer list shows. */
export const ZERO_QUERIES_SHOWN = 10;
/** A memory younger than this has not had a fair chance to be used yet. */
export const UNUSED_MIN_AGE_DAYS = 14;
/**
 * The day the plugin started to measure agent effort (lib/effort-cost.ts): the discovery cost on a
 * save and the reuse cost on a helpful or kudos reaction. "Agent time saved" counts reuses from it.
 */
export const MEASURED_SAVINGS_SINCE = "2026-10-27";
/** "This month" on the page: the last 30 days. */
export const MONTH_DAYS = 30;

/** The page's window for everything that is not a weekly series: the same 12 months (52 weeks). */
export const WINDOW_DAYS = USAGE_WEEKS * 7;
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
/** Reactions that say a memory helped the agent that used it (a confirm only says it is still true). */
const USED_ACTIONS = "('helpful', 'kudos')";
/** A search "helped" when the same person marks a memory helpful within this many minutes after it. */
export const HELPED_WINDOW_MINUTES = 30;
/** Audit actor ids that are not a person. */
const NOT_PEOPLE = "('anonymous', 'system')";
const LIVE = "('active')";
const DAY_MS = 86_400_000;

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
  /**
   * Searches followed, within HELPED_WINDOW_MINUTES, by a helpful or kudos reaction from the same
   * person. Each reaction credits only the last search before it, so rephrasing the same question
   * does not count twice. A lower bound: agents do not always react.
   */
  helpedSearches: number;
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
  /** In the last WINDOW_DAYS days: memories the sweep archived because no agent read them for a year. */
  archivedUnread: number;
  /** In the last WINDOW_DAYS days. */
  kept: number;
  restored: number;
  retired: number;
  /** Comments posted on memories in the last WINDOW_DAYS days, removed ones too (from the table: the audit log is kept 180 days). */
  comments: number;
}

/** One week of the Clean-up card (swarm garbage collection, docs/spec.md), from audit_log. */
/** "Found nothing": searches recorded with a result count (since SEARCH_RESULTS_SINCE) in the window. */
export interface SearchOutcomes {
  /** The first day with a recorded count in the window (YYYY-MM-DD), or null when there is none yet. */
  since: string | null;
  /** Searches with a recorded result count. */
  recorded: number;
  /** Of those, the ones that found nothing. */
  zero: number;
  /**
   * The most repeated zero-result queries (lowercased, redacted when stored), most recent first on a
   * tie, at most ZERO_QUERIES_SHOWN. Maintainers only: the page never shows these to anyone else.
   */
  zeroQueries: Array<{ query: string; n: number; last: string }>;
}

/** Live learnings and practices older than UNUSED_MIN_AGE_DAYS that nobody else has used. */
export interface Unused {
  /** No agent read (reads start at INACTIVITY_CLOCK_START) and no reaction from anyone but the author. */
  unused: number;
  /** Live, unpinned learnings and practices older than UNUSED_MIN_AGE_DAYS. */
  eligible: number;
}

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

export interface MessageWeek {
  week: string;
  label: string;
  /** Messages agents sent for their people (`send` on a message). */
  messages: number;
  /** Distinct threads with a message that week. */
  conversations: number;
  /** Distinct people who sent one. */
  senders: number;
}

export interface ReminderWeek {
  week: string;
  label: string;
  /** `create` on a todo. */
  created: number;
  /** `complete`. */
  done: number;
  /** `snooze`. */
  snoozed: number;
  /** `abandon`. */
  dropped: number;
}

export interface UsageReport {
  weeks: string[];
  activity: ActivityWeek[];
  /** The hero tiles: saves, searches and reactions summed over the window; people are distinct, not a sum of weekly counts. */
  totals: ActivityCounts;
  growth: Growth;
  /** Memories saved in the window (by created_at) that are still live: the saved tile's "still in BAB". */
  savedStillLive: number;
  contents: Contents;
  topHelpful: HelpfulItem[];
  topProjects: Array<{ project: string; n: number }>;
  /** Live memories with no project (the "General" bucket on /memory). */
  generalCount: number;
  /** Memories saved since USAGE_COLLECTING_SINCE by the model their author named; "" is not stated. */
  models: Count[];
  upkeep: Upkeep;
  unused: Unused;
  searchOutcomes: SearchOutcomes;
  measured: MeasuredSavings;
  capture: CaptureWeek[];
  identify: IdentifyWeek[];
  identifyLoops: IdentifyLoop[];
  refusalsByReason: Array<{ reason: string; n: number }>;
  quality: QualityWeek[];
  teams: TeamWeek[];
  cleanup: CleanupWeek[];
  messages: MessageWeek[];
  reminders: ReminderWeek[];
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
      c = { saves: 0, searches: 0, reactions: 0, helpedSearches: 0, people: 0, newPeople: 0 };
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
  // For each helpful or kudos reaction, the same person's last search in the window before it
  // (idx_audit_actor_at), counted once per search, in the week of the search. Not a click on the
  // memory page (via 'ui'): it follows no search in an agent session, so it says nothing about
  // whether a search helped.
  const helped = db
    .prepare(
      `WITH hits AS (
         SELECT (SELECT s.id FROM audit_log s
                 WHERE s.actor_id = h.actor_id AND s.at <= h.at AND s.at >= datetime(h.at, '-${HELPED_WINDOW_MINUTES} minutes')
                   AND s.path IN (?, ?) AND (s.path = ? OR s.action = 'GET')
                 ORDER BY s.at DESC, s.id DESC LIMIT 1) AS sid
         FROM audit_log h
         WHERE h.action IN ${USED_ACTIONS} AND h.at >= ? AND h.at < ? AND +h.entity = 'learning' AND h.via != 'ui' AND h.actor_id NOT IN ${NOT_PEOPLE}
       )
       SELECT ${weekSql("s.at")} AS week, COUNT(DISTINCT s.id) AS n
       FROM hits JOIN audit_log s ON s.id = hits.sid
       GROUP BY week`,
    )
    .all(SEARCH_TOOL_PATH, SEARCH_API_PATH, SEARCH_TOOL_PATH, from, to) as Array<{ week: string; n: number }>;
  for (const r of helped) slot(r.week).helpedSearches = num(r.n);
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
    ...(rows.get(week) ?? { saves: 0, searches: 0, reactions: 0, helpedSearches: 0, people: 0, newPeople: 0 }),
  }));
}

/** The window's totals for the hero tiles: the weekly counts added up, and the distinct people (each counted once). */
export function activityTotals(activity: ActivityWeek[]): ActivityCounts {
  const sum = (key: "saves" | "searches" | "reactions" | "helpedSearches" | "newPeople") => activity.reduce((n, w) => n + w[key], 0);
  return {
    saves: sum("saves"),
    searches: sum("searches"),
    reactions: sum("reactions"),
    helpedSearches: sum("helpedSearches"),
    people: sum("newPeople"),
  };
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
  const teams = teamTags();
  const teamList = teams.map(() => "?").join(", ");
  const safeTags = "json_each(CASE WHEN json_valid(l.tags) THEN l.tags ELSE '[]' END)";
  const teamRows = db
    .prepare(
      `SELECT lower(j.value) AS tag, COUNT(DISTINCT l.id) AS n
       FROM learnings l, ${safeTags} j
       WHERE l.status IN ${LIVE} AND j.type = 'text' AND lower(j.value) IN (${teamList})
       GROUP BY tag ORDER BY n DESC, tag`,
    )
    .all(...teams) as Array<{ tag: string; n: number }>;
  const noTeam = db
    .prepare(
      `SELECT COUNT(*) AS n FROM learnings l
       WHERE l.status IN ${LIVE}
         AND NOT EXISTS (SELECT 1 FROM ${safeTags} j WHERE j.type = 'text' AND lower(j.value) IN (${teamList}))`,
    )
    .get(...teams) as { n: number };

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

/** The memories with the most helpful, kudos and confirm reactions in the last WINDOW_DAYS days. */
export function topHelpful(now: Date, limit = 5): HelpfulItem[] {
  const since = sqlTime(new Date(now.getTime() - WINDOW_DAYS * DAY_MS));
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
  const since = sqlTime(new Date(now.getTime() - WINDOW_DAYS * DAY_MS));
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
  const comments = db
    .prepare("SELECT COUNT(*) AS n FROM memory_comments WHERE created_at >= ?")
    .get(since) as { n: number };
  return {
    quiet: num(quiet.n),
    archivedUnread: num(archivedUnread.n),
    kept: n("keep"),
    restored: n("restored"),
    retired: n("retire"),
    comments: num(comments.n),
  };
}

/**
 * Live learnings and practices older than UNUSED_MIN_AGE_DAYS that no agent has read and nobody but
 * the author has reacted to. A read does not say who read it (touchRead keeps only a date), so the
 * author's own reads count too; reads are recorded since INACTIVITY_CLOCK_START. Pinned house rules
 * are left out: the digest that serves them is not counted as a read.
 */
export function unusedMemories(now: Date): Unused {
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS eligible,
              SUM(l.last_accessed_at IS NULL AND NOT EXISTS (
                SELECT 1 FROM votes v
                WHERE v.learning_id = l.id AND v.kind IN ${HELPFUL_ACTIONS} AND lower(v.voter_id) != lower(l.author_id)
              )) AS unused
       FROM learnings l
       WHERE l.status = 'active' AND l.kind IN ('learning', 'practice') AND l.pinned = 0 AND l.created_at < ? AND l.created_at >= ?`,
    )
    // Reads are recorded only since INACTIVITY_CLOCK_START: an older memory may have been read before
    // then without a trace, so only memories saved since are judged.
    .get(sqlTime(new Date(now.getTime() - UNUSED_MIN_AGE_DAYS * DAY_MS)), INACTIVITY_CLOCK_START) as { eligible: number; unused: number | null };
  return { unused: num(r.unused), eligible: num(r.eligible) };
}

/**
 * The share of searches that found nothing, from the result count each search writes on its own
 * audit row (lib/request-audit.ts recordSearchOutcome). Two queries on idx_audit_path_at, bounded by
 * the window and SEARCH_RESULTS_SINCE.
 */
export function searchOutcomes(weeks: string[]): SearchOutcomes {
  const db = getDb();
  const from = sqlDate(weeks[0] > SEARCH_RESULTS_SINCE ? weeks[0] : SEARCH_RESULTS_SINCE);
  const where = `path IN (?, ?) AND at >= ? AND (path = ? OR action = 'GET') AND json_extract(details, '$.results') IS NOT NULL`;
  const args = [SEARCH_TOOL_PATH, SEARCH_API_PATH, from, SEARCH_TOOL_PATH];
  const share = db
    .prepare(`SELECT COUNT(*) AS recorded, SUM(json_extract(details, '$.results') = 0) AS zero, MIN(at) AS first FROM audit_log WHERE ${where}`)
    .get(...args) as { recorded: number; zero: number | null; first: string | null };
  const zeroQueries = db
    .prepare(
      `SELECT lower(json_extract(details, '$.q')) AS query, COUNT(*) AS n, MAX(at) AS last
       FROM audit_log WHERE ${where} AND json_extract(details, '$.results') = 0 AND json_extract(details, '$.q') != ''
       GROUP BY query ORDER BY n DESC, last DESC LIMIT ?`,
    )
    .all(...args, ZERO_QUERIES_SHOWN) as Array<{ query: string; n: number; last: string }>;
  return {
    since: share.first ? share.first.slice(0, 10) : null,
    recorded: num(share.recorded),
    zero: num(share.zero),
    zeroQueries: zeroQueries.map((q) => ({ query: String(q.query), n: num(q.n), last: q.last })),
  };
}

/** "Agent time saved" and "Tokens saved" on /usage (docs/savings.md, "Measured savings"). */
export interface MeasuredSavings {
  /** The first day counted: MEASURED_SAVINGS_SINCE, or the window's first Monday once that is later. */
  since: string;
  /** Reuses since then: one per person and memory with a helpful or kudos reaction. */
  reuses: number;
  /** Of those, the ones with both a measured discovery cost and a measured reuse cost: the only ones counted. */
  measured: number;
  /** Reuses of a memory saved without a measured discovery cost (an older memory, another client, an old plugin). */
  noDiscovery: number;
  /** Reuses of a measured memory whose reaction carried no reuse cost (not surfaced by a search in that session, another client, or a click on the memory page). */
  noReuse: number;
  /** Summed over measured reuses: discovery minus reuse, each floored at 0. */
  savedMs: number;
  savedTokens: number;
}

/** One helpful or kudos reaction with the measured costs on both sides, null where none was measured. */
export interface ReuseRow {
  learningId: string;
  voterId: string;
  at: string;
  discoveryMs: number | null;
  discoveryTokens: number | null;
  reuseMs: number | null;
  reuseTokens: number | null;
}

/**
 * The measured savings, from reaction rows. One reuse per person and memory (helpful and kudos from
 * the same person on the same memory are one reuse), measured by its earliest reaction that carries a
 * reuse cost. Saved per reuse = discovery cost minus reuse cost, floored at 0, time and tokens apart.
 * Counted only when both sides are measured; the rest are counted as excluded, by reason.
 */
export function measuredSavingsFrom(rows: ReuseRow[], since: string): MeasuredSavings {
  const pairs = new Map<string, ReuseRow[]>();
  for (const r of rows) {
    const key = `${r.learningId} ${r.voterId.toLowerCase()}`;
    pairs.set(key, [...(pairs.get(key) ?? []), r]);
  }
  const out: MeasuredSavings = { since, reuses: pairs.size, measured: 0, noDiscovery: 0, noReuse: 0, savedMs: 0, savedTokens: 0 };
  for (const group of pairs.values()) {
    const first = group[0];
    if (first.discoveryMs === null || first.discoveryTokens === null) {
      out.noDiscovery++;
      continue;
    }
    const reuse = group
      .filter((r) => r.reuseMs !== null && r.reuseTokens !== null)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0];
    if (!reuse) {
      out.noReuse++;
      continue;
    }
    out.measured++;
    out.savedMs += Math.max(0, first.discoveryMs - (reuse.reuseMs ?? 0));
    out.savedTokens += Math.max(0, first.discoveryTokens - (reuse.reuseTokens ?? 0));
  }
  return out;
}

/**
 * Helpful and kudos reactions by people since MEASURED_SAVINGS_SINCE (or the window start), with
 * the memory's discovery cost and the reaction's reuse cost. Bounded by votes.created_at.
 */
export function measuredSavings(weeks: string[]): MeasuredSavings {
  const since = weeks[0] > MEASURED_SAVINGS_SINCE ? weeks[0] : MEASURED_SAVINGS_SINCE;
  const rows = getDb()
    .prepare(
      `SELECT v.learning_id AS learningId, v.voter_id AS voterId, v.created_at AS at,
              lc.active_ms AS discoveryMs, lc.tokens AS discoveryTokens,
              rc.active_ms AS reuseMs, rc.tokens AS reuseTokens
       FROM votes v
       LEFT JOIN learning_costs lc ON lc.learning_id = v.learning_id
       LEFT JOIN reuse_costs rc ON rc.learning_id = v.learning_id AND rc.voter_id = v.voter_id AND rc.kind = v.kind
       WHERE v.kind IN ${USED_ACTIONS} AND v.created_at >= ? AND v.voter_id NOT IN ${NOT_PEOPLE}`,
    )
    .all(sqlDate(since)) as Array<Record<string, string | number | null>>;
  const n = (v: string | number | null) => (v === null ? null : Number(v));
  return measuredSavingsFrom(
    rows.map((r) => ({
      learningId: String(r.learningId),
      voterId: String(r.voterId),
      at: String(r.at),
      discoveryMs: n(r.discoveryMs),
      discoveryTokens: n(r.discoveryTokens),
      reuseMs: n(r.reuseMs),
      reuseTokens: n(r.reuseTokens),
    })),
    since,
  );
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
  const known = new Set<string>(teamTags());
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
 * Agent-to-agent messages per week: one query on idx_audit_action_at (`send` on a message), joined to
 * messages by primary key for the thread. A message deleted since still counts as sent, without a
 * thread. Counts only, never a subject or body.
 */
export function messagesByWeek(weeks: string[]): MessageWeek[] {
  const rows = getDb()
    .prepare(
      `SELECT ${weekSql("a.at")} AS week, COUNT(*) AS messages,
              COUNT(DISTINCT m.thread_id) AS conversations, COUNT(DISTINCT a.actor_id) AS senders
       FROM audit_log a LEFT JOIN messages m ON m.id = a.entity_id
       WHERE a.action = 'send' AND a.at >= ? AND +a.entity = 'message'
       GROUP BY week`,
    )
    .all(sqlDate(weeks[0])) as Array<{ week: string; messages: number; conversations: number; senders: number }>;
  return weeks.map((week) => {
    const r = rows.find((x) => x.week === week);
    return {
      week,
      label: isoWeekLabel(week),
      messages: num(r?.messages),
      conversations: num(r?.conversations),
      senders: num(r?.senders),
    };
  });
}

/**
 * Reminders per week: created, done, snoozed and dropped, one query on idx_audit_action_at. Totals
 * only: reminders are private, so the page never says whose they are or what they say.
 */
export function remindersByWeek(weeks: string[]): ReminderWeek[] {
  const rows = getDb()
    .prepare(
      `SELECT ${weekSql("at")} AS week,
              SUM(action = 'create') AS created, SUM(action = 'complete') AS done,
              SUM(action = 'snooze') AS snoozed, SUM(action = 'abandon') AS dropped
       FROM audit_log
       WHERE action IN ('create', 'complete', 'snooze', 'abandon') AND at >= ? AND +entity = 'todo'
       GROUP BY week`,
    )
    .all(sqlDate(weeks[0])) as Array<{ week: string; created: number; done: number; snoozed: number; dropped: number }>;
  return weeks.map((week) => {
    const r = rows.find((x) => x.week === week);
    return {
      week,
      label: isoWeekLabel(week),
      created: num(r?.created),
      done: num(r?.done),
      snoozed: num(r?.snoozed),
      dropped: num(r?.dropped),
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
    savedStillLive: num(
      (
        getDb()
          .prepare(`SELECT COUNT(*) AS n FROM learnings WHERE status IN ${LIVE} AND created_at >= ?`)
          .get(sqlDate(weeks[0])) as { n: number }
      ).n,
    ),
    contents: contents(),
    topHelpful: topHelpful(now),
    topProjects: topProjects(5),
    generalCount: generalProjectCount(),
    models: modelsUsed(),
    upkeep: upkeep(now),
    unused: unusedMemories(now),
    searchOutcomes: searchOutcomes(weeks),
    measured: measuredSavings(weeks),
    capture: captureByWeek(weeks),
    identify: identifyByWeek(weeks),
    identifyLoops: identifyLoops(weeks),
    refusalsByReason: refusalsByReason(weeks),
    quality: qualityByWeek(weeks),
    teams: authorsPerTeamByWeek(weeks),
    cleanup: cleanupByWeek(weeks),
    messages: messagesByWeek(weeks),
    reminders: remindersByWeek(weeks),
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
