import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The Live Brain page (/live): the snapshot read from the audit log (lib/live-brain.ts), the feed
 * the open page asks for, the page itself and the geometry of the picture. The page must show what
 * happened and name nobody.
 */

let dataDir: string;
const ANN = "ann.a@example.com";
const BOB = "bob.b@example.com";
const CAT = "cat.c@example.com";
const SEARCH_TOOL = "/mcp#tools/call:bab_search";
const NOW = new Date();

const sql = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const minutesAgo = (m: number) => sql(new Date(NOW.getTime() - m * 60_000));

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-live-test-"));
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
  vi.doUnmock("@/app/components/shell/Shell");
  vi.resetModules();
});

async function row(actor: string, action: string, at: string, over: { path?: string; entity?: string; entityId?: string } = {}) {
  const { getDb } = await import("../lib/db");
  getDb()
    .prepare("INSERT INTO audit_log (actor_id, action, entity, entity_id, via, at, path) VALUES (?, ?, ?, ?, 'mcp', ?, ?)")
    .run(actor, action, over.entity ?? "request", over.entityId ?? "x", at, over.path ?? null);
}
const search = (actor: string, at: string) => row(actor, "POST", at, { path: SEARCH_TOOL });

async function person(id: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id, email: id, name: id.split("@")[0], roles: [] });
}

/** A memory saved by its author just now: the save is itself a beat. */
async function memory(author: string, title: string) {
  await person(author);
  const { create } = await import("../lib/learnings");
  return create({ authorId: author, title, body: "What holds and how we know.", tags: [] }, "mcp");
}

describe("liveBrain", () => {
  it("counts each kind of beat in the last 24 hours and leaves the rest out", async () => {
    const saved = await memory(ANN, "Deploys need the staging flag");
    await search(BOB, minutesAgo(30));
    await search(BOB, minutesAgo(20));
    await row(BOB, "GET", minutesAgo(19), { path: "/api/learnings" });
    await row(BOB, "helpful", minutesAgo(18), { entity: "learning", entityId: saved.id });
    await row(CAT, "confirm", minutesAgo(17), { entity: "learning", entityId: saved.id });
    await row(CAT, "flag", minutesAgo(16), { entity: "learning", entityId: saved.id });
    await row(CAT, "send", minutesAgo(15), { entity: "message", entityId: "m-none" });
    // Not beats: too old, not a person, a write to the search address, a page view, another action.
    await search(BOB, minutesAgo(25 * 60));
    await search("anonymous", minutesAgo(5));
    await row("system", "create", minutesAgo(5), { entity: "learning", entityId: saved.id });
    await row(BOB, "POST", minutesAgo(5), { path: "/api/learnings" });
    await row(BOB, "GET", minutesAgo(5), { path: "/memory" });
    await row(BOB, "retire", minutesAgo(5), { entity: "learning", entityId: saved.id });

    const { liveBrain, LIVE_WINDOW_HOURS } = await import("../lib/live-brain");
    const brain = liveBrain(NOW);
    expect(brain.counts).toEqual({ save: 1, search: 3, reuse: 2, message: 1, flag: 1 });
    expect(brain.agents).toBe(3);
    expect(brain.dots).toHaveLength(3);
    expect(brain.memories).toBe(1);
    expect(brain.beats).toHaveLength(8);
    expect(Date.parse(brain.since)).toBe(NOW.getTime() - LIVE_WINDOW_HOURS * 3_600_000);
    // Oldest first, so the page can tell which beats are new by their id.
    const ids = brain.beats.map((b) => b.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("names nobody: a dot is a key that cannot be read back", async () => {
    await memory(ANN, "Use the shared runner for long jobs");
    await search(BOB, minutesAgo(3));
    const { liveBrain, _resetLiveBrainForTests } = await import("../lib/live-brain");
    const first = liveBrain(NOW);
    const text = JSON.stringify(first);
    for (const who of [ANN, BOB, "ann", "bob"]) expect(text).not.toContain(who);
    for (const key of first.dots) expect(key).toMatch(/^[0-9a-f]{12}$/);
    expect([...first.dots].sort()).toEqual(first.dots);

    // One person keeps one dot while the app runs, and gets another after a restart.
    expect(liveBrain(NOW).dots).toEqual(first.dots);
    _resetLiveBrainForTests();
    const after = liveBrain(NOW);
    expect(after.dots).toHaveLength(2);
    for (const key of after.dots) expect(first.dots).not.toContain(key);
  });

  it("shows a memory's title only while the memory is live, and never a search or a message text", async () => {
    const kept = await memory(ANN, "Kept title");
    const gone = await memory(ANN, "Gone title");
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE learnings SET status = 'archived' WHERE id = ?").run(gone.id);
    await row(BOB, "POST", minutesAgo(2), { path: SEARCH_TOOL, entityId: "how do we rotate the key" });

    const { liveBrain } = await import("../lib/live-brain");
    const brain = liveBrain(NOW);
    const saves = brain.beats.filter((b) => b.kind === "save");
    expect(saves.map((b) => b.memory)).toEqual([{ id: kept.id, title: "Kept title" }, null]);
    expect(brain.beats.find((b) => b.kind === "search")!.memory).toBeNull();
    expect(JSON.stringify(brain)).not.toContain("rotate the key");
    expect(JSON.stringify(brain)).not.toContain("Gone title");
  });

  it("points a message at the receiver's dot, or at nobody when the receiver has none", async () => {
    await person(ANN);
    await person(BOB);
    await person(CAT);
    const { send } = await import("../lib/messages");
    send({ fromId: ANN, to: BOB, subject: "A private subject", body: "A private body" }, "mcp");
    send({ fromId: ANN, to: CAT, subject: "Another subject", body: "Another body" }, "mcp");
    await search(BOB, minutesAgo(1));

    const { liveBrain } = await import("../lib/live-brain");
    const brain = liveBrain(NOW);
    const sent = brain.beats.filter((b) => b.kind === "message");
    expect(sent).toHaveLength(2);
    // Bob searched, so he has a dot. Cat did nothing, so she has none.
    expect(brain.dots).toHaveLength(2);
    expect(sent[0].to).not.toBeNull();
    expect(brain.dots).toContain(sent[0].to);
    expect(sent[0].to).not.toBe(sent[0].agent);
    expect(sent[1].to).toBeNull();
    const text = JSON.stringify(brain);
    expect(text).not.toContain("private");
    expect(text).not.toContain("Another");
  });

  it("draws at most LIVE_DOTS_MAX dots, the most recent, and sends at most LIVE_BEATS_MAX beats", async () => {
    const { liveBrain, LIVE_DOTS_MAX, LIVE_BEATS_MAX } = await import("../lib/live-brain");
    const people = LIVE_DOTS_MAX + 3;
    // Person 0 is the oldest, and searches twice so there are more beats than the page takes.
    for (let i = 0; i < people; i++) await search(`p${i}@example.com`, minutesAgo(600 - i));
    for (let i = 0; i < LIVE_BEATS_MAX; i++) await search(`p${people - 1}@example.com`, minutesAgo(100 - i));

    const brain = liveBrain(NOW);
    expect(brain.agents).toBe(people);
    expect(brain.dots).toHaveLength(LIVE_DOTS_MAX);
    expect(brain.counts.search).toBe(people + LIVE_BEATS_MAX);
    expect(brain.beats).toHaveLength(LIVE_BEATS_MAX);
    // Every beat sent is by the last person, who has a dot.
    expect(new Set(brain.beats.map((b) => b.agent)).size).toBe(1);
    expect(brain.beats[0].agent).not.toBeNull();
  });

  it("gives a beat no dot when its person is not among the dots drawn", async () => {
    const { liveBrain, LIVE_DOTS_MAX } = await import("../lib/live-brain");
    await search("early@example.com", minutesAgo(900));
    for (let i = 0; i < LIVE_DOTS_MAX; i++) await search(`p${i}@example.com`, minutesAgo(100 - i));
    const brain = liveBrain(NOW);
    expect(brain.beats[0].agent).toBeNull();
    expect(brain.beats.slice(1).every((b) => b.agent !== null)).toBe(true);
  });

  it("is empty and whole when nothing happened", async () => {
    const { liveBrain } = await import("../lib/live-brain");
    expect(liveBrain(NOW)).toMatchObject({ agents: 0, dots: [], memories: 0, beats: [], counts: { save: 0, search: 0, reuse: 0, message: 0, flag: 0 } });
  });

  it("serves one snapshot for LIVE_CACHE_MS, then reads again", async () => {
    const { cachedLiveBrain, LIVE_CACHE_MS } = await import("../lib/live-brain");
    const first = cachedLiveBrain(NOW);
    await search(BOB, minutesAgo(1));
    expect(cachedLiveBrain(new Date(NOW.getTime() + LIVE_CACHE_MS - 1))).toBe(first);
    const later = cachedLiveBrain(new Date(NOW.getTime() + LIVE_CACHE_MS));
    expect(later).not.toBe(first);
    expect(later.counts.search).toBe(1);
  });
});

describe("GET /live/feed", () => {
  it("answers the snapshot as JSON, never cached, and writes no audit row", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    await search(BOB, minutesAgo(1));
    const { getDb } = await import("../lib/db");
    const rows = () => Number((getDb().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n);
    const before = rows();

    const { GET } = await import("../app/live/feed/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { now: string; brain: { counts: { search: number }; dots: string[] } };
    expect(Number.isNaN(Date.parse(body.now))).toBe(false);
    expect(body.brain.counts.search).toBe(1);
    expect(body.brain.dots).toHaveLength(1);
    expect(rows()).toBe(before);
  });

  it("answers 429 once the browser bucket is spent", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.doMock("@/lib/rate-limit", () => ({ checkUiRateLimit: () => false }));
    const { GET } = await import("../app/live/feed/route");
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("the /live page", () => {
  async function renderPage(): Promise<string> {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.doMock("@/app/components/shell/Shell", () => ({ default: ({ children }: { children: unknown }) => children }));
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: LivePage } = await import("../app/live/page");
    return new Response(await renderToReadableStream((await LivePage()) as never)).text();
  }

  it("draws the dots, the numbers and the list, with a link to the memory and no name", async () => {
    const saved = await memory(ANN, "Pin the base image by digest");
    await search(BOB, minutesAgo(4));
    const html = await renderPage();
    expect(html).toContain(">Live</h1>");
    expect(html).toContain("Nobody is named.");
    expect(html).toContain('role="img"');
    expect((html.match(/<circle class="[^"]*dot/g) ?? []).length).toBe(2);
    expect(html).toContain("An agent saved a memory");
    expect(html).toContain("An agent searched the brain");
    expect(html).toContain(`href="/memory/${saved.id}"`);
    expect(html).toContain("Pin the base image by digest");
    for (const who of [ANN, BOB, "ann.a", "bob.b"]) expect(html).not.toContain(who);
    // Read-only: nothing on the page can act.
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });

  it("says so when the brain is quiet", async () => {
    const html = await renderPage();
    expect(html).toContain("Quiet for the last 24 hours.");
    expect(html).not.toMatch(/<circle class="[^"]*dot/);
  });

  it("renders a memory title as text, never as markup", async () => {
    await memory(ANN, "<img src=x onerror=alert(1)> title");
    const html = await renderPage();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("the picture", () => {
  it("puts the first dot at the top and every dot inside the frame, each in its own place", async () => {
    const { CORE, PICTURE, dotPlace } = await import("../lib/live-picture");
    const { LIVE_DOTS_MAX } = await import("../lib/live-brain");
    expect(dotPlace(0, 1).x).toBeCloseTo(CORE.x);
    expect(dotPlace(0, 1).y).toBeLessThan(CORE.y - CORE.r);
    for (let total = 1; total <= LIVE_DOTS_MAX; total++) {
      const seen = new Set<string>();
      for (let i = 0; i < total; i++) {
        const p = dotPlace(i, total);
        expect(p.x).toBeGreaterThan(20);
        expect(p.x).toBeLessThan(PICTURE.width - 20);
        expect(p.y).toBeGreaterThan(20);
        expect(p.y).toBeLessThan(PICTURE.height - 20);
        // Clear of the brain, so a dot never sits on it.
        expect(Math.hypot(p.x - CORE.x, p.y - CORE.y)).toBeGreaterThan(CORE.r + 40);
        seen.add(`${Math.round(p.x)},${Math.round(p.y)}`);
      }
      expect(seen.size).toBe(total);
    }
  });

  it("draws a message from one dot to the other, and the brain's edge faces the dot", async () => {
    const { CORE, arcPath, coreEdge, dotPlace, smoothClosed } = await import("../lib/live-picture");
    const a = dotPlace(0, 6);
    const b = dotPlace(3, 6);
    const d = arcPath(a, b);
    expect(d.startsWith(`M ${Math.round(a.x * 10) / 10} ${Math.round(a.y * 10) / 10} Q `)).toBe(true);
    expect(d.endsWith(` ${Math.round(b.x * 10) / 10} ${Math.round(b.y * 10) / 10}`)).toBe(true);
    expect(d).not.toContain("NaN");
    // Neighbours: the line bends outward, away from the brain.
    const near = arcPath(dotPlace(0, 6), dotPlace(1, 6)).match(/Q ([\d.-]+) ([\d.-]+)/)!;
    const mid = { x: (dotPlace(0, 6).x + dotPlace(1, 6).x) / 2, y: (dotPlace(0, 6).y + dotPlace(1, 6).y) / 2 };
    expect(Math.hypot(Number(near[1]) - CORE.x, Number(near[2]) - CORE.y)).toBeGreaterThan(Math.hypot(mid.x - CORE.x, mid.y - CORE.y));
    // No dots at all still gives a place, not a division by zero.
    expect(Number.isFinite(dotPlace(0, 0).x)).toBe(true);
    const e = coreEdge(a);
    expect(Math.hypot(e.x - CORE.x, e.y - CORE.y)).toBeCloseTo(CORE.r);
    expect(coreEdge(CORE)).toEqual({ x: CORE.x, y: CORE.y });
    expect(smoothClosed([[0, 0], [10, 0], [10, 10]])).toMatch(/^M [\d. -]+( Q [\d. -]+){3} Z$/);
  });

  it("calls every beat by what an agent did", async () => {
    const { BEAT_WORDS } = await import("../lib/live-picture");
    const { BEAT_KINDS } = await import("../lib/live-brain");
    expect(Object.keys(BEAT_WORDS).sort()).toEqual([...BEAT_KINDS].sort());
    for (const words of Object.values(BEAT_WORDS)) expect(words).toMatch(/^An agent /);
  });
});

describe("where the page is told", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

  it("is in the navigation, the changelog, the README and the spec, with the spec's numbers true", async () => {
    const { NAV_ITEMS } = await import("../app/components/nav-items");
    expect(NAV_ITEMS.map((i) => i.href as string)).toContain("/live");
    expect(read("README.md")).toContain("**Live page.**");
    const { LIVE_WINDOW_HOURS, LIVE_DOTS_MAX, LIVE_BEATS_MAX, LIVE_CACHE_MS } = await import("../lib/live-brain");
    const spec = read("docs/spec.md");
    expect(spec).toContain("## Live Brain page");
    expect(spec).toContain(`\`LIVE_WINDOW_HOURS\` (${LIVE_WINDOW_HOURS})`);
    expect(spec).toContain(`\`LIVE_DOTS_MAX\` (${LIVE_DOTS_MAX})`);
    expect(spec).toContain(`\`LIVE_BEATS_MAX\` (${LIVE_BEATS_MAX})`);
    expect(spec).toContain(`\`LIVE_CACHE_MS\` (${LIVE_CACHE_MS / 1000} seconds)`);
    const { REPLAY_MAX, POLL_MS } = await import("../app/live/LiveBrain");
    expect(spec).toContain(`at most ${REPLAY_MAX} beats`);
    expect(spec).toContain(`every ${POLL_MS / 1000} seconds`);
  });
});
