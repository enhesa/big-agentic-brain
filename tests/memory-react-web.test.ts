import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The reaction buttons on a memory's page: POST /memory/[id]/react and the panel that posts to it.
 * The viewer signs in with a short alias and is a person only once the browser is linked.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-memory-react-web-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";

let current: Record<string, string> = {};
/** The SSO headers of Alice's browser (short alias), or of nobody. */
function signedIn(as: "alice" | "nobody") {
  current =
    as === "alice"
      ? { host: "localhost:4310", "x-auth-request-user": "proxy-alice", "x-auth-request-email": "aalice@example.com", "x-auth-request-preferred-username": "Alice A" }
      : { host: "localhost:4310" };
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
}

async function linkAlice() {
  const { linkForTests } = await import("./link-helper");
  await linkForTests("proxy-alice", ALICE);
}

async function seed(authorId = BOB) {
  const { upsertUser } = await import("../lib/users");
  for (const id of [ALICE, BOB]) upsertUser({ id, email: id, name: null, roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId, title: "Kiosk gotcha red", body: "The red kiosk drops sessions after a deploy." });
}

function post(id: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:4310/memory/${id}/react`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:4310", origin: "http://localhost:4310", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function react(id: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const { POST } = await import("../app/memory/[id]/react/route");
  return POST(post(id, fields, headers), { params: Promise.resolve({ id }) });
}

async function votesOf(id: string) {
  const { getDb } = await import("../lib/db");
  return getDb().prepare("SELECT voter_id, kind, note FROM votes WHERE learning_id = ? ORDER BY kind").all(id) as Array<{
    voter_id: string;
    kind: string;
    note: string | null;
  }>;
}

async function renderDetail(id: string, react?: string) {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const { default: DetailPage } = await import("../app/memory/[id]/page");
  const node = await DetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(react ? { react } : {}) });
  return new Response(await renderToReadableStream(node as never)).text();
}

const location = (res: Response) => res.headers.get("location");

describe("POST /memory/[id]/react", () => {
  it("records a helpful vote from a linked browser, audited via ui, with no agent read", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const res = await react(l.id, { action: "helpful" });
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`http://localhost:4310/memory/${l.id}?react=done`);
    expect(await votesOf(l.id)).toEqual([{ voter_id: ALICE, kind: "helpful", note: null }]);

    const { getDb } = await import("../lib/db");
    const audit = getDb().prepare("SELECT actor_id, via FROM audit_log WHERE action = 'helpful' AND entity_id = ?").all(l.id);
    expect(audit).toEqual([{ actor_id: ALICE, via: "ui" }]);
    const { getById } = await import("../lib/learnings");
    const after = getById(l.id)!;
    expect(after.score).toBe(1);
    // "Last read by an agent" stays about agents.
    expect(after.access_days).toBe(0);
    expect(after.last_accessed_at).toBeNull();
    // No reuse cost: a web click is never a measured reuse.
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM reuse_costs").get()).toEqual({ n: 0 });
  });

  it("keeps one vote per person: a repeat changes nothing, the other button switches it", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    await react(l.id, { action: "helpful" });
    await react(l.id, { action: "helpful" });
    expect(await votesOf(l.id)).toEqual([{ voter_id: ALICE, kind: "helpful", note: null }]);
    await react(l.id, { action: "not_helpful" });
    expect(await votesOf(l.id)).toEqual([{ voter_id: ALICE, kind: "not_helpful", note: null }]);
    const { getById } = await import("../lib/learnings");
    expect(getById(l.id)!.score).toBe(-1);
  });

  it("gives kudos once, with a redacted note, and refuses a second", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const first = await react(l.id, { action: "kudos", note: "  Saved me an hour, password: hunter2hunter2  " });
    expect(location(first)).toContain("?react=done");
    const [row] = await votesOf(l.id);
    expect(row.kind).toBe("kudos");
    expect(row.note).not.toContain("hunter2hunter2");
    expect(row.note).toContain("Saved me an hour");

    const again = await react(l.id, { action: "kudos" });
    expect(location(again)).toContain("?react=kudos-given");
    expect(await votesOf(l.id)).toHaveLength(1);
  });

  it("answers a JSON caller with JSON", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const { POST } = await import("../app/memory/[id]/react/route");
    const req = new Request(`http://localhost:4310/memory/${l.id}/react`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:4310", origin: "http://localhost:4310" },
      body: JSON.stringify({ action: "kudos" }),
    });
    const ok = await POST(req.clone(), { params: Promise.resolve({ id: l.id }) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, action: "kudos" });
    const dup = await POST(req, { params: Promise.resolve({ id: l.id }) });
    expect(dup.status).toBe(409);
  });

  it("refuses a kudos note that is too long", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const res = await react(l.id, { action: "kudos", note: "x".repeat(501) });
    expect(location(res)).toContain("?react=note");
    expect(await votesOf(l.id)).toEqual([]);
  });

  it("refuses a reaction on your own memory", async () => {
    signedIn("alice");
    const l = await seed(ALICE);
    await linkAlice();
    for (const action of ["helpful", "not_helpful", "kudos"]) {
      expect(location(await react(l.id, { action }))).toContain("?react=own");
    }
    expect(await votesOf(l.id)).toEqual([]);
  });

  it("sends an unlinked browser to link first and records nothing", async () => {
    signedIn("alice");
    const l = await seed();
    const res = await react(l.id, { action: "helpful" });
    expect(location(res)).toBe(`http://localhost:4310/memory/${l.id}?react=link`);
    expect(await votesOf(l.id)).toEqual([]);
  });

  it("does not take agent headers as a viewer", async () => {
    current = { host: "localhost:4310", "x-bab-actor-email": ALICE, "x-bab-actor-name": "Alice A" };
    vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
    const l = await seed();
    const res = await react(l.id, { action: "helpful" });
    expect(location(res)).toContain("?react=link");
    expect(await votesOf(l.id)).toEqual([]);
  });

  it("refuses a cross-site post and a post without an Origin", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    expect((await react(l.id, { action: "helpful" }, { origin: "https://evil.example.com" })).status).toBe(403);
    const { POST } = await import("../app/memory/[id]/react/route");
    const noOrigin = new Request(`http://localhost:4310/memory/${l.id}/react`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:4310" },
      body: "action=helpful",
    });
    expect((await POST(noOrigin, { params: Promise.resolve({ id: l.id }) })).status).toBe(403);
    expect(await votesOf(l.id)).toEqual([]);
  });

  it("refuses actions the page does not offer, and unknown memories", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    for (const action of ["flag", "confirm", "retire", "keep", "delete", ""]) {
      expect(location(await react(l.id, { action, note: "evidence" }))).toContain("?react=invalid");
    }
    expect(await votesOf(l.id)).toEqual([]);
    expect(location(await react("no-such-id", { action: "helpful" }))).toContain("?react=gone");
  });
});

describe("the reaction panel on /memory/[id]", () => {
  it("shows the buttons to a linked viewer, with their current vote pressed", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const { vote } = await import("../lib/learnings");
    vote(l.id, ALICE, "not_helpful", "ui");
    const html = await renderDetail(l.id);
    expect(html).toContain(`action="/memory/${l.id}/react"`);
    expect(html).toMatch(/value="helpful" aria-pressed="false"/);
    expect(html).toMatch(/value="not_helpful" aria-pressed="true"/);
    expect(html).toContain("Give kudos");
    expect(html).toContain('maxLength="500"');
    // Agent-only reactions are not offered.
    expect(html).not.toMatch(/value="(flag|confirm|retire|keep)"/);
  });

  it("says kudos was given instead of offering it again", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const { giveKudos } = await import("../lib/learnings");
    giveKudos(l.id, ALICE, null, "ui");
    const html = await renderDetail(l.id);
    expect(html).toContain("You gave kudos on this memory.");
    expect(html).not.toContain("Give kudos");
  });

  it("points an unlinked viewer at /me/devices", async () => {
    signedIn("alice");
    const l = await seed();
    const html = await renderDetail(l.id);
    expect(html).toContain('href="/me/devices"');
    expect(html).not.toContain(`action="/memory/${l.id}/react"`);
  });

  it("shows no buttons on your own memory", async () => {
    signedIn("alice");
    const l = await seed(ALICE);
    await linkAlice();
    const html = await renderDetail(l.id);
    expect(html).toContain("This is your memory, so you cannot react to it.");
    expect(html).not.toContain(`action="/memory/${l.id}/react"`);
  });

  it("shows nothing to a viewer who is not signed in", async () => {
    signedIn("nobody");
    const l = await seed();
    const html = await renderDetail(l.id);
    expect(html).not.toContain("Did this help you?");
  });

  it("shows the fixed line for a known code and ignores any other text", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    expect(await renderDetail(l.id, "done")).toContain("Thanks, your reaction is saved.");
    const crafted = await renderDetail(l.id, "<b>Click here</b>");
    expect(crafted).not.toContain("Click here");
    expect(crafted).not.toContain('role="status"');
  });
});
