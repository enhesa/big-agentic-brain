import { getDb } from "@/lib/db";
import { parseDbTime } from "@/lib/dates";
import { LEARNING_KINDS } from "@/lib/learnings";

/**
 * What the Replay on the Live Brain page (/live) draws: the whole history of the brain, from the
 * first memory to now, as plain numbers (docs/spec.md "Live Brain page", Replay).
 *
 * It holds no person and nothing a person wrote. A memory is a number in a list: the hour it was
 * saved, the hour it left, its kind and which project group it is in. There is no id, no title, no
 * project name and no tag text. A reuse or a flag is a memory's number and a day. A search and a
 * message are a count per day, with nobody beside them. So the replay shows how the brain grew and
 * says nothing about who grew it.
 *
 * Searches are counted from the audit log, which the upkeep keeps for a year: a search older than
 * that is not in the count.
 */

/** One replay serves everyone for this long: the history changes slowly and the read is the big one. */
export const REPLAY_CACHE_MS = 10 * 60_000;
/** Most memories drawn. With more, the newest are drawn. */
export const REPLAY_NEURONS_MAX = 60_000;
/** Most reuses and flags sent, the newest. */
export const REPLAY_FIRES_MAX = 150_000;
/** Most project groups. Smaller projects share the last group. */
export const REPLAY_CLUSTERS_MAX = 48;
/** A memory is joined to the memory before it under each of its first tags, up to this many. */
export const REPLAY_TAG_LINKS = 2;
/** One viewer, or one address, may ask for the replay this often a minute. The page asks once a press. */
export const REPLAY_LIMIT_PER_MINUTE = 30;
/** All callers without a verified address share this many asks a minute. */
export const REPLAY_UNKNOWN_LIMIT_PER_MINUTE = 120;

/** Audit actor ids that are not a person (same list as lib/usage.ts and lib/live-brain.ts). */
const NOT_PEOPLE = "('anonymous', 'system')";
const SEARCH_TOOL_PATH = "/mcp#tools/call:bab_search";
const SEARCH_API_PATH = "/api/learnings";
const REUSE_KINDS = ["helpful", "kudos", "confirm"];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const LINK_TAG = 0;
export const LINK_SUPERSEDES = 1;
export const FIRE_REUSE = 0;
export const FIRE_FLAG = 1;

export interface BrainReplay {
  v: 1;
  /** The hour the first memory was saved, ISO. Every hour below counts from here. */
  start: string;
  /** Hours from the start to now, at least 1. */
  hours: number;
  /** Project groups, the biggest first. A memory names its group by number. */
  clusters: number;
  /** One entry per memory in each list, oldest memory first. */
  neurons: {
    cluster: number[];
    /** The hour it was saved. */
    born: number[];
    /** The hour it stopped being live, or -1 while it is live. */
    gone: number[];
    /** Its kind, as a place in LEARNING_KINDS. */
    kind: number[];
  };
  /** Threads between memories, three numbers each: the older memory, the newer one, LINK_TAG or LINK_SUPERSEDES. */
  links: number[];
  /**
   * Reuses and flags, three numbers each: the memory, the hour, FIRE_REUSE or FIRE_FLAG. Oldest
   * first. The hour is the start of the day it happened, or the hour the memory was saved if that
   * is later: the day is enough to draw it, and the hour of one reaction is nobody's business.
   */
  fires: number[];
  /** Counts per day, the first day being the day of the start (UTC). */
  days: { search: number[]; message: number[] };
  totals: { memories: number; live: number; reuses: number; flags: number; searches: number; messages: number };
}

function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function tagsOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()) : [];
  } catch {
    return [];
  }
}

interface MemoryRow {
  id: string;
  project: string | null;
  kind: string;
  status: string;
  tags: string;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
}

export function brainReplay(now: Date = new Date()): BrainReplay {
  const db = getDb();
  // A deleted memory is gone for good, so it is not drawn. The newest are kept when there are too many.
  const rows = (
    db
      .prepare(
        `SELECT id, project, kind, status, tags, supersedes_id, created_at, updated_at FROM learnings
         WHERE status != 'deleted' ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(REPLAY_NEURONS_MAX) as unknown as MemoryRow[]
  ).reverse();

  const totals = { memories: rows.length, live: 0, reuses: 0, flags: 0, searches: 0, messages: 0 };
  if (rows.length === 0) {
    return {
      v: 1,
      start: new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS).toISOString(),
      hours: 1,
      clusters: 0,
      neurons: { cluster: [], born: [], gone: [], kind: [] },
      links: [],
      fires: [],
      days: { search: [], message: [] },
      totals,
    };
  }

  const startMs = Math.floor(parseDbTime(rows[0].created_at).getTime() / HOUR_MS) * HOUR_MS;
  const nowMs = Math.max(now.getTime(), startMs + HOUR_MS);
  const hours = Math.ceil((nowMs - startMs) / HOUR_MS);
  const hourOf = (at: string) => Math.min(hours, Math.max(0, Math.floor((parseDbTime(at).getTime() - startMs) / HOUR_MS)));

  // Project groups, the biggest first. Memories without a project are one group like any other.
  const sizes = new Map<string, number>();
  for (const r of rows) sizes.set(r.project ?? "", (sizes.get(r.project ?? "") ?? 0) + 1);
  const ranked = [...sizes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([project]) => project);
  const clusters = Math.min(ranked.length, REPLAY_CLUSTERS_MAX);
  const clusterOf = new Map<string, number>(ranked.map((project, i) => [project, Math.min(i, clusters - 1)]));

  const index = new Map<string, number>();
  const neurons: BrainReplay["neurons"] = { cluster: [], born: [], gone: [], kind: [] };
  const links: number[] = [];
  const lastWithTag = new Map<string, number>();
  rows.forEach((r, i) => {
    index.set(r.id, i);
    neurons.cluster.push(clusterOf.get(r.project ?? "")!);
    neurons.born.push(hourOf(r.created_at));
    const live = r.status === "active";
    if (live) totals.live += 1;
    neurons.gone.push(live ? -1 : Math.max(hourOf(r.updated_at), hourOf(r.created_at)));
    neurons.kind.push(Math.max(0, (LEARNING_KINDS as readonly string[]).indexOf(r.kind)));
    for (const tag of tagsOf(r.tags).slice(0, REPLAY_TAG_LINKS)) {
      const before = lastWithTag.get(tag);
      if (before !== undefined) links.push(before, i, LINK_TAG);
      lastWithTag.set(tag, i);
    }
  });
  rows.forEach((r, i) => {
    const old = r.supersedes_id ? index.get(r.supersedes_id) : undefined;
    if (old !== undefined && old !== i) links.push(Math.min(old, i), Math.max(old, i), LINK_SUPERSEDES);
  });

  const votes = (
    db
      .prepare(
        `SELECT learning_id, kind, created_at FROM votes
         WHERE kind IN ('flag', ${REUSE_KINDS.map((k) => `'${k}'`).join(", ")}) AND voter_id NOT IN ${NOT_PEOPLE}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(REPLAY_FIRES_MAX) as Array<{ learning_id: string; kind: string; created_at: string }>
  ).reverse();
  const fires: number[] = [];
  for (const v of votes) {
    const neuron = index.get(v.learning_id);
    if (neuron === undefined) continue;
    const flag = v.kind === "flag";
    if (flag) totals.flags += 1;
    else totals.reuses += 1;
    fires.push(neuron, Math.max(Math.floor(hourOf(v.created_at) / 24) * 24, neurons.born[neuron]), flag ? FIRE_FLAG : FIRE_REUSE);
  }

  // Searches and messages: a count per day and nothing else.
  const startDayMs = Math.floor(startMs / DAY_MS) * DAY_MS;
  const dayCount = Math.ceil((nowMs - startDayMs) / DAY_MS);
  const days = { search: new Array<number>(dayCount).fill(0), message: new Array<number>(dayCount).fill(0) };
  const from = sqlTime(new Date(startMs));
  const add = (into: number[], perDay: Array<{ day: string; n: number | bigint }>): number => {
    let sum = 0;
    for (const d of perDay) {
      const at = Math.floor((Date.parse(`${d.day}T00:00:00Z`) - startDayMs) / DAY_MS);
      if (at < 0 || at >= dayCount) continue;
      into[at] += Number(d.n);
      sum += Number(d.n);
    }
    return sum;
  };
  type PerDay = Array<{ day: string; n: number | bigint }>;
  totals.searches += add(
    days.search,
    db
      .prepare(`SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM audit_log WHERE path = ? AND at >= ? AND entity = 'request' AND actor_id NOT IN ${NOT_PEOPLE} GROUP BY day`)
      .all(SEARCH_TOOL_PATH, from) as PerDay,
  );
  totals.searches += add(
    days.search,
    db
      .prepare(
        `SELECT substr(at, 1, 10) AS day, COUNT(*) AS n FROM audit_log WHERE path = ? AND at >= ? AND entity = 'request' AND action = 'GET' AND actor_id NOT IN ${NOT_PEOPLE} GROUP BY day`,
      )
      .all(SEARCH_API_PATH, from) as PerDay,
  );
  totals.messages += add(
    days.message,
    db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM messages WHERE created_at >= ? AND from_id NOT IN ${NOT_PEOPLE} GROUP BY day`).all(from) as PerDay,
  );

  return { v: 1, start: new Date(startMs).toISOString(), hours, clusters, neurons, links, fires, days, totals };
}

let cached: { at: number; value: BrainReplay; json: string } | null = null;

function fresh(now: Date): { at: number; value: BrainReplay; json: string } {
  if (cached && now.getTime() - cached.at >= 0 && now.getTime() - cached.at < REPLAY_CACHE_MS) return cached;
  const value = brainReplay(now);
  cached = { at: now.getTime(), value, json: JSON.stringify(value) };
  return cached;
}

/** The replay, at most REPLAY_CACHE_MS old: many viewers cost one read of the history. */
export function cachedBrainReplay(now: Date = new Date()): BrainReplay {
  return fresh(now).value;
}

/** The same replay as JSON text, written once per read: a big answer is not written again per caller. */
export function cachedBrainReplayJson(now: Date = new Date()): string {
  return fresh(now).json;
}

/** Test-only: forgets the cached replay. */
export function _resetBrainReplayForTests(): void {
  cached = null;
}
