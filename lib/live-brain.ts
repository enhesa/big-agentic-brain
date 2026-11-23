import { getDb } from "@/lib/db";
import { parseDbTime } from "@/lib/dates";

/**
 * What the Live Brain page (/live) draws: how many people's agents used BAB in the last day and
 * what was done (docs/spec.md "Live Brain page").
 *
 * Read from the audit log, so the picture shows what happened and not a demo. Nothing here says
 * who did what: the snapshot holds counts, and a beat holds its kind, its time and, for a memory
 * that is live, that memory's title and id. No actor id, and no key made from one, leaves this
 * file. A memory page names its author and its voters, so anything that tied a beat to a person's
 * dot would name that dot, and with it that person's searches and messages. The page draws the
 * dots as seats and picks one per beat by lot (lib/live-picture.ts).
 */

/** How far back the page looks, in hours. */
export const LIVE_WINDOW_HOURS = 24;
/** Most dots drawn. With more people than this, the page says how many there are. */
export const LIVE_DOTS_MAX = 24;
/** Most beats sent to the page, newest last. */
export const LIVE_BEATS_MAX = 40;
/** One snapshot serves every open page for this long. */
export const LIVE_CACHE_MS = 2000;
/** A person counts as at work right now when their agents did something this recently, in minutes. */
export const LIVE_AWAKE_MINUTES = 15;

const SEARCH_TOOL_PATH = "/mcp#tools/call:bab_search";
const SEARCH_API_PATH = "/api/learnings";
/** Audit actor ids that are not a person (same list as lib/usage.ts). */
const NOT_PEOPLE = "('anonymous', 'system')";
const REUSE_ACTIONS = ["helpful", "kudos", "confirm"];

export type BeatKind = "save" | "search" | "reuse" | "message" | "flag";
export const BEAT_KINDS: BeatKind[] = ["save", "search", "reuse", "message", "flag"];

export interface LiveBeat {
  /** The audit row's id. Rises with time, so the page knows which beats are new. */
  id: number;
  at: string;
  kind: BeatKind;
  /** A save, reuse or flag only, and only while the memory is live. */
  memory: { id: string; title: string } | null;
}

export interface LiveBrain {
  /** People whose agents did one of the five things in the window. */
  agents: number;
  /** Of those, the people whose agents did one in the last LIVE_AWAKE_MINUTES. */
  awake: number;
  /** Live memories right now. */
  memories: number;
  /** How often each thing happened in the window. */
  counts: Record<BeatKind, number>;
  beats: LiveBeat[];
  /** The start of the window, ISO. */
  since: string;
}

function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function kindOf(row: { action: string; entity: string }): BeatKind {
  if (row.entity === "message") return "message";
  if (row.entity === "request") return "search";
  if (row.action === "create") return "save";
  if (row.action === "flag") return "flag";
  return "reuse";
}

/**
 * The rows that count as a beat: a memory saved, reused (helpful, kudos, confirm) or flagged, a
 * message sent, and a search (the bab_search tool or a GET on /api/learnings, as on /usage).
 *
 * The window is read as a range of row ids. Ids rise with time, so the lowest id in the window
 * bounds it, and every read walks only the rows after it. NOT INDEXED keeps it that way: left to
 * choose, the planner reads every audit row a memory ever got, or the whole table. The time is
 * still checked per row, for a row written out of order.
 */
const BEAT_FROM = `FROM audit_log a NOT INDEXED WHERE a.id >= ? AND a.at >= ? AND a.actor_id NOT IN ${NOT_PEOPLE} AND (
    (a.entity = 'learning' AND a.action IN ('create', 'flag', ${REUSE_ACTIONS.map((a) => `'${a}'`).join(", ")}))
    OR (a.entity = 'message' AND a.action = 'send')
    OR (a.entity = 'request' AND a.path IN ('${SEARCH_TOOL_PATH}', '${SEARCH_API_PATH}') AND (a.path = '${SEARCH_TOOL_PATH}' OR a.action = 'GET'))
  )`;

/**
 * The lowest id in the window, read from the index over `at` alone. The index is named: a bare
 * MIN(id) makes the planner walk the table by id from its first row until one is in the window,
 * which is every row before the window.
 */
const FIRST_SQL = "SELECT MIN(id) AS id FROM audit_log INDEXED BY idx_audit_at WHERE at >= ?";
const PEOPLE_SQL = `SELECT COUNT(DISTINCT a.actor_id) AS agents, COUNT(DISTINCT CASE WHEN a.at >= ? THEN a.actor_id END) AS awake ${BEAT_FROM}`;
const TALLY_SQL = `SELECT a.action AS action, a.entity AS entity, COUNT(*) AS n ${BEAT_FROM} GROUP BY a.action, a.entity`;
const BEATS_SQL = `SELECT a.id, a.at, a.action, a.entity, a.entity_id ${BEAT_FROM} ORDER BY a.id DESC LIMIT ?`;

interface BeatRow {
  id: number | bigint;
  at: string;
  action: string;
  entity: string;
  entity_id: string;
}

export function liveBrain(now: Date = new Date()): LiveBrain {
  const db = getDb();
  const since = new Date(now.getTime() - LIVE_WINDOW_HOURS * 3_600_000);
  const counts: Record<BeatKind, number> = { save: 0, search: 0, reuse: 0, message: 0, flag: 0 };
  const memories = Number((db.prepare("SELECT COUNT(*) AS n FROM learnings WHERE status = 'active'").get() as { n: number | bigint }).n);

  const fromTime = sqlTime(since);
  const first = db.prepare(FIRST_SQL).get(fromTime) as { id: number | bigint | null };
  if (first.id === null) return { agents: 0, awake: 0, memories, counts, beats: [], since: since.toISOString() };
  const from = Number(first.id);

  const awakeFrom = sqlTime(new Date(now.getTime() - LIVE_AWAKE_MINUTES * 60_000));
  const people = db.prepare(PEOPLE_SQL).get(awakeFrom, from, fromTime) as { agents: number | bigint; awake: number | bigint };

  const tally = db.prepare(TALLY_SQL).all(from, fromTime) as Array<{ action: string; entity: string; n: number | bigint }>;
  for (const t of tally) counts[kindOf(t)] += Number(t.n);

  const rows = (db.prepare(BEATS_SQL).all(from, fromTime, LIVE_BEATS_MAX) as unknown as BeatRow[]).reverse();

  const memoryIds = [...new Set(rows.filter((r) => r.entity === "learning").map((r) => r.entity_id))];
  const titles = new Map<string, string>();
  if (memoryIds.length > 0) {
    const found = db
      .prepare(`SELECT id, title FROM learnings WHERE status = 'active' AND id IN (${memoryIds.map(() => "?").join(", ")})`)
      .all(...memoryIds) as Array<{ id: string; title: string }>;
    for (const m of found) titles.set(m.id, m.title);
  }

  const beats = rows.map((r): LiveBeat => {
    const title = r.entity === "learning" ? titles.get(r.entity_id) : undefined;
    return {
      id: Number(r.id),
      at: parseDbTime(r.at).toISOString(),
      kind: kindOf(r),
      memory: title !== undefined ? { id: r.entity_id, title } : null,
    };
  });

  return { agents: Number(people.agents), awake: Number(people.awake), memories, counts, beats, since: since.toISOString() };
}

let cached: { at: number; value: LiveBrain } | null = null;

/** The snapshot, at most LIVE_CACHE_MS old: many open pages cost one read. */
export function cachedLiveBrain(now: Date = new Date()): LiveBrain {
  if (cached && now.getTime() - cached.at >= 0 && now.getTime() - cached.at < LIVE_CACHE_MS) return cached.value;
  const value = liveBrain(now);
  cached = { at: now.getTime(), value };
  return value;
}

/** Test-only: how the database reads each of the page's queries, so a test can pin that none walks the whole table. */
export function _livePlansForTests(): Record<"first" | "people" | "tally" | "beats", string[]> {
  const db = getDb();
  const plan = (sql: string, ...args: Array<string | number>) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail);
  return {
    first: plan(FIRST_SQL, ""),
    people: plan(PEOPLE_SQL, "", 0, ""),
    tally: plan(TALLY_SQL, 0, ""),
    beats: plan(BEATS_SQL, 0, "", 1),
  };
}

/** Test-only: forgets the snapshot. */
export function _resetLiveBrainForTests(): void {
  cached = null;
}
