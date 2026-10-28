import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The vote and comment forms on a memory's page: POST /memory/[id]/react,
 * POST /memory/[id]/comments/[commentId] and the panel that posts to them.
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
  delete process.env.BAB_MAINTAINERS;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

const ALICE = "alice.a@example.com";
const BOB = "bob.b@example.com";

let current: Record<string, string> = {};
/** The SSO headers of Alice's or Bob's browser (short alias), or of nobody. Mutable: the mock reads it per call. */
function signedIn(as: "alice" | "bob" | "nobody") {
  current =
    as === "alice"
      ? { host: "localhost:4310", "x-auth-request-user": "proxy-alice", "x-auth-request-email": "aalice@example.com", "x-auth-request-preferred-username": "Alice A" }
      : as === "bob"
        ? { host: "localhost:4310", "x-auth-request-user": "proxy-bob", "x-auth-request-email": "bbob@example.com", "x-auth-request-preferred-username": "Bob B" }
        : { host: "localhost:4310" };
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
}

async function linkAlice() {
  const { linkForTests } = await import("./link-helper");
  await linkForTests("proxy-alice", ALICE);
}

async function linkBob() {
  const { linkForTests } = await import("./link-helper");
  await linkForTests("proxy-bob", BOB);
}

async function seed(authorId = BOB) {
  const { upsertUser } = await import("../lib/users");
  for (const id of [ALICE, BOB]) upsertUser({ id, email: id, name: id === ALICE ? "Alice A" : "Bob B", roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId, title: "Kiosk gotcha red", body: "The red kiosk drops sessions after a deploy." });
}

function post(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const json = headers["content-type"] === "application/json";
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:4310", origin: "http://localhost:4310", ...headers },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
  });
}

async function react(id: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const { POST } = await import("../app/memory/[id]/react/route");
  return POST(post(`http://localhost:4310/memory/${id}/react`, fields, headers), { params: Promise.resolve({ id }) });
}

async function change(id: string, commentId: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const { POST } = await import("../app/memory/[id]/comments/[commentId]/route");
  return POST(post(`http://localhost:4310/memory/${id}/comments/${commentId}`, fields, headers), {
    params: Promise.resolve({ id, commentId }),
  });
}

async function votesOf(id: string) {
  const { getDb } = await import("../lib/db");
  return getDb().prepare("SELECT voter_id, kind, note FROM votes WHERE learning_id = ? ORDER BY kind").all(id) as Array<{
    voter_id: string;
    kind: string;
    note: string | null;
  }>;
}

async function commentsOf(id: string) {
  const { getDb } = await import("../lib/db");
  return getDb()
    .prepare("SELECT id, author_id, body, edited_at, deleted_at FROM memory_comments WHERE learning_id = ? ORDER BY rowid")
    .all(id) as Array<{ id: string; author_id: string; body: string; edited_at: string | null; deleted_at: string | null }>;
}

async function renderDetail(id: string, query: { react?: string; edit?: string } = {}) {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const { default: DetailPage } = await import("../app/memory/[id]/page");
  const node = await DetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) });
  return new Response(await renderToReadableStream(node as never)).text();
}

const location = (res: Response) => res.headers.get("location");

/** Uses up the viewer's UI rate-limit bucket for this minute (the same module instance the routes use). */
async function limited(ownerId = ALICE) {
  const { checkUiRateLimit, UI_RATE_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
  for (let i = 0; i < UI_RATE_LIMIT_PER_MINUTE; i++) checkUiRateLimit(ownerId);
}

describe("POST /memory/[id]/react: votes", () => {
  it("records a helpful vote from a linked browser, audited via ui, with no agent read", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const res = await react(l.id, { action: "helpful" });
    expect(res.status).toBe(303);
    expect(location(res)).toBe(`http://localhost:4310/memory/${l.id}?react=done#comments`);
    expect(await votesOf(l.id)).toEqual([{ voter_id: ALICE, kind: "helpful", note: null }]);
    expect(await commentsOf(l.id)).toEqual([]);

    const { getDb } = await import("../lib/db");
    const audit = getDb().prepare("SELECT actor_id, via FROM audit_log WHERE action = 'helpful' AND entity_id = ?").all(l.id);
    expect(audit).toEqual([{ actor_id: ALICE, via: "ui" }]);
    const { getById } = await import("../lib/learnings");
    const after = getById(l.id)!;
    expect(after.score).toBe(1);
    expect(after.access_days).toBe(0);
    expect(after.last_accessed_at).toBeNull();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM reuse_costs").get()).toEqual({ n: 0 });
  });

  it("keeps one vote per person: a repeat changes nothing, the other button switches it", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    await react(l.id, { action: "helpful" });
    const repeat = await react(l.id, { action: "helpful" });
    expect(location(repeat)).toContain("?react=same");
    await react(l.id, { action: "not_helpful" });
    expect(await votesOf(l.id)).toEqual([{ voter_id: ALICE, kind: "not_helpful", note: null }]);
    const { getById } = await import("../lib/learnings");
    expect(getById(l.id)!.score).toBe(-1);
  });

  it("no longer takes kudos from the page: kudos stays with agents", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    expect(location(await react(l.id, { action: "kudos", note: "thanks" }))).toContain("?react=invalid");
    expect(await votesOf(l.id)).toEqual([]);
  });

  it("answers a JSON caller with JSON", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const ok = await react(l.id, { action: "helpful" }, { "content-type": "application/json" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, action: "helpful", changed: true });
    const own = await react("no-such-id", { action: "helpful" }, { "content-type": "application/json" });
    expect(own.status).toBe(404);
  });

  it("refuses a vote on your own memory, with or without a comment", async () => {
    signedIn("alice");
    const l = await seed(ALICE);
    await linkAlice();
    for (const action of ["helpful", "not_helpful"]) {
      expect(location(await react(l.id, { action, body: "mine" }))).toContain("?react=own");
    }
    expect(await votesOf(l.id)).toEqual([]);
    expect(await commentsOf(l.id)).toEqual([]);
    const json = await react(l.id, { action: "helpful" }, { "content-type": "application/json" });
    expect(json.status).toBe(403);
  });

  it("answers an unlinked JSON caller with 401 and linkRequired", async () => {
    signedIn("alice");
    const l = await seed();
    const res = await react(l.id, { action: "helpful" }, { "content-type": "application/json" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ linkRequired: true });
  });

  it("refuses a deleted memory and hides the panel on it", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const { deleteOwn } = await import("../lib/learnings");
    deleteOwn(l.id, BOB);
    expect(location(await react(l.id, { action: "helpful" }))).toContain("?react=gone");
    expect(location(await react(l.id, { action: "comment", body: "late" }))).toContain("?react=gone");
    expect(await votesOf(l.id)).toEqual([]);
    expect(await commentsOf(l.id)).toEqual([]);
    const html = await renderDetail(l.id);
    expect(html).not.toContain("Did this help you?");
    expect(html).not.toContain('id="comments"');
  });

  it("sends an unlinked browser to link first and records nothing", async () => {
    signedIn("alice");
    const l = await seed();
    const res = await react(l.id, { action: "comment", body: "hello" });
    expect(location(res)).toBe(`http://localhost:4310/memory/${l.id}?react=link#comments`);
    expect(await commentsOf(l.id)).toEqual([]);
  });

  it("does not take agent headers as a viewer", async () => {
    current = { host: "localhost:4310", "x-bab-actor-email": ALICE, "x-bab-actor-name": "Alice A" };
    vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
    const l = await seed();
    const res = await react(l.id, { action: "comment", body: "hello" });
    expect(location(res)).toContain("?react=link");
    expect(await commentsOf(l.id)).toEqual([]);
  });

  it("refuses a cross-site post and a post without an Origin", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    expect((await react(l.id, { action: "comment", body: "x" }, { origin: "https://evil.example.com" })).status).toBe(403);
    const { POST } = await import("../app/memory/[id]/react/route");
    const noOrigin = new Request(`http://localhost:4310/memory/${l.id}/react`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:4310" },
      body: "action=comment&body=x",
    });
    expect((await POST(noOrigin, { params: Promise.resolve({ id: l.id }) })).status).toBe(403);
    expect(await commentsOf(l.id)).toEqual([]);
  });

  it("refuses actions the page does not offer, and unknown memories", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    for (const action of ["flag", "confirm", "retire", "keep", "delete", "kudos", ""]) {
      expect(location(await react(l.id, { action, note: "evidence" }))).toContain("?react=invalid");
    }
    expect(await votesOf(l.id)).toEqual([]);
    expect(location(await react("no-such-id", { action: "helpful" }))).toContain("?react=gone");
    const bad = await react(l.id, { action: "nope" }, { "content-type": "application/json" });
    expect(bad.status).toBe(400);
  });

  it("stops at the UI rate limit", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    await limited();
    expect(location(await react(l.id, { action: "comment", body: "x" }))).toContain("?react=slow");
    const json = await react(l.id, { action: "helpful" }, { "content-type": "application/json" });
    expect(json.status).toBe(429);
    expect(await commentsOf(l.id)).toEqual([]);
  });
});

describe("POST /memory/[id]/react: comments", () => {
  it("posts a comment, trimmed and redacted, audited via ui", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const secret = ["pass", "word: ", "hunter2", "hunter2"].join("");
    const res = await react(l.id, { action: "comment", body: `  Worked on the blue kiosk too. ${secret}  ` });
    const [c] = await commentsOf(l.id);
    expect(location(res)).toBe(`http://localhost:4310/memory/${l.id}?react=commented#comment-${c.id}`);
    expect(c.author_id).toBe(ALICE);
    expect(c.body.startsWith("Worked on the blue kiosk too.")).toBe(true);
    expect(c.body).not.toContain("hunter2hunter2");
    expect(await votesOf(l.id)).toEqual([]);
    const { getDb } = await import("../lib/db");
    expect(
      getDb().prepare("SELECT actor_id, entity, via, json_extract(details, '$.learningId') AS lid FROM audit_log WHERE action = 'comment'").all(),
    ).toEqual([{ actor_id: ALICE, entity: "memory_comment", via: "ui", lid: l.id }]);
  });

  it("lets the memory's author comment on it", async () => {
    signedIn("alice");
    const l = await seed(ALICE);
    await linkAlice();
    expect(location(await react(l.id, { action: "comment", body: "Still true in October." }))).toContain("?react=commented");
    expect(await commentsOf(l.id)).toHaveLength(1);
  });

  it("records a vote and a comment from one click: two records", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const res = await react(l.id, { action: "helpful", body: "Saved me an hour." });
    expect(location(res)).toContain("?react=voted-commented");
    expect(await votesOf(l.id)).toEqual([{ voter_id: ALICE, kind: "helpful", note: null }]);
    expect((await commentsOf(l.id)).map((c) => c.body)).toEqual(["Saved me an hour."]);
    // A blank comment box with a vote is just the vote.
    const blank = await react(l.id, { action: "not_helpful", body: "   " });
    expect(location(blank)).toContain("?react=done");
    expect(await commentsOf(l.id)).toHaveLength(1);
  });

  it("refuses an empty or too long comment, and then records no vote either", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    expect(location(await react(l.id, { action: "comment", body: "   " }))).toContain("?react=empty");
    expect(location(await react(l.id, { action: "comment" }))).toContain("?react=empty");
    expect(location(await react(l.id, { action: "helpful", body: "x".repeat(2001) }))).toContain("?react=long");
    expect(await votesOf(l.id)).toEqual([]);
    expect(await commentsOf(l.id)).toEqual([]);
    const json = await react(l.id, { action: "comment", body: "x".repeat(2001) }, { "content-type": "application/json" });
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({ error: "comment must be 2000 characters or fewer" });
  });

  it("answers a JSON comment with its id", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const res = await react(l.id, { action: "helpful", body: "Good one" }, { "content-type": "application/json" });
    const [c] = await commentsOf(l.id);
    expect(await res.json()).toEqual({ ok: true, action: "helpful", changed: true, commentId: c.id });
  });

  it("stops at the daily comment limit, before the vote", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const { getDb } = await import("../lib/db");
    const { MEMORY_COMMENT_DAILY_LIMIT } = await import("../lib/memory-comments");
    const insert = getDb().prepare("INSERT INTO memory_comments (id, learning_id, author_id, body) VALUES (?, ?, ?, 'x')");
    for (let i = 0; i < MEMORY_COMMENT_DAILY_LIMIT; i++) insert.run(`c${i}`, l.id, ALICE);
    expect(location(await react(l.id, { action: "helpful", body: "one more" }))).toContain("?react=limit");
    expect(await votesOf(l.id)).toEqual([]);
  });
});

describe("POST /memory/[id]/comments/[commentId]", () => {
  async function aliceComment() {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    await linkBob();
    await react(l.id, { action: "comment", body: "First take." });
    const [c] = await commentsOf(l.id);
    return { l, c };
  }

  it("lets the author edit their comment, marked edited and audited", async () => {
    const { l, c } = await aliceComment();
    const res = await change(l.id, c.id, { action: "edit", body: "  Second take.  " });
    expect(location(res)).toBe(`http://localhost:4310/memory/${l.id}?react=edited#comment-${c.id}`);
    const [after] = await commentsOf(l.id);
    expect(after.body).toBe("Second take.");
    expect(after.edited_at).not.toBeNull();
    const same = await change(l.id, c.id, { action: "edit", body: "Second take." }, { "content-type": "application/json" });
    expect(await same.json()).toEqual({ ok: true, action: "edit", changed: false });
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'comment_edit' AND entity_id = ?").get(c.id)).toEqual({ n: 1 });
    expect(location(await change(l.id, c.id, { action: "edit", body: "" }))).toContain("?react=empty");
  });

  it("lets the author delete their comment: soft, body blanked, shown as removed", async () => {
    const { l, c } = await aliceComment();
    expect(location(await change(l.id, c.id, { action: "delete" }))).toContain("?react=removed");
    const [after] = await commentsOf(l.id);
    expect(after.deleted_at).not.toBeNull();
    expect(after.body).toBe("");
    const html = await renderDetail(l.id);
    expect(html).toContain("Comment removed");
    expect(html).not.toContain("First take.");
    // A removed comment can be neither edited nor removed again.
    expect(location(await change(l.id, c.id, { action: "edit", body: "back" }))).toContain("?react=gone");
    expect(location(await change(l.id, c.id, { action: "delete" }))).toContain("?react=gone");
  });

  it("refuses someone else's edit or delete", async () => {
    const { l, c } = await aliceComment();
    signedIn("bob");
    expect(location(await change(l.id, c.id, { action: "edit", body: "hijack" }))).toContain("?react=not-yours");
    expect(location(await change(l.id, c.id, { action: "delete" }))).toContain("?react=not-yours");
    const [after] = await commentsOf(l.id);
    expect(after.body).toBe("First take.");
    expect(after.deleted_at).toBeNull();
    const json = await change(l.id, c.id, { action: "delete" }, { "content-type": "application/json" });
    expect(json.status).toBe(403);
  });

  it("lets a maintainer delete anyone's comment, but not edit it", async () => {
    process.env.BAB_MAINTAINERS = BOB;
    const { l, c } = await aliceComment();
    signedIn("bob");
    expect(location(await change(l.id, c.id, { action: "edit", body: "rewrite" }))).toContain("?react=not-yours");
    expect(location(await change(l.id, c.id, { action: "delete" }))).toContain("?react=removed");
    const { getDb } = await import("../lib/db");
    const row = getDb()
      .prepare("SELECT actor_id, json_extract(details, '$.authorId') AS author FROM audit_log WHERE action = 'comment_delete'")
      .get();
    expect(row).toEqual({ actor_id: BOB, author: ALICE });
  });

  it("refuses a comment id from another memory, unknown actions, cross-site posts and unlinked browsers", async () => {
    const { l, c } = await aliceComment();
    const { create } = await import("../lib/learnings");
    const other = create({ authorId: BOB, title: "Printer tray jam blue", body: "The blue printer jams when the tray is half full." });
    expect(location(await change(other.id, c.id, { action: "delete" }))).toContain("?react=gone");
    expect(location(await change(l.id, c.id, { action: "pin" }))).toContain("?react=invalid");
    expect((await change(l.id, c.id, { action: "delete" }, { origin: "https://evil.example.com" })).status).toBe(403);
    expect((await change(l.id, c.id, { action: "pin" }, { "content-type": "application/json" })).status).toBe(400);
    signedIn("nobody");
    expect(location(await change(l.id, c.id, { action: "delete" }))).toContain("?react=link");
    expect((await change(l.id, c.id, { action: "delete" }, { "content-type": "application/json" })).status).toBe(401);
    expect((await commentsOf(l.id))[0].deleted_at).toBeNull();
  });

  it("stops at the UI rate limit", async () => {
    const { l, c } = await aliceComment();
    await limited();
    expect(location(await change(l.id, c.id, { action: "edit", body: "v2" }))).toContain("?react=slow");
    expect((await change(l.id, c.id, { action: "edit", body: "x" }, { "content-type": "application/json" })).status).toBe(429);
  });
});

describe("the comments panel on /memory/[id]", () => {
  it("shows the comment box and the vote buttons to a linked viewer, with their vote pressed", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const { vote } = await import("../lib/learnings");
    vote(l.id, ALICE, "not_helpful", "ui");
    const html = await renderDetail(l.id);
    expect(html).toContain(`action="/memory/${l.id}/react"`);
    expect(html).toContain('name="body"');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain("Post comment");
    expect(html).toMatch(/value="helpful" aria-pressed="false"/);
    expect(html).toMatch(/value="not_helpful" aria-pressed="true"/);
    expect(html).toContain("Did this help you?");
    // Kudos and the agent-only reactions are not offered.
    expect(html).not.toContain("Give kudos");
    expect(html).not.toMatch(/value="(kudos|flag|confirm|retire|keep)"/);
  });

  it("lists comments oldest first, as text, with author, edited mark and own Edit link", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const { addComment, editComment } = await import("../lib/memory-comments");
    const { getDb } = await import("../lib/db");
    const first = addComment(l.id, BOB, "<script>alert(1)</script> older", "mcp");
    getDb().prepare("UPDATE memory_comments SET created_at = datetime('now', '-2 hours') WHERE id = ?").run(first.id);
    const mine = addComment(l.id, ALICE, "newer one", "ui");
    editComment(l.id, mine.id, ALICE, "newer one, fixed", "ui");
    const html = await renderDetail(l.id);
    expect(html).toContain("Comments (2)");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; older");
    expect(html.indexOf("older")).toBeLessThan(html.indexOf("newer one, fixed"));
    expect(html).toContain("Bob B");
    expect(html).toContain(" · edited");
    expect(html).toContain(`href="/memory/${l.id}?edit=${mine.id}#comment-${mine.id}"`);
    expect(html).not.toContain(`?edit=${first.id}`);
    // Not a maintainer: no Delete on Bob's comment, one on Alice's own.
    expect(html.match(/value="delete"/g)).toHaveLength(1);
  });

  it("opens the edit box for your own comment only", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const { addComment } = await import("../lib/memory-comments");
    const mine = addComment(l.id, ALICE, "draft text", "ui");
    const theirs = addComment(l.id, BOB, "bob text", "ui");
    const html = await renderDetail(l.id, { edit: mine.id });
    expect(html).toContain("Edit your comment");
    expect(html).toContain(`action="/memory/${l.id}/comments/${mine.id}"`);
    expect(await renderDetail(l.id, { edit: theirs.id })).not.toContain("Edit your comment");
  });

  it("gives a maintainer a Delete button on every comment", async () => {
    process.env.BAB_MAINTAINERS = ALICE;
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    const { addComment } = await import("../lib/memory-comments");
    addComment(l.id, BOB, "bob text", "ui");
    const html = await renderDetail(l.id);
    expect(html).toContain("Delete this comment (maintainer)");
  });

  it("points an unlinked viewer at /me/devices", async () => {
    signedIn("alice");
    const l = await seed();
    const html = await renderDetail(l.id);
    expect(html).toContain('href="/me/devices"');
    expect(html).not.toContain(`action="/memory/${l.id}/react"`);
  });

  it("offers only the comment box on your own memory", async () => {
    signedIn("alice");
    const l = await seed(ALICE);
    await linkAlice();
    const html = await renderDetail(l.id);
    expect(html).toContain("This is your memory, so you cannot vote on it.");
    expect(html).toContain(`action="/memory/${l.id}/react"`);
    expect(html).not.toContain('value="helpful"');
  });

  it("shows the comments, read only, to a viewer who is not signed in", async () => {
    signedIn("nobody");
    const l = await seed();
    const { addComment } = await import("../lib/memory-comments");
    addComment(l.id, ALICE, "public context", "ui");
    const html = await renderDetail(l.id);
    expect(html).toContain("public context");
    expect(html).not.toContain("Did this help you?");
    expect(html).not.toContain(`action="/memory/${l.id}/react"`);
  });

  it("shows the fixed line for a known code and ignores any other text", async () => {
    signedIn("alice");
    const l = await seed();
    await linkAlice();
    expect(await renderDetail(l.id, { react: "commented" })).toContain("Thanks, your comment is posted.");
    const crafted = await renderDetail(l.id, { react: "<b>Click here</b>" });
    expect(crafted).not.toContain("Click here");
    expect(crafted).not.toContain('role="status"');
  });
});
