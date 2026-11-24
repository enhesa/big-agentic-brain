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
    await row(CAT, "send", minutesAgo(10), { entity: "message", entityId: "m-none" });
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
    expect(brain.memories).toBe(1);
    expect(brain.beats).toHaveLength(8);
    expect(Date.parse(brain.since)).toBe(NOW.getTime() - LIVE_WINDOW_HOURS * 3_600_000);
    // Oldest first, so the page can tell which beats are new by their id.
    const ids = brain.beats.map((b) => b.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("never says who did what: no beat carries a person, or anything that ties two beats together", async () => {
    // A memory page names its author. So a save must not share anything with the same person's search.
    await memory(ANN, "Use the shared runner for long jobs");
    await search(ANN, minutesAgo(3));
    await search(BOB, minutesAgo(2));
    const { liveBrain } = await import("../lib/live-brain");
    const brain = liveBrain(NOW);
    const text = JSON.stringify(brain);
    for (const who of [ANN, BOB, "ann", "bob"]) expect(text).not.toContain(who);
    // The whole shape, so a new field has to be argued for here.
    expect(Object.keys(brain).sort()).toEqual(["agents", "beats", "counts", "memories", "since"]);
    expect(brain.beats).toHaveLength(3);
    for (const beat of brain.beats) expect(Object.keys(beat).sort()).toEqual(["at", "id", "kind", "memory"]);
    // Ann's search and Bob's search look the same apart from when they happened.
    const [a, b] = brain.beats.filter((x) => x.kind === "search");
    expect({ ...a, id: 0, at: "" }).toEqual({ ...b, id: 0, at: "" });
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

  it("says a message was sent, and nothing about who sent it, who got it or what it said", async () => {
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
    for (const beat of sent) expect(Object.keys(beat).sort()).toEqual(["at", "id", "kind", "memory"]);
    expect(sent.map((b) => b.memory)).toEqual([null, null]);
    // Ann sent and Bob searched: two people, which the page shows as its floor of three.
    expect(brain.agents).toBe(3);
    const text = JSON.stringify(brain);
    expect(text).not.toContain("private");
    expect(text).not.toContain("Another");
    for (const who of [ANN, BOB, CAT, "ann", "bob", "cat"]) expect(text).not.toContain(who);
  });

  it("counts every person and every beat, and sends at most LIVE_BEATS_MAX beats, the newest", async () => {
    const { liveBrain, LIVE_DOTS_MAX, LIVE_BEATS_MAX } = await import("../lib/live-brain");
    const people = LIVE_DOTS_MAX + 3;
    // Person 0 is the oldest, and searches twice so there are more beats than the page takes.
    for (let i = 0; i < people; i++) await search(`p${i}@example.com`, minutesAgo(600 - i));
    for (let i = 0; i < LIVE_BEATS_MAX; i++) await search(`p${people - 1}@example.com`, minutesAgo(100 - i));

    const brain = liveBrain(NOW);
    expect(brain.agents).toBe(people);
    expect(brain.counts.search).toBe(people + LIVE_BEATS_MAX);
    expect(brain.beats).toHaveLength(LIVE_BEATS_MAX);
    // The newest: all later than the first round of searches.
    const oldest = Date.parse(brain.beats[0].at);
    expect(NOW.getTime() - oldest).toBeLessThan(101 * 60_000);
  });

  it("never shows fewer than LIVE_PEOPLE_FLOOR people, so one person at work cannot be picked out", async () => {
    // "One person at work" would make every beat that person's, and a save is signed on its memory page.
    const { liveBrain, LIVE_PEOPLE_FLOOR } = await import("../lib/live-brain");
    expect(LIVE_PEOPLE_FLOOR).toBeGreaterThanOrEqual(3);
    const seen: number[] = [];
    for (let i = 0; i < LIVE_PEOPLE_FLOOR + 2; i++) {
      await search(`p${i}@example.com`, minutesAgo(60 + i));
      await search(`p${i}@example.com`, minutesAgo(30 + i));
      seen.push(liveBrain(NOW).agents);
    }
    // One, two and three people all read as three. Only then does the count move.
    expect(seen).toEqual([3, 3, 3, 4, 5]);
    // And nothing else in the snapshot says how many there are: no count of who is at work now.
    expect(JSON.stringify(liveBrain(NOW))).not.toMatch(/awake|active|online/);
  });

  it("counts a person only from the next mark of the clock, so the count does not rise with a beat", async () => {
    const { liveBrain, LIVE_PEOPLE_STEP_MINUTES } = await import("../lib/live-brain");
    const step = LIVE_PEOPLE_STEP_MINUTES * 60_000;
    // Two minutes after a mark.
    const at = new Date(Math.floor(NOW.getTime() / step) * step + 2 * 60_000);
    const before = (m: number) => sql(new Date(at.getTime() - m * 60_000));
    for (let i = 0; i < 4; i++) await search(`p${i}@example.com`, before(30 + i));
    expect(liveBrain(at).agents).toBe(4);
    // A fifth person's first beat, one minute ago: after the mark, so the count stays.
    await search(CAT, before(1));
    const same = liveBrain(at);
    expect(same.agents).toBe(4);
    expect(same.counts.search).toBe(5);
    // Just before the next mark it still stays, and from the mark on it is five.
    expect(liveBrain(new Date(at.getTime() + 3 * 60_000 - 1000)).agents).toBe(4);
    expect(liveBrain(new Date(at.getTime() + 3 * 60_000)).agents).toBe(5);
  });

  it("keeps the count flat when a beat turns 24 hours old, so a fall cannot be matched to a person", async () => {
    // A daily job: yesterday it confirmed a memory, and the memory page names that voter with the
    // time. Today it searched, 20 seconds earlier in the day.
    const { liveBrain, LIVE_PEOPLE_STEP_MINUTES, LIVE_WINDOW_HOURS } = await import("../lib/live-brain");
    const step = LIVE_PEOPLE_STEP_MINUTES * 60_000;
    const mark = Math.floor(NOW.getTime() / step) * step;
    const day = LIVE_WINDOW_HOURS * 3_600_000;
    const at = (ms: number) => sql(new Date(mark + ms));
    for (let i = 0; i < 4; i++) await search(`p${i}@example.com`, at(-(30 + i) * 60_000));
    await row(CAT, "confirm", at(-day + 40_000), { entity: "learning", entityId: "m-daily" });
    await search(CAT, at(20_000));
    // Bob's job ran a little later today: yesterday's confirm was 10 seconds before this mark.
    await row(BOB, "confirm", at(-day - 10_000), { entity: "learning", entityId: "m-daily" });
    await search(BOB, at(20_000));

    const seen = (ms: number) => liveBrain(new Date(mark + ms));
    expect(seen(30_000).agents).toBe(6);
    expect(seen(30_000).counts.reuse).toBe(1);
    // Cat's confirm is now 24 hours old and leaves the counts. The count of people does not move.
    expect(seen(41_000).counts.reuse).toBe(0);
    expect(seen(41_000).agents).toBe(6);
    expect(seen(step - 1000).agents).toBe(6);
    // At the next mark today's searches are counted, and yesterday's confirms still are.
    expect(seen(step).agents).toBe(6);
  });

  it("lets a person leave the count only at a mark of the clock, and goes back to 0 when nothing is left", async () => {
    const { liveBrain, LIVE_PEOPLE_STEP_MINUTES, LIVE_PEOPLE_SLACK_MINUTES, LIVE_WINDOW_HOURS } = await import("../lib/live-brain");
    const step = LIVE_PEOPLE_STEP_MINUTES * 60_000;
    const slack = LIVE_PEOPLE_SLACK_MINUTES * 60_000;
    expect(slack % step).toBe(0);
    const mark = Math.floor(NOW.getTime() / step) * step;
    const day = LIVE_WINDOW_HOURS * 3_600_000;
    const hours = 3_600_000;
    const at = (ms: number) => sql(new Date(mark + ms));
    for (let i = 0; i < 4; i++) await search(`p${i}@example.com`, at(-day + 6 * hours + i * 60_000));
    // Cat's only beat turns 24 hours old 40 seconds after the mark.
    await search(CAT, at(-day + 40_000));

    const seen = (ms: number) => liveBrain(new Date(mark + ms));
    expect(seen(30_000).agents).toBe(5);
    expect(seen(41_000).counts.search).toBe(4);
    expect(seen(41_000).agents).toBe(5);
    // Cat stays counted for the slack, and leaves at a mark.
    expect(seen(slack + step - 1000).agents).toBe(5);
    expect(seen(slack + step).agents).toBe(4);
    // Once every beat is older than the page's window the page is empty again, at once: the four
    // are still inside the slack, and the count of people must not outlive the beats.
    const later = seen(6 * hours + 4 * 60_000);
    expect(later.agents).toBe(0);
    expect(later.beats).toEqual([]);
    expect(later.counts).toEqual({ save: 0, search: 0, reuse: 0, message: 0, flag: 0 });
    // And it is still empty once they are out of the slack too.
    expect(seen(8 * hours).agents).toBe(0);
  });

  it("is empty and whole when nothing happened", async () => {
    const { liveBrain } = await import("../lib/live-brain");
    const empty = { agents: 0, memories: 0, beats: [], counts: { save: 0, search: 0, reuse: 0, message: 0, flag: 0 } };
    expect(liveBrain(NOW)).toMatchObject(empty);
    // Only rows from before the window, then only rows that are not beats.
    await search(BOB, minutesAgo(30 * 60));
    expect(liveBrain(NOW)).toMatchObject(empty);
    await row(BOB, "GET", minutesAgo(5), { path: "/memory" });
    expect(liveBrain(NOW)).toMatchObject(empty);
  });

  it("reads a quiet day without walking the rows before the window", async () => {
    // A long history of memory rows, all old, and one search today.
    const { getDb } = await import("../lib/db");
    const db = getDb();
    const insert = db.prepare("INSERT INTO audit_log (actor_id, action, entity, entity_id, via, at, path) VALUES (?, 'helpful', 'learning', ?, 'mcp', ?, NULL)");
    for (let i = 0; i < 400; i++) insert.run(BOB, `old-${i}`, minutesAgo(3 * 24 * 60 + i));
    await search(ANN, minutesAgo(3));
    const { liveBrain, _livePlansForTests } = await import("../lib/live-brain");
    const brain = liveBrain(NOW);
    expect(brain.counts).toEqual({ save: 0, search: 1, reuse: 0, message: 0, flag: 0 });
    expect(brain.agents).toBe(3);
    // How the database reads it: the window's first row from the index over the time, then only
    // the rows from that id on. Never a scan of the table, and no index that pulls in old rows.
    const plans = _livePlansForTests();
    expect(plans.first).toEqual(["SEARCH audit_log USING COVERING INDEX idx_audit_at (at>?)"]);
    for (const name of ["tally", "beats"] as const) {
      expect(plans[name], name).toContain("SEARCH a USING INTEGER PRIMARY KEY (rowid>?)");
      expect(plans[name].join(" "), name).not.toMatch(/SCAN|idx_audit/);
    }
  });

  it("still counts a row written out of order, by its time", async () => {
    // The newest row by id is older than the window, and an older row by id is inside it.
    await search(ANN, minutesAgo(10));
    await search(BOB, minutesAgo(26 * 60));
    await search(CAT, minutesAgo(20));
    // Two more, so the count is above the floor and Bob would show in it.
    await search("dan.d@example.com", minutesAgo(30));
    await search("eve.e@example.com", minutesAgo(40));
    const { liveBrain } = await import("../lib/live-brain");
    const brain = liveBrain(NOW);
    expect(brain.counts.search).toBe(4);
    expect(brain.agents).toBe(4);
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
    const text = await res.text();
    const body = JSON.parse(text) as { now: string; brain: { counts: { search: number }; agents: number } };
    expect(Number.isNaN(Date.parse(body.now))).toBe(false);
    expect(body.brain.counts.search).toBe(1);
    expect(body.brain.agents).toBe(3);
    expect(text).not.toContain("bob");
    expect(rows()).toBe(before);
  });

  it("spends a signed-in browser's own bucket, and answers 429 once it is spent", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.doMock("@/lib/notify-auth", () => ({ NO_STORE: { "Cache-Control": "no-store" }, getViewer: async () => ({ ownerId: ANN, actor: {} }) }));
    const spent: string[] = [];
    vi.doMock("@/lib/rate-limit", async (original) => ({
      ...(await original<typeof import("../lib/rate-limit")>()),
      checkUiRateLimit: (id: string) => {
        spent.push(id);
        return false;
      },
    }));
    const { GET } = await import("../app/live/feed/route");
    const res = await GET();
    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(spent).toEqual([ANN]);
    vi.doUnmock("@/lib/notify-auth");
  });

  it("limits an anonymous caller by a verified address only, each address on its own", async () => {
    const from = (ip: string) => vi.doMock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": ip }) }));
    // A new start, as after a restart: closes the database first, so its file can be removed later.
    const restart = async () => {
      (await import("../lib/db"))._resetDbForTests();
      vi.resetModules();
    };
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    try {
      from("192.0.2.7");
      const { checkRateLimit, ANON_RATE_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
      for (let i = 0; i < ANON_RATE_LIMIT_PER_MINUTE; i++) checkRateLimit("anon:192.0.2.7", ANON_RATE_LIMIT_PER_MINUTE);
      const { GET } = await import("../app/live/feed/route");
      const refused = await GET();
      expect(refused.status).toBe(429);
      expect(refused.headers.get("Retry-After")).toMatch(/^\d+$/);
      expect(refused.headers.get("Cache-Control")).toBe("no-store");

      // Another address is not held back by the first one.
      await restart();
      from("192.0.2.8");
      const rate = await import("../lib/rate-limit");
      for (let i = 0; i < rate.ANON_RATE_LIMIT_PER_MINUTE; i++) rate.checkRateLimit("anon:192.0.2.7", rate.ANON_RATE_LIMIT_PER_MINUTE);
      expect((await (await import("../app/live/feed/route")).GET()).status).toBe(200);

      // An address nobody vouches for is not a bucket: it could be changed at will.
      delete process.env.BAB_CLIENT_IP_HEADER;
      await restart();
      from("192.0.2.7");
      const loose = await import("../lib/rate-limit");
      for (let i = 0; i < loose.ANON_RATE_LIMIT_PER_MINUTE; i++) loose.checkRateLimit("anon:192.0.2.7", loose.ANON_RATE_LIMIT_PER_MINUTE);
      expect((await (await import("../app/live/feed/route")).GET()).status).toBe(200);
    } finally {
      delete process.env.BAB_CLIENT_IP_HEADER;
    }
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
    expect(html).toContain("The brain at work over the last 24 hours</p>");
    expect(html).not.toContain("Nobody is named.");
    // The privacy line moved under the picture: a dot stands for a person, but no dot is anyone's.
    expect(html).toContain("no dot is anyone");
    expect(html).toContain('role="img"');
    // Two people, drawn as three dots that all look alike. The page says a dot is nobody's.
    const dotClasses = html.match(/<circle class="[^"]*dot[^"]*"/g) ?? [];
    expect(dotClasses).toHaveLength(3);
    expect(new Set(dotClasses).size).toBe(1);
    expect(html).toContain("3 or fewer");
    expect(html).toContain("never shows one person alone");
    expect(html).toContain("drawn by lot");
    expect(html).toContain("An agent saved a memory");
    expect(html).toContain("An agent searched the brain");
    expect(html).toContain(`href="/memory/${saved.id}"`);
    expect(html).toContain("Pin the base image by digest");
    for (const who of [ANN, BOB, "ann.a", "bob.b"]) expect(html).not.toContain(who);
    // Read-only: nothing on the page can act. Its one button plays the Replay.
    expect(html).not.toContain("<form");
    expect((html.match(/<button/g) ?? []).length).toBe(1);
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

  it("seats a mark by lot, from the beat's id and the number of dots alone", async () => {
    const { seatOf, otherSeat } = await import("../lib/live-picture");
    // Two arguments: there is nothing about a person to pass in.
    expect(seatOf.length).toBe(2);
    expect(seatOf(7, 0)).toBe(-1);
    // The same beat always gets the same seat.
    for (let id = 1; id <= 300; id++) {
      const seat = seatOf(id, 12);
      expect(seat).toBe(seatOf(id, 12));
      expect(seat >= 0 && seat < 12).toBe(true);
      // A message goes to another seat, never back to its own.
      const other = otherSeat(id, 12, seat);
      expect(other >= 0 && other < 12 && other !== seat).toBe(true);
    }
    // The lot spreads the marks: every seat gets some.
    expect(new Set(Array.from({ length: 300 }, (_, i) => seatOf(i + 1, 12))).size).toBe(12);
    expect(otherSeat(7, 1, 0)).toBe(-1);
    expect(otherSeat(7, 5, -1)).toBe(-1);
  });

  it("keeps the count inside the brain short", async () => {
    const { coreCount } = await import("../lib/live-picture");
    expect(coreCount(0)).toBe("0");
    expect(coreCount(9_999)).toBe("9,999");
    expect(coreCount(12_345)).toBe("12.3K");
    expect(coreCount(2_500_000)).toBe("2.5M");
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
    const { LIVE_WINDOW_HOURS, LIVE_DOTS_MAX, LIVE_BEATS_MAX, LIVE_CACHE_MS, LIVE_PEOPLE_FLOOR, LIVE_PEOPLE_STEP_MINUTES, LIVE_PEOPLE_SLACK_MINUTES } =
      await import("../lib/live-brain");
    const spec = read("docs/spec.md");
    expect(spec).toContain("## Live Brain page");
    expect(spec).toContain(`\`LIVE_PEOPLE_FLOOR\` (${LIVE_PEOPLE_FLOOR})`);
    expect(spec).toContain(`\`LIVE_PEOPLE_STEP_MINUTES\` (${LIVE_PEOPLE_STEP_MINUTES})`);
    expect(spec).toContain(`\`LIVE_PEOPLE_SLACK_MINUTES\` (${LIVE_PEOPLE_SLACK_MINUTES})`);
    expect(spec).toContain(`\`LIVE_WINDOW_HOURS\` (${LIVE_WINDOW_HOURS})`);
    expect(spec).toContain(`\`LIVE_DOTS_MAX\` (${LIVE_DOTS_MAX})`);
    expect(spec).toContain(`\`LIVE_BEATS_MAX\` (${LIVE_BEATS_MAX})`);
    expect(spec).toContain(`\`LIVE_CACHE_MS\` (${LIVE_CACHE_MS / 1000} seconds)`);
    const { REPLAY_MAX, POLL_MS } = await import("../app/live/LiveBrain");
    expect(spec).toContain(`at most ${REPLAY_MAX} beats`);
    expect(spec).toContain(`every ${POLL_MS / 1000} seconds`);
    const { LOOP_PAUSE_MS } = await import("../app/live/LiveBrain");
    expect(spec).toContain(`\`LOOP_PAUSE_MS\` (${LOOP_PAUSE_MS / 1000} seconds)`);
  });

  it("loops the picture: the beats it plays again are the last hour, else the latest of the window", async () => {
    const { loopBeats, REPLAY_MAX } = await import("../app/live/LiveBrain");
    const now = Date.parse("2026-01-01T12:00:00Z");
    const beat = (id: number, minutesAgo: number) => ({ id, kind: "search" as const, at: new Date(now - minutesAgo * 60_000).toISOString(), memory: null });
    // Busy last hour: the newest REPLAY_MAX of it, oldest first, and nothing older.
    const busy = [beat(1, 300), ...Array.from({ length: 9 }, (_, i) => beat(10 + i, 50 - i * 5))];
    const played = loopBeats(busy, now);
    expect(played).toHaveLength(REPLAY_MAX);
    expect(played.map((b) => b.id)).toEqual(busy.slice(-REPLAY_MAX).map((b) => b.id));
    expect(played.every((b) => now - Date.parse(b.at) < 3_600_000)).toBe(true);
    // Quiet hour: it still has something to play, the latest beats of the window.
    const quiet = [beat(1, 600), beat(2, 400), beat(3, 300)];
    expect(loopBeats(quiet, now).map((b) => b.id)).toEqual([1, 2, 3]);
    // No beats, nothing to loop.
    expect(loopBeats([], now)).toEqual([]);
  });
});
