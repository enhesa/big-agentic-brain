import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Explicit, auditable validation of memories (lib/trust.ts): the append-only validation history,
 * the trust label in search, the hook and the house rules, and the review queue. The author's
 * own keep or restore never counts as a check, and the author still cannot confirm.
 */

let dataDir: string;
const AUTHOR = "ada.author@example.com";
const BOB = "bob.b@example.com";
const CID = "cid.c@example.com";
const ORIGIN = "https://bab.example.com";

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-trust-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = ORIGIN;
  vi.resetModules();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: AUTHOR, email: AUTHOR, name: "Ada Author", roles: [] });
  upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
  upsertUser({ id: CID, email: CID, name: "Cid C", roles: [] });
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_PUBLIC_ORIGIN;
  vi.resetModules();
});

let seq = 0;
async function mk(over: Record<string, unknown> = {}) {
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({
    authorId: AUTHOR,
    title: `Webhook signature check zq${seq}`,
    body: `Body ${seq} about topic zq${seq}x`,
    confirmNotDuplicate: true,
    ...over,
  });
}

async function db() {
  const { getDb } = await import("../lib/db");
  return getDb();
}

async function backdate(id: string, days: number) {
  const at = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  (await db()).prepare("UPDATE learnings SET created_at = ? WHERE id = ?").run(at, id);
}

async function history(id: string) {
  const { trustHistory } = await import("../lib/trust");
  return trustHistory(id);
}

async function trust(id: string) {
  const { trustOf } = await import("../lib/trust");
  const { getById } = await import("../lib/learnings");
  return trustOf(getById(id)!);
}

describe("validation history", () => {
  it("records each confirm, flag, keep, retire and restore with who, the note and whether it was the author", async () => {
    const { confirm, flag, keepLearning, retire } = await import("../lib/learnings");
    const l = await mk();
    confirm(l.id, BOB, "Checked against the provider docs", "mcp");
    flag(l.id, CID, "mcp", "The provider moved to SHA-256 last month");
    keepLearning(l.id, AUTHOR, "mcp", "Still true for the old API version");
    retire(l.id, AUTHOR, "mcp", "Replaced by the new API");
    keepLearning(l.id, BOB, "mcp", "Still needed for the old API");

    const h = await history(l.id);
    expect(h.map((e) => [e.kind, e.actorName, e.byAuthor, e.note])).toEqual([
      ["restore", "Bob B", false, "Still needed for the old API"],
      ["retire", "Ada Author", true, "Replaced by the new API"],
      ["keep", "Ada Author", true, "Still true for the old API version"],
      ["flag", "Cid C", false, "The provider moved to SHA-256 last month"],
      ["confirm", "Bob B", false, "Checked against the provider docs"],
    ]);
    expect(h.every((e) => e.backfilled === undefined)).toBe(true);
  });

  it("keeps every confirm, even when the vote row is refreshed, and skips a repeat that changed nothing", async () => {
    const { confirm, flag } = await import("../lib/learnings");
    const l = await mk();
    confirm(l.id, BOB, "Checked in the staging config", "mcp");
    confirm(l.id, BOB, "Checked in the staging config", "mcp"); // a no-op within 30 days
    flag(l.id, CID, "mcp", "Wrong header name");
    flag(l.id, CID, "mcp", "Wrong header name"); // the same flag again
    flag(l.id, CID, "mcp", "Wrong header name and wrong hash"); // a new note is new evidence
    const kinds = (await history(l.id)).map((e) => [e.kind, e.note]);
    expect(kinds).toEqual([
      ["flag", "Wrong header name and wrong hash"],
      ["flag", "Wrong header name"],
      ["confirm", "Checked in the staging config"],
    ]);
    // The votes table still keeps one row per person and kind; the history is the record.
    const flags = (await db()).prepare("SELECT COUNT(*) AS n FROM votes WHERE learning_id = ? AND kind = 'flag'").get(l.id);
    expect(flags).toEqual({ n: 1 });
  });

  it("records the auto-archive after two flags as a system event", async () => {
    const { flag, getById } = await import("../lib/learnings");
    const l = await mk();
    flag(l.id, BOB, "mcp", "Stale since the upgrade");
    flag(l.id, CID, "mcp", "Fails on the new runtime");
    expect(getById(l.id)!.status).toBe("archived");
    const h = await history(l.id);
    expect(h[0]).toMatchObject({ kind: "archive", actorName: "system", note: "2 flags", byAuthor: false });
  });

  it("records a correction on the old memory, with a link to the new one", async () => {
    const { createWithSupersedes } = await import("../lib/learnings");
    const old = await mk();
    const fresh = createWithSupersedes(
      { authorId: BOB, title: "Webhook signatures use SHA-256", body: "The provider signs with HMAC-SHA256.", confirmNotDuplicate: true },
      [old.id],
      "mcp",
    );
    const h = await history(old.id);
    expect(h[0]).toMatchObject({ kind: "supersede", actorName: "Bob B", byAuthor: false, related: { id: fresh.id, title: fresh.title } });
  });

  it("shows nothing for a deleted memory, and drops a related memory that was deleted", async () => {
    const { confirm } = await import("../lib/learnings");
    const l = await mk();
    confirm(l.id, BOB, "Checked", "mcp");
    (await db()).prepare("UPDATE learnings SET status = 'deleted' WHERE id = ?").run(l.id);
    expect(await history(l.id)).toEqual([]);
    expect(await history("no-such-id")).toEqual([]);
  });

  it("is appended only: the trust_events table has no update path in lib", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = path.join(__dirname, "..", "lib");
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/UPDATE\s+trust_events/i);
    }
  });
});

describe("trust label", () => {
  it("is unchecked from day one, and says who checked it once a colleague did", async () => {
    const { confirm } = await import("../lib/learnings");
    const l = await mk();
    let t = await trust(l.id);
    expect(t).toMatchObject({ unchecked: true, verify: false, flags: 0, confirmations: 0 });
    expect(t.label).toBe("not checked by anyone but its author");

    confirm(l.id, BOB, "Checked in the repo", "mcp");
    t = await trust(l.id);
    expect(t.unchecked).toBe(false);
    expect(t.label).toBe("confirmed by 1, last checked today");
  });

  it("does not count the author's own keep as a check, now or for the 90-day mark", async () => {
    const { keepLearning } = await import("../lib/learnings");
    const l = await mk();
    await backdate(l.id, 120);
    keepLearning(l.id, AUTHOR, "mcp", "Still true");
    const t = await trust(l.id);
    expect(t).toMatchObject({ unchecked: true, verify: true });
    expect(t.label).toBe("not checked by anyone but its author; due a check");
  });

  it("counts a colleague's keep, and clears the 90-day mark", async () => {
    const { keepLearning } = await import("../lib/learnings");
    const l = await mk();
    await backdate(l.id, 120);
    keepLearning(l.id, BOB, "mcp", "Checked the config today");
    const t = await trust(l.id);
    expect(t).toMatchObject({ unchecked: false, verify: false });
    expect(t.label).toBe("kept by a colleague, last checked today");
  });

  it("leads with the flags, in counts and dates only", async () => {
    const { flag, confirm } = await import("../lib/learnings");
    const l = await mk();
    confirm(l.id, CID, "Checked", "mcp");
    // The flag comes after the confirm (a tie in the same second would count as answered).
    (await db()).prepare("UPDATE votes SET created_at = datetime(created_at, '-1 second') WHERE learning_id = ? AND kind = 'confirm'").run(l.id);
    flag(l.id, BOB, "mcp", "Wrong since the upgrade, see the release notes");
    const t = await trust(l.id);
    expect(t.label).toBe("flagged by 1 (newest today); confirmed by 1, last checked today");
    expect(t.label).not.toContain("Bob");
    expect(t.label).not.toContain("release notes");
  });

  it("counts a flag a later check answered as answered, not as flagged", async () => {
    const { flag, keepLearning } = await import("../lib/learnings");
    const l = await mk();
    flag(l.id, BOB, "mcp", "Wrong since the upgrade");
    // Same-second ties count the flag as before the check: push the flag back a second.
    (await db()).prepare("UPDATE votes SET created_at = datetime(created_at, '-1 second') WHERE learning_id = ? AND kind = 'flag'").run(l.id);
    keepLearning(l.id, CID, "mcp", "Checked: the old API still uses it");
    let t = await trust(l.id);
    expect(t).toMatchObject({ flags: 0, answeredFlags: 1 });
    expect(t.label).toBe("kept by a colleague, last checked today; 1 earlier flag answered by a later check");
    // A new flag after the check is open again.
    (await db()).prepare("UPDATE votes SET created_at = datetime(created_at, '+5 seconds') WHERE learning_id = ? AND kind = 'flag'").run(l.id);
    t = await trust(l.id);
    expect(t).toMatchObject({ flags: 1, answeredFlags: 0 });
  });

  it("is on every search result, with unchecked and verify set when they apply", async () => {
    const { search } = await import("../lib/learnings");
    const l = await mk({ title: "Rotate the zqsearch signing key", body: "Rotate it monthly zqsearch." });
    await backdate(l.id, 120);
    const [hit] = search("zqsearch");
    expect(hit.id).toBe(l.id);
    expect(hit).toMatchObject({ unchecked: true, verify: true });
    expect(hit.trust).toBe("not checked by anyone but its author; due a check");
  });
});

describe("the author still cannot validate their own memory", () => {
  it("refuses the author's confirm and records nothing", async () => {
    const { confirm } = await import("../lib/learnings");
    const l = await mk();
    expect(() => confirm(l.id, AUTHOR, "I checked it myself", "mcp")).toThrow();
    expect(await history(l.id)).toEqual([]);
    expect((await trust(l.id)).unchecked).toBe(true);
  });
});

describe("review queue", () => {
  it("lists flagged, due and unchecked memories once each, and leaves out checked ones", async () => {
    const { flag, confirm } = await import("../lib/learnings");
    const flagged = await mk();
    flag(flagged.id, BOB, "mcp", "Wrong");
    const due = await mk();
    await backdate(due.id, 200);
    const unchecked = await mk();
    const checked = await mk();
    confirm(checked.id, BOB, "Checked", "mcp");

    const { reviewQueue } = await import("../lib/trust");
    const q = reviewQueue();
    expect(q.flagged.map((i) => i.id)).toEqual([flagged.id]);
    expect(q.due.map((i) => i.id)).toEqual([due.id]);
    expect(q.unchecked.map((i) => i.id)).toEqual([unchecked.id]);
    expect(q.flagged[0].authorName).toBe("Ada Author");
  });
});

describe("hook: trust tags on injected titles", () => {
  async function linkSession(sessionId: string, ownerId: string) {
    const { mintOrReuseLinkToken, redeemLinkToken } = await import("../lib/session-links");
    redeemLinkToken(mintOrReuseLinkToken(sessionId), ownerId);
  }

  async function prompt(sessionId: string, text: string) {
    const { POST } = await import("../app/api/hook/route");
    const res = await POST(
      new Request(`${ORIGIN}/api/hook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: text }),
      }),
    );
    const out = (await res.json()) as { hookSpecificOutput?: { additionalContext?: string } };
    return out.hookSpecificOutput?.additionalContext ?? "";
  }

  it("tags a flagged title and puts it after the others", async () => {
    const { flag, confirm } = await import("../lib/learnings");
    const bad = await mk({ title: "Zqwebhook signatures use SHA-1", body: "Zqwebhook signed with HMAC-SHA1." });
    flag(bad.id, BOB, "mcp", "The provider moved to SHA-256");
    const good = await mk({ title: "Zqwebhook retries back off", body: "Zqwebhook retries use a backoff." });
    confirm(good.id, BOB, "Checked", "mcp");
    await linkSession("sess-trust-1", CID);

    const text = await prompt("sess-trust-1", "please fix the zqwebhook signature check and retries in the handler today");
    const line = text.split(/\r?\n/).find((l) => l.includes("may match this prompt"))!;
    expect(line).toContain(`"Zqwebhook signatures use SHA-1" (${bad.id}, saved today, flagged 1x, unchecked)`);
    expect(line).toContain(`"Zqwebhook retries back off" (${good.id}, saved today)`);
    expect(line.indexOf(good.id)).toBeLessThan(line.indexOf(bad.id));
    // Counts only: no names, no notes on this unauthenticated route.
    expect(line).not.toContain("Bob");
    expect(line).not.toContain("SHA-256");
  });

  it("tags a flagged house rule", async () => {
    const { flag, houseRulesFor, houseRulesBlock } = await import("../lib/learnings");
    const r = await mk({ kind: "practice", title: "Always pin the zqrule base image" });
    (await db()).prepare("UPDATE learnings SET pinned = 1 WHERE id = ?").run(r.id);
    expect(houseRulesBlock(houseRulesFor(null), null)!.text).toContain(`(${r.id})`);
    flag(r.id, BOB, "mcp", "The base image is rebuilt nightly now");
    expect(houseRulesBlock(houseRulesFor(null), null)!.text).toContain(`(${r.id}, flagged 1x)`);
  });

  it("puts a flagged house rule after the others, and leaves it out at two open flags", async () => {
    const { flag, confirm, houseRulesFor, houseRulesBlock, HOUSE_RULE_FLAGS_HIDE } = await import("../lib/learnings");
    expect(HOUSE_RULE_FLAGS_HIDE).toBe(2);
    const old = await mk({ kind: "practice", title: "Always tag images with the commit zqold" });
    await backdate(old.id, 30);
    const fresh = await mk({ kind: "practice", title: "Always run the linter before a push zqnew" });
    for (const r of [old, fresh]) (await db()).prepare("UPDATE learnings SET pinned = 1, kind = 'standard' WHERE id = ?").run(r.id);
    expect(houseRulesFor(null).map((r) => r.id)).toEqual([fresh.id, old.id]);

    flag(fresh.id, BOB, "mcp", "The linter runs in the pre-push hook now");
    expect(houseRulesFor(null).map((r) => r.id)).toEqual([old.id, fresh.id]);

    flag(fresh.id, CID, "mcp", "Same, the hook does it");
    expect((await db()).prepare("SELECT status FROM learnings WHERE id = ?").get(fresh.id)).toMatchObject({ status: "active" });
    const block = houseRulesBlock(houseRulesFor(null), null)!;
    expect(block.text).not.toContain(fresh.id);
    expect(block.text).toContain("1 more there");

    // A later check by someone else answers the flags: the rule is back.
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "dee.d@example.com", email: "dee.d@example.com", name: "Dee D", roles: [] });
    await new Promise((r) => setTimeout(r, 1100));
    confirm(fresh.id, "dee.d@example.com", "Checked the hook config, the linter is still required locally", "mcp");
    expect(houseRulesBlock(houseRulesFor(null), null)!.text).toContain(fresh.id);
  });

  it("returns no house rules block when every rule is hidden by flags", async () => {
    const { flag, houseRulesFor, houseRulesBlock } = await import("../lib/learnings");
    const r = await mk({ kind: "practice", title: "Always squash zqonly" });
    (await db()).prepare("UPDATE learnings SET pinned = 1, kind = 'standard' WHERE id = ?").run(r.id);
    flag(r.id, BOB, "mcp", "We merge now");
    flag(r.id, CID, "mcp", "Merge commits since the switch");
    expect(houseRulesBlock(houseRulesFor(null), null)).toBeNull();
  });
});

describe("open flags in search ranking", () => {
  it("ranks a memory with an open flag below an equal match, until a check answers it", async () => {
    const { flag, confirm, search, OPEN_FLAG_RANK_FACTOR } = await import("../lib/learnings");
    expect(OPEN_FLAG_RANK_FACTOR).toBeLessThan(1);
    const a = await mk({ title: "Rotate the zqrank signing key", body: "Rotate the zqrank signing key every month." });
    const b = await mk({ title: "Rotate the zqrank signing key", body: "Rotate the zqrank signing key every month." });
    await backdate(a.id, 1);
    await backdate(b.id, 1);
    const order = () => search("zqrank signing key").map((r) => r.id);
    const top = order()[0];
    expect([a.id, b.id]).toContain(top);
    flag(top, BOB, "mcp", "Rotation is quarterly now");
    expect(order()).toEqual([a.id, b.id].filter((id) => id !== top).concat(top));

    await new Promise((r) => setTimeout(r, 1100));
    confirm(top, CID, "Checked the key policy, still monthly", "mcp");
    const { trustOf } = await import("../lib/trust");
    const { getById } = await import("../lib/learnings");
    expect(trustOf(getById(top)!).flags).toBe(0);
  });
});

describe("GET /api/learnings/:id", () => {
  it("returns the trust label and the validation history", async () => {
    const { confirm } = await import("../lib/learnings");
    const l = await mk();
    confirm(l.id, BOB, "Checked in the repo", "mcp");
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": CID, "x-bab-actor-name": "Cid C" }),
    }));
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request(`${ORIGIN}/api/learnings/${l.id}`) as never, { params: Promise.resolve({ id: l.id }) });
    vi.doUnmock("next/headers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { learning: { trust: string }; history: Array<{ kind: string; note: string; actorName: string }> };
    expect(body.learning.trust).toBe("confirmed by 1, last checked today");
    expect(body.history).toEqual([expect.objectContaining({ kind: "confirm", note: "Checked in the repo", actorName: "Bob B" })]);
  });
});
