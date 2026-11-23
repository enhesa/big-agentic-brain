import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrainReplay } from "../lib/live-replay";

/**
 * The Replay on the Live Brain page (/live): the history read as plain numbers
 * (lib/live-replay.ts), the address the page asks (/live/replay), the brain worked out from those
 * numbers (lib/replay-scene.ts) and the button on the page. The replay must show how the brain
 * grew and say nothing about who grew it.
 */

let dataDir: string;
const ANN = "ann.a@example.com";
const BOB = "bob.b@example.com";
const CAT = "cat.c@example.com";
const SEARCH_TOOL = "/mcp#tools/call:bab_search";
/** The first memory is saved at 10:20 on the first day, so the replay starts at 10:00. */
const START = Date.parse("2026-06-01T10:00:00Z");
const NOW = new Date("2026-06-11T12:30:00Z");

const sql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
/** A time `hours` after the start of the replay. */
const at = (hours: number) => sql(START + hours * 3_600_000);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-replay-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/rate-limit");
  vi.doUnmock("@/lib/notify-auth");
  vi.doUnmock("@/app/components/shell/Shell");
  vi.resetModules();
});

async function person(id: string) {
  const { getDb } = await import("../lib/db");
  getDb().prepare("INSERT OR IGNORE INTO users (id, email, name, roles) VALUES (?, ?, ?, '[]')").run(id, id, id.split("@")[0]);
}

interface Mem {
  project?: string | null;
  kind?: string;
  status?: string;
  tags?: string;
  supersedes?: string | null;
  /** Hours after the start. */
  saved: number;
  changed?: number;
}

async function memory(id: string, m: Mem) {
  await person(ANN);
  const { getDb } = await import("../lib/db");
  getDb()
    .prepare(
      "INSERT INTO learnings (id, author_id, title, body, tags, project, kind, status, supersedes_id, created_at, updated_at) VALUES (?, ?, ?, 'Body text.', ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, ANN, `Title of ${id}`, m.tags ?? "[]", m.project ?? null, m.kind ?? "learning", m.status ?? "active", m.supersedes ?? null, at(m.saved), at(m.changed ?? m.saved));
}

async function vote(learningId: string, voter: string, kind: string, hours: number) {
  await person(voter);
  const { getDb } = await import("../lib/db");
  getDb().prepare("INSERT INTO votes (learning_id, voter_id, kind, created_at) VALUES (?, ?, ?, ?)").run(learningId, voter, kind, at(hours));
}

async function request(actor: string, action: string, hours: number, reqPath: string) {
  const { getDb } = await import("../lib/db");
  getDb().prepare("INSERT INTO audit_log (actor_id, action, entity, entity_id, via, at, path) VALUES (?, ?, 'request', 'x', 'mcp', ?, ?)").run(actor, action, at(hours), reqPath);
}

async function message(id: string, from: string, hours: number) {
  await person(from);
  await person(CAT);
  const { getDb } = await import("../lib/db");
  getDb().prepare("INSERT OR IGNORE INTO threads (id, subject, created_by) VALUES ('thread-1', 'Subject line', ?)").run(CAT);
  getDb().prepare("INSERT INTO messages (id, thread_id, from_id, to_id, body, created_at) VALUES (?, 'thread-1', ?, ?, 'Message body.', ?)").run(id, from, CAT, at(hours));
}

/** A small history with one of everything, and beside each thing one that must be left out. */
async function history() {
  await memory("mem-a", { project: "alpha", tags: '["Deploy","db"]', saved: 0.34 });
  await memory("mem-b", { project: "alpha", kind: "standard", tags: '["deploy"]', saved: 24.4 });
  await memory("mem-c", { project: "beta", kind: "practice", status: "archived", tags: '["deploy","db","third"]', supersedes: "mem-a", saved: 48.4, changed: 96.4 });
  await memory("mem-d", { status: "deleted", saved: 50 });
  await memory("mem-e", { kind: "decision", tags: "not json", saved: 73 });

  await vote("mem-a", BOB, "helpful", 26);
  // A flag dated before its memory still fires no earlier than the memory was saved.
  await vote("mem-b", CAT, "flag", -1);
  await person("anonymous");
  await vote("mem-a", "anonymous", "kudos", 30);
  await vote("mem-a", CAT, "keep", 31);
  await vote("mem-d", BOB, "confirm", 60);

  await request(BOB, "POST", 1, SEARCH_TOOL);
  await request(BOB, "POST", 50, SEARCH_TOOL);
  await request(CAT, "POST", 51, SEARCH_TOOL);
  await request(BOB, "GET", 52, "/api/learnings");
  await request(BOB, "POST", 52, "/api/learnings");
  await request("anonymous", "POST", 52, SEARCH_TOOL);
  await request(BOB, "POST", -1, SEARCH_TOOL);
  await request(BOB, "GET", 52, "/memory");

  await message("msg-1", BOB, 30);
  await person("system");
  await message("msg-2", "system", 30);
}

describe("brainReplay", () => {
  it("reads the whole history as numbers, oldest memory first", async () => {
    await history();
    const { brainReplay, LINK_TAG, LINK_SUPERSEDES, FIRE_REUSE, FIRE_FLAG } = await import("../lib/live-replay");
    const { LEARNING_KINDS } = await import("../lib/learnings");
    const replay = brainReplay(NOW);

    expect(replay.v).toBe(1);
    expect(replay.start).toBe("2026-06-01T10:00:00.000Z");
    expect(replay.hours).toBe(243);
    // Groups by size, the biggest first: alpha (2), then no project and beta (1 each).
    expect(replay.clusters).toBe(3);
    expect(replay.neurons.cluster).toEqual([0, 0, 2, 1]);
    expect(replay.neurons.born).toEqual([0, 24, 48, 73]);
    // The archived memory left when it was last changed. The others are live.
    expect(replay.neurons.gone).toEqual([-1, -1, 96, -1]);
    expect(replay.neurons.kind).toEqual(["learning", "standard", "practice", "decision"].map((k) => (LEARNING_KINDS as readonly string[]).indexOf(k)));
    // A thread to the memory before it under each of its first two tags, whatever the case, then
    // the thread to the memory it replaced. A third tag joins nothing.
    expect(replay.links).toEqual([0, 1, LINK_TAG, 1, 2, LINK_TAG, 0, 2, LINK_TAG, 0, 2, LINK_SUPERSEDES]);
    // A reuse is sent by its day, not its hour: 26 hours in is the second day, which starts at 24.
    expect(replay.fires).toEqual([1, 24, FIRE_FLAG, 0, 24, FIRE_REUSE]);
    expect(replay.days.search).toEqual([1, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(replay.days.message).toEqual([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(replay.totals).toEqual({ memories: 4, live: 3, reuses: 1, flags: 1, searches: 4, messages: 1 });
  });

  it("holds no person and nothing a person wrote", async () => {
    await history();
    const { brainReplay } = await import("../lib/live-replay");
    const replay = brainReplay(NOW);
    const text = JSON.stringify(replay);
    for (const secret of [ANN, BOB, CAT, "ann.a", "bob.b", "mem-a", "mem-c", "Title of", "Body text", "alpha", "beta", "deploy", "Deploy", "third", "Subject line", "Message body", "thread-1", "msg-1"]) {
      expect(text).not.toContain(secret);
    }
    // Every value is a number, but for the hour the replay starts.
    const strings: string[] = [];
    JSON.parse(text, (_key, value) => {
      if (typeof value === "string") strings.push(value);
      return value;
    });
    expect(strings).toEqual([replay.start]);
  });

  it("answers an empty replay for an empty brain", async () => {
    await memory("mem-d", { status: "deleted", saved: 0 });
    const { brainReplay } = await import("../lib/live-replay");
    const replay = brainReplay(NOW);
    expect(replay.start).toBe("2026-06-11T12:00:00.000Z");
    expect(replay.hours).toBe(1);
    expect(replay.clusters).toBe(0);
    expect(replay.neurons).toEqual({ cluster: [], born: [], gone: [], kind: [] });
    expect(replay.links).toEqual([]);
    expect(replay.fires).toEqual([]);
    expect(replay.days).toEqual({ search: [], message: [] });
    expect(replay.totals).toEqual({ memories: 0, live: 0, reuses: 0, flags: 0, searches: 0, messages: 0 });
  });

  it("lasts an hour at least, and puts the smallest projects in one last group", async () => {
    const { brainReplay, REPLAY_CLUSTERS_MAX } = await import("../lib/live-replay");
    await memory("big-1", { project: "big", saved: 0 });
    await memory("big-2", { project: "big", saved: 0 });
    for (let p = 0; p < REPLAY_CLUSTERS_MAX + 2; p++) await memory(`small-${p}`, { project: `p${String(p).padStart(2, "0")}`, saved: 0 });
    // Asked before the first memory was saved: the replay still has a length.
    const replay = brainReplay(new Date(START - 5 * 3_600_000));
    expect(replay.hours).toBe(1);
    expect(replay.clusters).toBe(REPLAY_CLUSTERS_MAX);
    expect(Math.max(...replay.neurons.cluster)).toBe(REPLAY_CLUSTERS_MAX - 1);
    expect(replay.neurons.cluster.filter((c) => c === 0)).toHaveLength(2);
    expect(replay.neurons.cluster.filter((c) => c === REPLAY_CLUSTERS_MAX - 1)).toHaveLength(4);
  });

  it("serves one replay to everyone until it is REPLAY_CACHE_MS old", async () => {
    await memory("mem-a", { saved: 0 });
    const { cachedBrainReplay, REPLAY_CACHE_MS, _resetBrainReplayForTests } = await import("../lib/live-replay");
    const first = cachedBrainReplay(NOW);
    await memory("mem-b", { saved: 1 });
    expect(cachedBrainReplay(new Date(NOW.getTime() + REPLAY_CACHE_MS - 1))).toBe(first);
    const later = cachedBrainReplay(new Date(NOW.getTime() + REPLAY_CACHE_MS));
    expect(later).not.toBe(first);
    expect(later.totals.memories).toBe(2);
    await memory("mem-c", { saved: 2 });
    _resetBrainReplayForTests();
    expect(cachedBrainReplay(new Date(NOW.getTime() + REPLAY_CACHE_MS)).totals.memories).toBe(3);
  });

  it("writes the answer as text once, and hands the same text to every caller", async () => {
    await memory("mem-a", { saved: 0 });
    const { cachedBrainReplay, cachedBrainReplayJson } = await import("../lib/live-replay");
    const text = cachedBrainReplayJson(NOW);
    expect(JSON.parse(text)).toEqual(cachedBrainReplay(NOW));
    await memory("mem-b", { saved: 1 });
    expect(cachedBrainReplayJson(new Date(NOW.getTime() + 1000))).toBe(text);
  });
});

describe("GET /live/replay", () => {
  it("answers the replay as JSON, never cached, and writes no audit row", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    await history();
    const { getDb } = await import("../lib/db");
    const rows = () => Number((getDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n);
    const before = rows();

    const { GET } = await import("../app/live/replay/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as BrainReplay;
    expect(body.v).toBe(1);
    expect(body.totals.memories).toBe(4);
    expect(body.neurons.born).toHaveLength(4);
    expect(rows()).toBe(before);
  });

  it("limits callers with no verified address together, and answers 429 past the limit", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    await memory("mem-a", { saved: 0 });
    const { REPLAY_UNKNOWN_LIMIT_PER_MINUTE } = await import("../lib/live-replay");
    const { GET } = await import("../app/live/replay/route");
    for (let k = 0; k < REPLAY_UNKNOWN_LIMIT_PER_MINUTE; k++) expect((await GET()).status).toBe(200);
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("gives each signed-in viewer a small bucket of their own", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    let who = ANN;
    vi.doMock("@/lib/notify-auth", () => ({ NO_STORE: { "Cache-Control": "no-store" }, getViewer: async () => ({ ownerId: who }) }));
    await memory("mem-a", { saved: 0 });
    const { REPLAY_LIMIT_PER_MINUTE } = await import("../lib/live-replay");
    const { GET } = await import("../app/live/replay/route");
    for (let k = 0; k < REPLAY_LIMIT_PER_MINUTE; k++) expect((await GET()).status).toBe(200);
    expect((await GET()).status).toBe(429);
    // Another viewer is not held back by the first.
    who = BOB;
    expect((await GET()).status).toBe(200);
  });

  it("gives each verified address a small bucket of its own", async () => {
    let from = "192.0.2.10";
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.doMock("@/lib/client-ip", () => ({ clientIpVerified: () => true, clientIp: () => from }));
    await memory("mem-a", { saved: 0 });
    const { REPLAY_LIMIT_PER_MINUTE } = await import("../lib/live-replay");
    const { GET } = await import("../app/live/replay/route");
    for (let k = 0; k < REPLAY_LIMIT_PER_MINUTE; k++) expect((await GET()).status).toBe(200);
    expect((await GET()).status).toBe(429);
    from = "192.0.2.11";
    expect((await GET()).status).toBe(200);
    vi.doUnmock("@/lib/client-ip");
  });
});

/** A made-up history of `n` memories in `clusters` groups over 100 days, by rule. */
function madeUp(n: number, clusters: number, over: Partial<BrainReplay> = {}): BrainReplay {
  const hours = 2400;
  const neurons: BrainReplay["neurons"] = { cluster: [], born: [], gone: [], kind: [] };
  for (let i = 0; i < n; i++) {
    // Group 0 is the biggest, as the server sends it.
    neurons.cluster.push(i % 3 === 0 ? 0 : i % clusters);
    neurons.born.push(Math.floor((i / n) * (hours - 10)));
    neurons.gone.push(i % 11 === 5 ? Math.min(hours, neurons.born[i] + 200) : -1);
    neurons.kind.push(i % 4);
  }
  const links: number[] = [];
  for (let i = 7; i < n; i += 7) links.push(i - 7, i, i % 2);
  const fires: number[] = [];
  for (let i = 0; i < n; i += 3) fires.push(i, Math.min(hours, neurons.born[i] + 30), i % 9 === 0 ? 1 : 0);
  const days = { search: new Array<number>(100).fill(0).map((_, d): number => d % 5), message: new Array<number>(100).fill(0).map((_, d): number => (d % 4 === 0 ? 2 : 0)) };
  const reuses = fires.filter((_, k) => k % 3 === 2 && fires[k] === 0).length;
  return {
    v: 1,
    start: "2026-01-01T07:00:00.000Z",
    hours,
    clusters,
    neurons,
    links,
    fires,
    days,
    totals: {
      memories: n,
      live: neurons.gone.filter((g) => g < 0).length,
      reuses,
      flags: fires.length / 3 - reuses,
      searches: days.search.reduce((a, b) => a + b, 0),
      messages: days.message.reduce((a, b) => a + b, 0),
    },
    ...over,
  };
}

describe("buildReplayScene", () => {
  it("gives the same brain for the same history", async () => {
    const { buildReplayScene } = await import("../lib/replay-scene");
    const a = buildReplayScene(madeUp(600, 5));
    const b = buildReplayScene(madeUp(600, 5));
    expect(Array.from(a.neurons.position)).toEqual(Array.from(b.neurons.position));
    expect(Array.from(a.links.position)).toEqual(Array.from(b.links.position));
    expect(Array.from(a.pulses.start)).toEqual(Array.from(b.pulses.start));
    expect(Array.from(a.neurons.color)).toEqual(Array.from(b.neurons.color));
  });

  it("puts every memory inside the brain, each in its own place, lit in the order it was saved", async () => {
    const { buildReplayScene, REPLAY_SECONDS, REPLAY_TAIL_SECONDS, NEVER } = await import("../lib/replay-scene");
    const replay = madeUp(600, 5);
    const scene = buildReplayScene(replay);
    expect(scene.duration).toBe(REPLAY_SECONDS);
    expect(scene.neurons.count).toBe(600);
    expect(scene.neurons.position).toHaveLength(1800);
    const places = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const [x, y, z] = scene.neurons.position.subarray(i * 3, i * 3 + 3);
      expect(Number.isFinite(x + y + z)).toBe(true);
      expect(Math.abs(x)).toBeLessThan(1);
      expect(Math.abs(y)).toBeLessThan(0.9);
      expect(Math.abs(z)).toBeLessThan(1.2);
      places.add(`${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`);
      expect(scene.neurons.born[i]).toBeGreaterThanOrEqual(0);
      expect(scene.neurons.born[i]).toBeLessThanOrEqual(REPLAY_SECONDS - REPLAY_TAIL_SECONDS);
      if (i > 0) expect(scene.neurons.born[i]).toBeGreaterThanOrEqual(scene.neurons.born[i - 1]);
      // It leaves after it came, or never.
      if (replay.neurons.gone[i] < 0) expect(scene.neurons.gone[i]).toBe(NEVER);
      else {
        expect(scene.neurons.gone[i]).toBeGreaterThanOrEqual(scene.neurons.born[i]);
        expect(scene.neurons.gone[i]).toBeLessThanOrEqual(REPLAY_SECONDS);
      }
      expect(scene.neurons.seed[i]).toBeGreaterThanOrEqual(0);
      expect(scene.neurons.seed[i]).toBeLessThan(1);
    }
    expect(places.size).toBe(600);
    // The first memory is there from the start. The last lands just before the tail, so it has
    // come to rest when the replay ends.
    expect(scene.neurons.born[0]).toBe(0);
    expect(scene.neurons.born[599]).toBeCloseTo(REPLAY_SECONDS - REPLAY_TAIL_SECONDS, 0);
  });

  it("draws a reused memory hot and bigger, and a flag as a spark only", async () => {
    const { buildReplayScene, NEVER } = await import("../lib/replay-scene");
    const replay = madeUp(60, 3, { fires: [4, 500, 0, 4, 600, 0, 5, 500, 1, -1, 5, 0, 99, 5, 0], links: [] });
    const plain = buildReplayScene({ ...replay, fires: [] });
    const scene = buildReplayScene(replay);
    expect(scene.neurons.hot[4]).toBeLessThan(NEVER);
    expect(scene.neurons.hot[4]).toBeGreaterThanOrEqual(scene.neurons.born[4]);
    expect(scene.neurons.size[4]).toBeGreaterThan(plain.neurons.size[4]);
    expect(scene.neurons.hot[5]).toBe(NEVER);
    expect(scene.neurons.size[5]).toBe(plain.neurons.size[5]);
    // Three sparks more than without: two reuses and the flag. Fires on no known memory are dropped.
    expect(scene.pulses.count - plain.pulses.count).toBe(3);
    expect(scene.countsAt(scene.duration).reuses).toBe(2);
    // A standard or a decision is drawn bigger than a learning.
    expect(plain.neurons.size[3]).toBeGreaterThan(plain.neurons.size[0]);
  });

  it("joins each memory to earlier ones, and the threads grow after both ends are lit", async () => {
    const { buildReplayScene, LINK_GROW_SECONDS } = await import("../lib/replay-scene");
    const replay = madeUp(600, 5);
    const none = buildReplayScene({ ...replay, links: [] });
    const scene = buildReplayScene(replay);
    // Every memory but the first of its group has a thread to a neighbour.
    expect(none.links.count).toBeGreaterThanOrEqual(600 - 5);
    expect(scene.links.count - none.links.count).toBe(replay.links.length / 3);
    expect(scene.links.position).toHaveLength(scene.links.count * 6);
    expect(scene.links.color).toHaveLength(scene.links.count * 8);
    expect(scene.links.born).toHaveLength(scene.links.count * 2);
    for (let k = 0; k < scene.links.count; k++) {
      expect(scene.links.born[k * 2]).toBe(scene.links.born[k * 2 + 1]);
      expect(scene.links.along[k * 2]).toBe(0);
      expect(scene.links.along[k * 2 + 1]).toBe(1);
      expect(scene.links.born[k * 2]).toBeGreaterThan(0);
      // Fully grown before the replay ends.
      expect(scene.links.born[k * 2] + LINK_GROW_SECONDS).toBeLessThanOrEqual(scene.duration);
    }
    // The first thread runs from the second memory of the first group to the first one.
    expect(Array.from(scene.links.position.subarray(0, 3))).toEqual(Array.from(scene.neurons.position.subarray(9, 12)));
    expect(Array.from(scene.links.position.subarray(3, 6))).toEqual(Array.from(scene.neurons.position.subarray(0, 3)));
    expect(scene.links.born[0]).toBeCloseTo(scene.neurons.born[3]);
    // A thread that names no memory, or runs from newer to older, is dropped.
    const bad = buildReplayScene({ ...replay, links: [5, 5, 0, 9, 3, 0, -1, 4, 0, 2, 600, 1] });
    expect(bad.links.count).toBe(none.links.count);
  });

  it("counts up to the totals, and reads the calendar from its own clock", async () => {
    const { buildReplayScene } = await import("../lib/replay-scene");
    const replay = madeUp(600, 5);
    const scene = buildReplayScene(replay, 30);
    expect(scene.duration).toBe(30);
    // The replay opens on the first memory.
    expect(scene.countsAt(0)).toEqual({ memories: 1, reuses: 0, searches: 0, messages: 0 });
    expect(scene.countsAt(30)).toEqual({ memories: replay.totals.memories, reuses: replay.totals.reuses, searches: replay.totals.searches, messages: replay.totals.messages });
    let before = scene.countsAt(0);
    let day = scene.dateAt(0).getTime();
    expect(day).toBe(Date.parse(replay.start));
    for (let s = 1; s <= 30; s++) {
      const now = scene.countsAt(s);
      for (const key of ["memories", "reuses", "searches", "messages"] as const) expect(now[key]).toBeGreaterThanOrEqual(before[key]);
      before = now;
      expect(scene.dateAt(s).getTime()).toBeGreaterThanOrEqual(day);
      day = scene.dateAt(s).getTime();
    }
    expect(scene.dateAt(30).getTime()).toBe(Date.parse(replay.start) + replay.hours * 3_600_000);
    expect(scene.dateAt(99).getTime()).toBe(scene.dateAt(30).getTime());
    expect(scene.dateAt(-5).getTime()).toBe(Date.parse(replay.start));
    // Halfway through the replay, about half the memories are lit.
    expect(scene.countsAt(15).memories).toBeGreaterThan(200);
    expect(scene.countsAt(15).memories).toBeLessThan(400);
  });

  it("never draws more sparks than REPLAY_PULSES_MAX, however busy the brain was", async () => {
    const { buildReplayScene, REPLAY_PULSES_MAX, PULSE_SECONDS } = await import("../lib/replay-scene");
    const busy = madeUp(300, 4);
    busy.days.search = busy.days.search.map(() => 4000);
    busy.days.message = busy.days.message.map(() => 1000);
    const scene = buildReplayScene(busy);
    expect(scene.pulses.count).toBeLessThanOrEqual(REPLAY_PULSES_MAX);
    expect(scene.pulses.count).toBeGreaterThan(REPLAY_PULSES_MAX * 0.8);
    expect(scene.pulses.from).toHaveLength(scene.pulses.count * 3);
    expect(scene.pulses.to).toHaveLength(scene.pulses.count * 3);
    expect(scene.pulses.color).toHaveLength(scene.pulses.count * 3);
    expect(scene.pulses.from.every((v) => Number.isFinite(v))).toBe(true);
    // Every spark has landed when the replay ends.
    expect(scene.pulses.start.every((v) => v >= 0 && v + PULSE_SECONDS <= scene.duration)).toBe(true);
    // The words still count them all.
    expect(scene.countsAt(scene.duration).searches).toBe(400_000);
  });

  it("keeps a share of the sparks for searches and messages when reuses alone would take them all", async () => {
    const { buildReplayScene, REPLAY_PULSES_MAX } = await import("../lib/replay-scene");
    const replay = madeUp(300, 4);
    const fires: number[] = [];
    for (let f = 0; f < REPLAY_PULSES_MAX + 5000; f++) fires.push(f % 300, 2000, 0);
    const reusedOnly = buildReplayScene({ ...replay, fires, days: { search: [], message: [] } });
    const scene = buildReplayScene({ ...replay, fires });
    expect(reusedOnly.pulses.count).toBeLessThan(REPLAY_PULSES_MAX);
    expect(scene.pulses.count).toBeGreaterThan(reusedOnly.pulses.count);
    expect(scene.pulses.count).toBeLessThanOrEqual(REPLAY_PULSES_MAX);
    // Every reuse is still counted in the words.
    expect(scene.countsAt(scene.duration).reuses).toBe(REPLAY_PULSES_MAX + 5000);
  });

  it("shows a small history at once", async () => {
    const { buildReplayScene } = await import("../lib/replay-scene");
    const one = buildReplayScene(madeUp(1, 1));
    expect(one.neurons.born[0]).toBe(0);
    expect(one.countsAt(0).memories).toBe(1);
    const ten = buildReplayScene(madeUp(10, 2));
    expect(ten.neurons.born[0]).toBe(0);
    expect(ten.countsAt(ten.duration).memories).toBe(10);
  });

  it("builds an empty brain without a fault", async () => {
    const { buildReplayScene, REPLAY_GHOSTS } = await import("../lib/replay-scene");
    const empty: BrainReplay = {
      v: 1,
      start: "2026-06-11T12:00:00.000Z",
      hours: 1,
      clusters: 0,
      neurons: { cluster: [], born: [], gone: [], kind: [] },
      links: [],
      fires: [],
      days: { search: [3], message: [] },
      totals: { memories: 0, live: 0, reuses: 0, flags: 0, searches: 0, messages: 0 },
    };
    const scene = buildReplayScene(empty);
    expect(scene.neurons.count).toBe(0);
    expect(scene.links.count).toBe(0);
    // A search with no memory to run to draws nothing.
    expect(scene.pulses.count).toBe(0);
    expect(scene.ghosts).toHaveLength(REPLAY_GHOSTS * 3);
    expect(scene.countsAt(1).memories).toBe(0);
    // One memory alone has no thread: its spark runs to the middle.
    const one = buildReplayScene({ ...empty, clusters: 1, neurons: { cluster: [0], born: [0], gone: [-1], kind: [0] }, fires: [0, 0, 0] });
    expect(one.links.count).toBe(0);
    expect(Array.from(one.pulses.to.subarray(0, 3))).toEqual([0, 0, 0]);
  });
});

describe("the shape of the brain", () => {
  it("is a ball made into a brain: longer than wide, flat underneath, cleft along the top", async () => {
    const { brainPoint, brainFold } = await import("../lib/replay-scene");
    expect(brainPoint([0, 0, 1], 1)).toEqual([0.055, 0, 0]);
    const front = brainPoint([0, 0, 1], 0);
    const side = brainPoint([1, 0, 0], 0);
    const top = brainPoint([0.6, 0.8, 0], 0);
    const bottom = brainPoint([0.6, -0.8, 0], 0);
    expect(front[2]).toBeGreaterThan(side[0]);
    expect(top[1]).toBeGreaterThan(-bottom[1]);
    // The two halves stand apart, and the top dips between them.
    expect(brainPoint([-1, 0, 0], 0)[0]).toBeCloseTo(-side[0]);
    expect(brainPoint([0.001, 1, 0], 0)[1]).toBeLessThan(brainPoint([0.3, Math.sqrt(1 - 0.09), 0], 0)[1]);
    for (const dir of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.6, 0.8, 0]] as Array<[number, number, number]>) {
      expect(Math.abs(brainFold(dir))).toBeLessThanOrEqual(1);
    }
  });

  it("draws itself in faint points that stay inside the frame", async () => {
    const { brainGhosts, REPLAY_GHOSTS } = await import("../lib/replay-scene");
    const ghosts = brainGhosts();
    expect(ghosts).toHaveLength(REPLAY_GHOSTS * 3);
    let lowest = 0;
    for (let g = 0; g < REPLAY_GHOSTS; g++) {
      const [x, y, z] = ghosts.subarray(g * 3, g * 3 + 3);
      expect(Number.isFinite(x + y + z)).toBe(true);
      expect(Math.abs(x)).toBeLessThan(1);
      expect(y).toBeLessThan(0.9);
      expect(y).toBeGreaterThan(-1.1);
      expect(Math.abs(z)).toBeLessThan(1.2);
      lowest = Math.min(lowest, y);
    }
    // The stem hangs under the brain.
    expect(lowest).toBeLessThan(-0.9);
    expect(Array.from(brainGhosts())).toEqual(Array.from(ghosts));
  });

  it("places groups on both halves and a group's memories around its middle", async () => {
    const { clusterCentre, clusterDirection } = await import("../lib/replay-scene");
    for (const total of [1, 2, 7, 48]) {
      for (let c = 0; c < total; c++) {
        const centre = clusterCentre(c, total);
        expect(Math.hypot(...centre)).toBeCloseTo(1);
        expect(Math.sign(centre[0])).toBe(c % 2 === 0 ? 1 : -1);
        const first = clusterDirection(centre, 0, 100, 0.1);
        const last = clusterDirection(centre, 99, 100, 0.1);
        expect(Math.hypot(...first)).toBeCloseTo(1);
        expect(Math.hypot(...last)).toBeCloseTo(1);
        const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        // The first memory sits in the middle of the group, later ones further out.
        expect(dot(first, centre)).toBeGreaterThan(dot(last, centre));
        expect(dot(first, centre)).toBeGreaterThan(0.99);
      }
    }
    // A group whose middle points straight up still has two directions to spread along.
    expect(Math.hypot(...clusterDirection([0, 1, 0], 3, 10, 0.5))).toBeCloseTo(1);
    expect(clusterDirection([0, 1, 0], 3, 10, 0.5).every((v) => Number.isFinite(v))).toBe(true);
    expect(clusterDirection([1, 0, 0], 0, 0, 2).every((v) => Number.isFinite(v))).toBe(true);
  });

  it("works with numbers that are never random", async () => {
    const { hash01, countUpTo, parseCssColor } = await import("../lib/replay-scene");
    const seen = new Set<number>();
    for (let a = 0; a < 200; a++) {
      const h = hash01(a, 7);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      expect(hash01(a, 7)).toBe(h);
      seen.add(h);
    }
    expect(seen.size).toBe(200);
    expect(hash01(1, 2)).not.toBe(hash01(2, 1));

    expect(countUpTo([], 5)).toBe(0);
    expect(countUpTo([1, 2, 2, 3, 9], 0)).toBe(0);
    expect(countUpTo([1, 2, 2, 3, 9], 2)).toBe(3);
    expect(countUpTo([1, 2, 2, 3, 9], 8.5)).toBe(4);
    expect(countUpTo(new Float32Array([1, 2, 2, 3, 9]), 9)).toBe(5);

    expect(parseCssColor("rgb(26, 51, 102)")).toEqual([26 / 255, 51 / 255, 102 / 255]);
    expect(parseCssColor(" rgba(255, 0, 0, 0.5)")).toEqual([1, 0, 0]);
    expect(parseCssColor("color(srgb 0.1 0.2 0.38)")).toEqual([0.1, 0.2, 0.38]);
    expect(parseCssColor("oklch(0.5 0.1 200)")).toBeNull();
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor("rgb(1, 2)")).toBeNull();
  });
});

describe("the Replay on the page", () => {
  it("is one button under the picture, and the replay itself starts by saying what it does", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.doMock("@/app/components/shell/Shell", () => ({ default: ({ children }: { children: unknown }) => children }));
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: LivePage } = await import("../app/live/page");
    const html = await new Response(await renderToReadableStream((await LivePage()) as never)).text();
    expect((html.match(/<button/g) ?? []).length).toBe(1);
    expect(html).toMatch(/<button type="button" class="btn-primary">Replay how the brain grew<\/button>/);
    // Nothing of the replay is on the page before the button is pressed.
    expect(html).not.toContain("<canvas");

    const { createElement } = await import("react");
    const { default: BrainReplayView } = await import("../app/live/BrainReplay");
    const opened = await new Response(await renderToReadableStream(createElement(BrainReplayView, { onClose: () => {} }))).text();
    expect(opened).toContain("<canvas");
    expect(opened).toContain('role="img"');
    expect(opened).toContain("Reading the history of the brain");
    expect(opened).toContain("Back to live");
  });

  it("is told in the changelog, the README and the spec, with the spec's numbers true", async () => {
    const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
    expect(read("README.md")).toContain("Replay");
    const { CHANGELOG } = await import("../lib/changelog");
    expect(CHANGELOG.some((entry) => entry.changes.some((line) => line.includes("Replay")))).toBe(true);
    const spec = read("docs/spec.md");
    const live = await import("../lib/live-replay");
    const scene = await import("../lib/replay-scene");
    const count = (n: number) => n.toLocaleString("en-US");
    expect(spec).toContain("`GET /live/replay`");
    expect(spec).toContain(`\`REPLAY_SECONDS\` (${scene.REPLAY_SECONDS})`);
    expect(spec).toContain(`\`REPLAY_PULSES_MAX\` (${count(scene.REPLAY_PULSES_MAX)})`);
    expect(spec).toContain(`\`REPLAY_CLUSTERS_MAX\` (${live.REPLAY_CLUSTERS_MAX})`);
    expect(spec).toContain(`\`REPLAY_TAG_LINKS\` (${live.REPLAY_TAG_LINKS})`);
    expect(spec).toContain(`\`REPLAY_NEURONS_MAX\` (${count(live.REPLAY_NEURONS_MAX)})`);
    expect(spec).toContain(`\`REPLAY_FIRES_MAX\` (${count(live.REPLAY_FIRES_MAX)})`);
    expect(spec).toContain(`\`REPLAY_CACHE_MS\` (${live.REPLAY_CACHE_MS / 60_000} minutes)`);
    expect(spec).toContain(`\`REPLAY_LIMIT_PER_MINUTE\` (${live.REPLAY_LIMIT_PER_MINUTE})`);
    expect(spec).toContain(`\`REPLAY_UNKNOWN_LIMIT_PER_MINUTE\` (${live.REPLAY_UNKNOWN_LIMIT_PER_MINUTE})`);
    expect(spec).toContain(`\`REPLAY_TAIL_SECONDS\` (${scene.REPLAY_TAIL_SECONDS})`);
  });
});
