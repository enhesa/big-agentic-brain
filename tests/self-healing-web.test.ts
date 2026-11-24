import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Self-healing memory on its surfaces (docs/spec.md "Self-healing memory"): migration v60, GET
 * /api/checks/mine, POST /api/learnings/:id/recheck, the review page's "Waiting for you" and its
 * buttons (POST /memory/[id]/recheck), bab_react recheck and check_by, bab_search waitingForMe and
 * freshness, flag evidence over MCP, the hook lines, and the usage report. The rules themselves are
 * in tests/self-healing.test.ts.
 */

let dataDir: string;
const ORIGIN = "https://bab.example.com";
const AUTHOR = "ada.author@example.com";
const BOB = "bob.b@example.com";
const MAINT = "mia.m@example.com";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-self-healing-web-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = ORIGIN;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  process.env.BAB_MAINTAINERS = MAINT;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_PUBLIC_ORIGIN;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  delete process.env.BAB_MAINTAINERS;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

/**
 * A fresh module graph in the middle of a test. The open database handle is closed first: the old
 * graph would keep it, and Windows cannot delete the data directory under an open handle.
 */
async function freshModules() {
  (await import("../lib/db"))._resetDbForTests();
  vi.resetModules();
}

function asAgent(email: string) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": email.split("@")[0] }),
  }));
}

function noIdentity() {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:4310" }) }));
}

/** Signed in on the web as Bob, through the sign-in proxy, and linked to BOB. */
async function bobOnWeb() {
  vi.doMock("next/headers", () => ({
    headers: async () =>
      new Headers({ host: "localhost:4310", "x-auth-request-user": "proxy-bob", "x-auth-request-email": "bbob@example.com", "x-auth-request-preferred-username": "Bob B" }),
  }));
  const { linkForTests } = await import("./link-helper");
  await linkForTests("proxy-bob", BOB);
}

async function users() {
  const { upsertUser } = await import("../lib/users");
  for (const id of [AUTHOR, BOB, MAINT]) upsertUser({ id, email: id, name: id.split("@")[0], roles: [] });
}

async function db() {
  return (await import("../lib/db")).getDb();
}

let seq = 0;
async function mk(over: Record<string, unknown> = {}, authorId = BOB) {
  await users();
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({ authorId, title: `Refund limit fixture ${seq} zqw${seq}`, body: `Refunds up to 50 are automatic zqw${seq}x`, confirmNotDuplicate: true, ...over });
}

/** A decision past its 180-day window that agents still read: due a person's check by its author. */
async function dueDecision(authorId = BOB) {
  const m = await mk({ kind: "decision" }, authorId);
  (await db())
    .prepare("UPDATE learnings SET created_at = datetime('now', '-200 days'), access_days = 3, last_accessed_at = datetime('now', '-2 days') WHERE id = ?")
    .run(m.id);
  return m;
}

async function rpc(name: string, args: Record<string, unknown>, as = BOB) {
  asAgent(as);
  const { POST } = await import("../app/mcp/route");
  const res = await POST(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const out = await res.json();
  return { isError: out.result?.isError === true, text: out.result.content[0].text as string, json: () => JSON.parse(out.result.content[0].text) };
}

describe("migration v60", () => {
  it("adds the columns and tables, sets person on decisions and standards, backfills checked_at, and re-runs cleanly", async () => {
    await users();
    const { create, confirm } = await import("../lib/learnings");
    const d = create({ authorId: AUTHOR, kind: "decision", title: "We use monthly billing zqmig1", body: "Decided in the board zqmig1", confirmNotDuplicate: true });
    const l = create({ authorId: AUTHOR, title: "The build needs Node 24 zqmig2", body: "Older Node fails zqmig2", confirmNotDuplicate: true });
    confirm(l.id, BOB, "Checked package.json engines", "mcp");
    const conn = await db();
    // Legacy data: the decision is far older than its 180-day window and agents still read it.
    conn
      .prepare("UPDATE learnings SET created_at = datetime('now', '-400 days'), access_days = 5, last_accessed_at = datetime('now', '-1 days') WHERE id = ?")
      .run(d.id);
    // Back to v59: the columns are gone, and the confirm is only a vote.
    conn.exec("DROP TABLE check_asks; DROP TABLE freshness_daily");
    for (const c of ["check_by", "check_every_days", "checked_at", "disputed_at", "dispute_kind"]) conn.exec(`ALTER TABLE learnings DROP COLUMN ${c}`);
    conn.exec("ALTER TABLE trust_events DROP COLUMN evidence");
    conn.prepare("DELETE FROM migrations WHERE version = 60").run();
    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();

    const again = await db();
    expect(again.prepare("SELECT 1 AS ok FROM migrations WHERE version = 60").get()).toBeTruthy();
    const row = (id: string) => again.prepare("SELECT check_by, checked_at, dispute_kind FROM learnings WHERE id = ?").get(id) as Record<string, unknown>;
    expect(row(d.id).check_by).toBe("person");
    // An old business fact starts its clock at the upgrade: nothing is due a person's check on day one.
    expect(row(d.id).checked_at).toBeTruthy();
    const { freshnessFor } = await import("../lib/freshness");
    expect(freshnessFor([d.id]).get(d.id)).toMatchObject({ freshness: "fresh", checkDue: false });
    const { waitingFor, takeHookChecks } = await import("../lib/checks");
    expect(waitingFor(AUTHOR)).toEqual([]);
    expect(takeHookChecks(AUTHOR)).toEqual([]);
    expect(row(l.id).check_by).toBe("agent");
    expect(row(l.id).checked_at).toBeTruthy();
    expect(row(l.id).dispute_kind).toBeNull();
    const cols = new Set((again.prepare("PRAGMA table_info(trust_events)").all() as Array<{ name: string }>).map((c) => c.name));
    expect(cols.has("evidence")).toBe(true);
    expect(again.prepare("SELECT COUNT(*) AS n FROM check_asks").get()).toEqual({ n: 0 });

    // Running it again changes nothing and does not fail: the clock it started is not moved again.
    again.prepare("UPDATE learnings SET checked_at = '2026-01-01 00:00:00' WHERE id = ?").run(d.id);
    again.prepare("DELETE FROM migrations WHERE version = 60").run();
    _resetDbForTests();
    const third = await db();
    expect(third.prepare("SELECT check_by, checked_at FROM learnings WHERE id = ?").get(d.id)).toEqual({ check_by: "person", checked_at: "2026-01-01 00:00:00" });
  });
});

describe("GET /api/checks/mine", () => {
  it("is a 401 without an identity", async () => {
    noIdentity();
    const { GET } = await import("../app/api/checks/mine/route");
    expect((await GET(new Request(`${ORIGIN}/api/checks/mine`))).status).toBe(401);
  });

  it("lists what waits for the caller, with the text and the link, and nothing for someone else", async () => {
    const m = await dueDecision();
    asAgent(BOB);
    const { GET } = await import("../app/api/checks/mine/route");
    const body = await (await GET(new Request(`${ORIGIN}/api/checks/mine`))).json();
    expect(body.total).toBe(1);
    expect(body.checks[0]).toMatchObject({ id: m.id, kind: "decision", own: true, reason: "due", url: `${ORIGIN}/memory/${m.id}` });
    expect(body.checks[0].text).toContain("Refunds up to 50");
    expect(body.answers).toEqual(["yes", "no", "unsure", "agent", "later"]);

    await freshModules();
    asAgent(MAINT);
    const other = await (await (await import("../app/api/checks/mine/route")).GET(new Request(`${ORIGIN}/api/checks/mine`))).json();
    expect(other.total).toBe(0);
  });
});

describe("POST /api/learnings/:id/recheck", () => {
  async function post(id: string, body: unknown, as: string) {
    asAgent(as);
    const { POST } = await import("../app/api/learnings/[id]/recheck/route");
    return POST(new Request(`${ORIGIN}/x`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as never, {
      params: Promise.resolve({ id }),
    });
  }

  it("refuses an unknown answer and a colleague's Yes without a note", async () => {
    const m = await mk({ kind: "decision" });
    expect((await post(m.id, { answer: "maybe" }, MAINT)).status).toBe(400);
    await freshModules();
    expect((await post(m.id, { answer: "yes" }, MAINT)).status).toBe(400);
  });

  it("takes the author's Yes twice, then a 409, and a No marks it disputed", async () => {
    const m = await mk({ kind: "decision" });
    // Someone else uses it, so there is a colleague to hand the next check to.
    (await import("../lib/learnings")).vote(m.id, MAINT, "helpful", "mcp");
    expect((await post(m.id, { answer: "yes" }, BOB)).status).toBe(200);
    await freshModules();
    expect((await post(m.id, { answer: "yes" }, BOB)).status).toBe(200);
    await freshModules();
    expect((await post(m.id, { answer: "yes" }, BOB)).status).toBe(409);
    await freshModules();
    const no = await post(m.id, { answer: "no", note: "The limit is 25 now" }, MAINT);
    expect(no.status).toBe(200);
    expect((await no.json()).learning.dispute_kind).toBe("no");
  });

  it("is a 404 on an unknown memory", async () => {
    await users();
    expect((await post("nope", { answer: "later" }, BOB)).status).toBe(404);
  });
});

describe("Waiting for you on /memory/review", () => {
  async function render(query: Record<string, string> = {}) {
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: ReviewPage } = await import("../app/memory/review/page");
    const node = await ReviewPage({ searchParams: Promise.resolve(query) });
    return new Response(await renderToReadableStream(node as never)).text();
  }

  async function answer(id: string, fields: Record<string, string>, origin = ORIGIN) {
    const { POST } = await import("../app/memory/[id]/recheck/route");
    return POST(
      new Request(`${ORIGIN}/memory/${id}/recheck`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "bab.example.com", origin },
        body: new URLSearchParams(fields).toString(),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("shows a non-maintainer the exact text and the five answers, and a fixed message after an answer", async () => {
    const m = await dueDecision();
    await bobOnWeb();
    const html = await render({ check: "later" });
    expect(html).toContain("Waiting for you (1)");
    expect(html).toContain("Refunds up to 50 are automatic");
    expect(html).toContain(`/memory/${m.id}/recheck`);
    for (const label of ["Yes, still true", "No", "Not sure", "Let agents check this", "Ask me later"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("BAB will not ask about it again for 7 days.");
    expect(await render({ check: "<b>pwned</b>" })).not.toContain("pwned");
  });

  it("records an answer from the buttons and redirects back with a code", async () => {
    const m = await dueDecision();
    await bobOnWeb();
    const res = await answer(m.id, { answer: "yes", note: "" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/memory/review?check=yes#waiting");
    const { trustHistory } = await import("../lib/trust");
    expect(trustHistory(m.id).map((e) => e.kind)).toContain("recheck_yes");
    expect((await answer(m.id, { answer: "nope" })).headers.get("location")).toContain("check=invalid");
  });

  it("refuses a cross-site post and someone not signed in", async () => {
    const m = await dueDecision();
    await bobOnWeb();
    expect((await answer(m.id, { answer: "yes" }, "https://evil.example.com")).status).toBe(403);
    await freshModules();
    noIdentity();
    expect((await answer(m.id, { answer: "yes" })).status).toBe(404);
  });
});

describe("MCP", () => {
  it("bab_search waitingForMe returns the checks and how to answer them", async () => {
    const m = await dueDecision();
    const out = (await rpc("bab_search", { waitingForMe: true })).json();
    expect(out.results.map((c: { id: string }) => c.id)).toEqual([m.id]);
    expect(out.recheckHint).toContain("bab_react recheck");
  });

  it("bab_search results carry freshness and the due hint", async () => {
    const m = await dueDecision();
    const out = (await rpc("bab_search", { query: "refund limit fixture" }, MAINT)).json();
    const hit = out.results.find((r: { id: string }) => r.id === m.id);
    expect(hit).toMatchObject({ freshness: "due", checkBy: "person", checkDue: true });
    expect(out.checkDueHint).toBeTruthy();
  });

  it("bab_react recheck and check_by change the memory, and a flag keeps its evidence", async () => {
    const m = await mk({ kind: "decision" });
    const yes = await rpc("bab_react", { learningId: m.id, action: "recheck", answer: "yes" });
    expect(yes.isError).toBe(false);
    await freshModules();
    const handed = (await rpc("bab_react", { learningId: m.id, action: "check_by", checkBy: "agent" })).json();
    expect(handed.learning.check_by).toBe("agent");

    await freshModules();
    const t = await mk();
    const flagged = await rpc(
      "bab_react",
      { learningId: t.id, action: "flag", note: "the script is gone", evidence: { failure: "path_missing", tried: "ls scripts/x.sh", saw: "No such file", where: "app repo, main" } },
      MAINT,
    );
    expect(flagged.isError).toBe(false);
    const { trustHistory } = await import("../lib/trust");
    const ev = trustHistory(t.id).find((e) => e.kind === "flag")!;
    expect(ev.evidence).toMatchObject({ failure: "path_missing", where: "app repo, main" });
  });

  it("bab_react recheck refuses an answer it does not know", async () => {
    const m = await mk({ kind: "decision" });
    const out = await rpc("bab_react", { learningId: m.id, action: "recheck", answer: "maybe" });
    expect(out.isError).toBe(true);
  });
});

describe("hook lines", () => {
  async function prompt(sessionId: string) {
    const { POST } = await import("../app/api/hook/route");
    const res = await POST(
      new Request(`${ORIGIN}/api/hook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId }),
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { hookSpecificOutput?: { additionalContext?: string } };
    return (out.hookSpecificOutput?.additionalContext ?? "").split(/\r?\n/);
  }

  async function link(sessionId: string, ownerId: string) {
    const { mintOrReuseLinkToken, redeemLinkToken } = await import("../lib/session-links");
    redeemLinkToken(mintOrReuseLinkToken(sessionId), ownerId);
  }

  it("names the due memories once a session, titles and links only, and records the ask", async () => {
    const m = await dueDecision();
    await link("sess-check-1", BOB);
    const first = (await prompt("sess-check-1")).filter((l) => l.includes("Is this still true?"));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain(`${ORIGIN}/memory/${m.id}`);
    expect(first[0]).not.toContain("Refunds up to 50");
    expect((await prompt("sess-check-1")).some((l) => l.includes("Is this still true?"))).toBe(false);
    const asks = async () =>
      (await db()).prepare("SELECT via, COUNT(*) AS n FROM check_asks WHERE learning_id = ? GROUP BY via").all(m.id) as Array<{ via: string; n: number }>;
    // Named, not asked yet: a session with no person in it reads this line too.
    expect(first[0]).toContain("No person in this session");
    expect(await asks()).toEqual([{ via: "nudge", n: 1 }]);
    // The agent fetches the texts to ask the person: now it is a delivered ask.
    await freshModules();
    const out = (await rpc("bab_search", { waitingForMe: true })).json();
    expect(out.results.map((c: { id: string }) => c.id)).toEqual([m.id]);
    expect(await asks()).toEqual([{ via: "hook", n: 1 }]);
  });

  it("tells the author once when a colleague's agent replaced their memory", async () => {
    const old = await mk({}, AUTHOR);
    const { createWithSupersedes } = await import("../lib/learnings");
    const fix = createWithSupersedes({ authorId: BOB, title: "Refund limit is 25 now zqfix", body: "Changed in the policy zqfix", confirmNotDuplicate: true }, [old.id], "mcp");
    await link("sess-sup-1", AUTHOR);
    const said = (await prompt("sess-sup-1")).filter((l) => l.includes("replaced your memory"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`/memory/${fix.id}`);
    await link("sess-sup-2", AUTHOR);
    expect((await prompt("sess-sup-2")).some((l) => l.includes("replaced your memory"))).toBe(false);
  });
});

describe("the usage report", () => {
  it("carries the unchecked serve rate from searches", async () => {
    await dueDecision();
    await rpc("bab_search", { query: "refund limit fixture" }, MAINT);
    const { usageReport } = await import("../lib/usage");
    const f = usageReport().freshness;
    expect(f.served).toBeGreaterThanOrEqual(1);
    expect(f.unchecked).toBeGreaterThanOrEqual(1);
    expect(f.rate).toBeGreaterThan(0);
  });
});
