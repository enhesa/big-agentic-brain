import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The optional maintainer review page (app/memory/review) and its buttons
 * (POST /memory/[id]/review, lib/review-web.ts): maintainers only, a note on every action, the
 * same rules as an agent (no confirm of your own memory), and every action in the history.
 */

let dataDir: string;
const MAINT = "mia.m@example.com";
const BOB = "bob.b@example.com";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-memory-review-web-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  process.env.BAB_MAINTAINERS = MAINT;
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

function signedIn(as: "maint" | "bob") {
  const h =
    as === "maint"
      ? { host: "localhost:4310", "x-auth-request-user": "proxy-mia", "x-auth-request-email": "mmia@example.com", "x-auth-request-preferred-username": "Mia M" }
      : { host: "localhost:4310", "x-auth-request-user": "proxy-bob", "x-auth-request-email": "bbob@example.com", "x-auth-request-preferred-username": "Bob B" };
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(h) }));
}

async function link(as: "maint" | "bob") {
  const { linkForTests } = await import("./link-helper");
  await linkForTests(as === "maint" ? "proxy-mia" : "proxy-bob", as === "maint" ? MAINT : BOB);
}

async function seed(authorId = BOB) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: MAINT, email: MAINT, name: "Mia M", roles: [] });
  upsertUser({ id: BOB, email: BOB, name: "Bob B", roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId, title: "Webhook signatures use SHA-1", body: "The provider signs with HMAC-SHA1.", confirmNotDuplicate: true });
}

async function review(id: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  const { POST } = await import("../app/memory/[id]/review/route");
  return POST(
    new Request(`http://localhost:4310/memory/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:4310", origin: "http://localhost:4310", ...headers },
      body: new URLSearchParams(fields).toString(),
    }),
    { params: Promise.resolve({ id }) },
  );
}

async function renderReview(query: { review?: string } = {}) {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const { default: ReviewPage } = await import("../app/memory/review/page");
  const node = await ReviewPage({ searchParams: Promise.resolve(query) });
  return new Response(await renderToReadableStream(node as never)).text();
}

async function history(id: string) {
  const { trustHistory } = await import("../lib/trust");
  return trustHistory(id);
}

describe("POST /memory/[id]/review", () => {
  it("confirms with the note, as the maintainer, and records it in the history", async () => {
    signedIn("maint");
    const l = await seed();
    await link("maint");
    const res = await review(l.id, { action: "confirm", note: "Checked against the provider docs" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost:4310/memory/review?review=confirmed");
    const h = await history(l.id);
    expect(h[0]).toMatchObject({ kind: "confirm", actorName: "Mia M", note: "Checked against the provider docs", byAuthor: false });
  });

  it("says so when a repeat confirm within 30 days changed nothing", async () => {
    signedIn("maint");
    const l = await seed();
    await link("maint");
    await review(l.id, { action: "confirm", note: "First check" });
    expect((await review(l.id, { action: "confirm", note: "Second check" })).headers.get("location")).toContain("review=recent");
    expect((await history(l.id)).map((e) => e.note)).toEqual(["First check"]);
  });

  it("takes a flagged memory off the Flagged list once the maintainer keeps it", async () => {
    signedIn("maint");
    const l = await seed();
    await link("maint");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "cid.c@example.com", email: "cid.c@example.com", name: "Cid C", roles: [] });
    const { flag } = await import("../lib/learnings");
    flag(l.id, "cid.c@example.com", "mcp", "Provider moved to SHA-256");
    const { reviewQueue } = await import("../lib/trust");
    expect(reviewQueue().flagged.map((i) => i.id)).toEqual([l.id]);
    await review(l.id, { action: "keep", note: "Old API still signs with SHA-1" });
    const q = reviewQueue();
    expect(q.flagged).toEqual([]);
    expect(q.unchecked).toEqual([]);
  });

  it("retires and keeps with a note", async () => {
    signedIn("maint");
    const l = await seed();
    await link("maint");
    expect((await review(l.id, { action: "retire", note: "Provider moved to SHA-256" })).headers.get("location")).toContain("review=retired");
    const { getById } = await import("../lib/learnings");
    expect(getById(l.id)!.status).toBe("archived");
    expect((await review(l.id, { action: "keep", note: "Old API still uses it" })).headers.get("location")).toContain("review=kept");
    expect(getById(l.id)!.status).toBe("active");
    expect((await history(l.id)).map((e) => e.kind)).toEqual(["restore", "retire"]);
  });

  it("needs a note, and refuses one that is too long", async () => {
    signedIn("maint");
    const l = await seed();
    await link("maint");
    expect((await review(l.id, { action: "confirm", note: "  " })).headers.get("location")).toContain("review=note");
    expect((await review(l.id, { action: "confirm", note: "x".repeat(301) })).headers.get("location")).toContain("review=long");
    expect((await review(l.id, { action: "approve", note: "ok" })).headers.get("location")).toContain("review=invalid");
    expect(await history(l.id)).toEqual([]);
  });

  it("refuses a maintainer's confirm of their own memory", async () => {
    signedIn("maint");
    const l = await seed(MAINT);
    await link("maint");
    expect((await review(l.id, { action: "confirm", note: "I wrote it, it is right" })).headers.get("location")).toContain("review=own");
    expect(await history(l.id)).toEqual([]);
  });

  it("is a 404 for anyone who is not a maintainer, and for nobody signed in", async () => {
    signedIn("bob");
    const l = await seed(MAINT);
    await link("bob");
    expect((await review(l.id, { action: "confirm", note: "Looks right" })).status).toBe(404);
    expect(await history(l.id)).toEqual([]);
  });

  it("refuses a cross-site post", async () => {
    signedIn("maint");
    const l = await seed();
    await link("maint");
    const res = await review(l.id, { action: "confirm", note: "ok" }, { origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
    expect(await history(l.id)).toEqual([]);
  });
});

describe("GET /memory/review", () => {
  it("lists the unchecked memory with the three buttons for a maintainer", async () => {
    signedIn("maint");
    const l = await seed();
    await link("maint");
    const html = await renderReview({ review: "confirmed" });
    expect(html).toContain("Review memories");
    expect(html).toContain(`/memory/${l.id}/review`);
    expect(html).toContain("Webhook signatures use SHA-1");
    expect(html).toContain(">Confirm<");
    expect(html).toContain("Confirmed. Your note is in the memory&#x27;s validation history.");
  });

  it("hides Confirm on the maintainer's own memory", async () => {
    signedIn("maint");
    await seed(MAINT);
    await link("maint");
    const html = await renderReview();
    expect(html).not.toContain(">Confirm<");
    expect(html).toContain(">Keep<");
  });

  it("ignores an unknown ?review= code", async () => {
    signedIn("maint");
    await seed();
    await link("maint");
    const html = await renderReview({ review: "<b>pwned</b>" });
    expect(html).not.toContain("pwned");
  });

  it("is a 404 for anyone else", async () => {
    signedIn("bob");
    await seed();
    await link("bob");
    await expect(renderReview()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });
});
