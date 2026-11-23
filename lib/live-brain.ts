import { createHmac, randomBytes } from "node:crypto";
import { getDb } from "@/lib/db";
import { parseDbTime } from "@/lib/dates";

/**
 * What the Live Brain page (/live) draws: who used BAB in the last day and what they did, as
 * anonymous dots and beats (docs/spec.md "Live Brain page").
 *
 * Read from the audit log, so the picture shows what happened and not a demo. It names nobody:
 * a dot carries a key that is a keyed hash of the person's id, made with a secret that lives only
 * in this process. The key is the same for one person until the app restarts, so a dot keeps its
 * place, and it cannot be turned back into a person. A beat carries a memory's title and id only
 * while that memory is live, and never a search text or anything from a message.
 */

/** How far back the page looks, in hours. */
export const LIVE_WINDOW_HOURS = 24;
/** Most dots drawn. With more people than this, the ones active most recently are drawn. */
export const LIVE_DOTS_MAX = 24;
/** Most beats sent to the page, newest last. */
export const LIVE_BEATS_MAX = 40;
/** One snapshot serves every open page for this long. */
export const LIVE_CACHE_MS = 2000;

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
  /** The dot that did it, or null when that person is not among the dots drawn. */
  agent: string | null;
  /** A message only: the dot it was sent to, or null when that person has no dot. */
  to: string | null;
  /** A save, reuse or flag only, and only while the memory is live. */
  memory: { id: string; title: string } | null;
}

export interface LiveBrain {
  /** People who did one of the five things in the window. */
  agents: number;
  /** The keys of the dots to draw, in a fixed order. */
  dots: string[];
  /** Live memories right now. */
  memories: number;
  /** How often each thing happened in the window. */
  counts: Record<BeatKind, number>;
  beats: LiveBeat[];
  /** The start of the window, ISO. */
  since: string;
}

let secret = randomBytes(32);

function dotKey(actorId: string): string {
  return createHmac("sha256", secret).update(actorId).digest("hex").slice(0, 12);
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
 */
const BEAT_WHERE = `a.at >= ? AND a.actor_id NOT IN ${NOT_PEOPLE} AND (
    (a.entity = 'learning' AND a.action IN ('create', 'flag', ${REUSE_ACTIONS.map((a) => `'${a}'`).join(", ")}))
    OR (a.entity = 'message' AND a.action = 'send')
    OR (a.entity = 'request' AND a.path IN ('${SEARCH_TOOL_PATH}', '${SEARCH_API_PATH}') AND (a.path = '${SEARCH_TOOL_PATH}' OR a.action = 'GET'))
  )`;

interface BeatRow {
  id: number | bigint;
  at: string;
  actor_id: string;
  action: string;
  entity: string;
  entity_id: string;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

export function liveBrain(now: Date = new Date()): LiveBrain {
  const db = getDb();
  const since = new Date(now.getTime() - LIVE_WINDOW_HOURS * 3_600_000);
  const from = sqlTime(since);

  // Everyone active in the window, most recent first. The first LIVE_DOTS_MAX get a dot.
  const people = db
    .prepare(`SELECT a.actor_id AS actor, MAX(a.id) AS last FROM audit_log a WHERE ${BEAT_WHERE} GROUP BY a.actor_id ORDER BY last DESC`)
    .all(from) as Array<{ actor: string }>;
  const keyByActor = new Map<string, string>();
  for (const p of people.slice(0, LIVE_DOTS_MAX)) keyByActor.set(p.actor, dotKey(p.actor));
  // Sorted by key: a dot's neighbours stay the same when someone joins or leaves.
  const dots = [...keyByActor.values()].sort();

  const counts: Record<BeatKind, number> = { save: 0, search: 0, reuse: 0, message: 0, flag: 0 };
  const tally = db
    .prepare(`SELECT a.action AS action, a.entity AS entity, COUNT(*) AS n FROM audit_log a WHERE ${BEAT_WHERE} GROUP BY a.action, a.entity`)
    .all(from) as Array<{ action: string; entity: string; n: number | bigint }>;
  for (const t of tally) counts[kindOf(t)] += Number(t.n);

  const rows = (
    db
      .prepare(`SELECT a.id, a.at, a.actor_id, a.action, a.entity, a.entity_id FROM audit_log a WHERE ${BEAT_WHERE} ORDER BY a.id DESC LIMIT ?`)
      .all(from, LIVE_BEATS_MAX) as unknown as BeatRow[]
  ).reverse();

  const memoryIds = [...new Set(rows.filter((r) => r.entity === "learning").map((r) => r.entity_id))];
  const titles = new Map<string, string>();
  if (memoryIds.length > 0) {
    const found = db
      .prepare(`SELECT id, title FROM learnings WHERE status = 'active' AND id IN (${placeholders(memoryIds.length)})`)
      .all(...memoryIds) as Array<{ id: string; title: string }>;
    for (const m of found) titles.set(m.id, m.title);
  }

  const messageIds = rows.filter((r) => r.entity === "message").map((r) => r.entity_id);
  const recipients = new Map<string, string>();
  if (messageIds.length > 0) {
    const found = db
      .prepare(`SELECT id, to_id FROM messages WHERE id IN (${placeholders(messageIds.length)})`)
      .all(...messageIds) as Array<{ id: string; to_id: string | null }>;
    for (const m of found) if (m.to_id) recipients.set(m.id, m.to_id);
  }

  const beats = rows.map((r): LiveBeat => {
    const kind = kindOf(r);
    const title = r.entity === "learning" ? titles.get(r.entity_id) : undefined;
    const to = kind === "message" ? recipients.get(r.entity_id) : undefined;
    return {
      id: Number(r.id),
      at: parseDbTime(r.at).toISOString(),
      kind,
      agent: keyByActor.get(r.actor_id) ?? null,
      to: to ? (keyByActor.get(to) ?? null) : null,
      memory: title !== undefined ? { id: r.entity_id, title } : null,
    };
  });

  const memories = db.prepare("SELECT COUNT(*) AS n FROM learnings WHERE status = 'active'").get() as { n: number | bigint };

  return { agents: people.length, dots, memories: Number(memories.n), counts, beats, since: since.toISOString() };
}

let cached: { at: number; value: LiveBrain } | null = null;

/** The snapshot, at most LIVE_CACHE_MS old: many open pages cost one read. */
export function cachedLiveBrain(now: Date = new Date()): LiveBrain {
  if (cached && now.getTime() - cached.at >= 0 && now.getTime() - cached.at < LIVE_CACHE_MS) return cached.value;
  const value = liveBrain(now);
  cached = { at: now.getTime(), value };
  return value;
}

/** Test-only: forgets the snapshot and makes a new secret, as a restart would. */
export function _resetLiveBrainForTests(): void {
  cached = null;
  secret = randomBytes(32);
}
