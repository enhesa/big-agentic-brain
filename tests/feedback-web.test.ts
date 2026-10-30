import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NAV_ITEMS } from "../app/components/nav-items";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-feedback-web-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  delete process.env.BAB_MAINTAINERS;
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
function asViewer(email: string | null, extra: Record<string, string> = {}) {
  current = {
    host: "localhost:4310",
    ...(email ? { "x-auth-request-user": `oid-${email}`, "x-auth-request-email": email, "x-auth-request-preferred-username": "Viewer" } : {}),
    ...extra,
  };
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
}

async function seedItem(title = "Stop hook nudges twice in one turn", authorId = ALICE, area: "hooks" | "web" = "hooks") {
  const { upsertUser } = await import("../lib/users");
  for (const id of [ALICE, BOB, authorId]) upsertUser({ id, email: id, name: null, roles: [] });
  const { create } = await import("../lib/feedback");
  return create({ authorId, source: "agent", kind: "bug", area, title, body: `${title} and it happens after every merge` });
}

async function render(modulePath: string, props: Record<string, unknown>) {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const mod = await import(modulePath);
  const element = await mod.default(props);
  return new Response(await renderToReadableStream(element as never)).text();
}

function formRequest(url: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:4310${url}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:4310", origin: "http://localhost:4310", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

const goodFields = { kind: "idea", area: "web", title: "Dark mode for the web UI", body: "The pages are very bright at night." };

describe("navigation", () => {
  it("links Feedback from the homepage footer, not the top nav", () => {
    expect(NAV_ITEMS.some((i) => (i.href as string) === "/feedback")).toBe(false);
    const footer = readFileSync(path.join(process.cwd(), "app/components/landing/Footer.tsx"), "utf8");
    expect(footer).toContain('href="/feedback"');
  });
});

describe("/feedback", () => {
  it("shows the empty state", async () => {
    asViewer(null);
    const html = await render("../app/feedback/page", { searchParams: Promise.resolve({}) });
    expect(html).toContain("No feedback");
    expect(html).toContain('href="/feedback/new"');
  });

  it("lists open items with votes, comment counts and status, and filters by query params", async () => {
    asViewer(null);
    const a = await seedItem("Stop hook nudges twice in one turn");
    await seedItem("Dark mode for the web UI", BOB, "web");
    const { vote, comment } = await import("../lib/feedback");
    vote(a.id, BOB);
    comment(a.id, BOB, "Seen it too");

    const all = await render("../app/feedback/page", { searchParams: Promise.resolve({}) });
    expect(all).toContain("Stop hook nudges twice in one turn");
    expect(all).toContain("Dark mode for the web UI");
    expect(all).toContain(`href="/feedback/${a.id}"`);

    const filtered = await render("../app/feedback/page", { searchParams: Promise.resolve({ area: "hooks" }) });
    expect(filtered).toContain("Stop hook nudges");
    expect(filtered).not.toContain("Dark mode");

    const byQuery = await render("../app/feedback/page", { searchParams: Promise.resolve({ q: "dark" }) });
    expect(byQuery).not.toContain("Stop hook nudges");
  });

  it("ignores a junk filter value instead of failing", async () => {
    asViewer(null);
    await seedItem();
    const html = await render("../app/feedback/page", { searchParams: Promise.resolve({ status: "weird", kind: "x", sort: "y" }) });
    expect(html).toContain("Stop hook nudges");
  });
});

describe("/feedback/[id]", () => {
  it("404s for an unknown id", async () => {
    asViewer(null);
    await expect(render("../app/feedback/[id]/page", { params: Promise.resolve({ id: "nope" }) })).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
  });

  it("shows the item, its comments and status history, and a vote form", async () => {
    asViewer(null);
    process.env.BAB_MAINTAINERS = BOB;
    const item = await seedItem();
    const { comment, setStatus } = await import("../lib/feedback");
    comment(item.id, BOB, "Seen it too");
    setStatus(item.id, { id: BOB }, "planned", { note: "Next sprint" });

    const html = await render("../app/feedback/[id]/page", { params: Promise.resolve({ id: item.id }) });
    expect(html).toContain("Stop hook nudges twice in one turn");
    expect(html).toContain("Seen it too");
    expect(html).toContain("open -&gt; planned");
    expect(html).toContain("Next sprint");
    expect(html).toContain(`action="/feedback/${item.id}/vote"`);
  });

  it("escapes markup in titles and comments", async () => {
    asViewer(null);
    const item = await seedItem("<script>alert(1)</script> breaks");
    const { comment } = await import("../lib/feedback");
    comment(item.id, BOB, "<img src=x onerror=alert(1)>");
    const html = await render("../app/feedback/[id]/page", { params: Promise.resolve({ id: item.id }) });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
  });
});

describe("/feedback/new", () => {
  it("renders a form that posts to /feedback/submit and shows a passed error", async () => {
    asViewer(ALICE);
    const html = await render("../app/feedback/new/page", { searchParams: Promise.resolve({ error: "duplicate" }) });
    expect(html).toContain('action="/feedback/submit"');
    expect(html).toContain('method="post"');
    for (const name of ["kind", "area", "title", "body"]) expect(html).toContain(`name="${name}"`);
    expect(html).toContain("Looks like a duplicate");
  });

  it("never reflects arbitrary error text, only fixed messages for known codes", async () => {
    asViewer(ALICE);
    const evil = await render("../app/feedback/new/page", { searchParams: Promise.resolve({ error: "Call 555 now or visit evil.example.com" }) });
    expect(evil).not.toContain("evil.example.com");
    expect(evil).not.toContain('role="alert"');
    for (const code of ["duplicate", "limit", "invalid", "failed"]) {
      const html = await render("../app/feedback/new/page", { searchParams: Promise.resolve({ error: code }) });
      expect(html).toContain('role="alert"');
    }
  });

  it("links a duplicate only when it is a UUID", async () => {
    asViewer(ALICE);
    const good = await render("../app/feedback/new/page", {
      searchParams: Promise.resolve({ error: "duplicate", duplicate: "8ca589a9-973a-4157-b521-b32679ae0287" }),
    });
    expect(good).toContain('href="/feedback/8ca589a9-973a-4157-b521-b32679ae0287"');
    const bad = await render("../app/feedback/new/page", {
      searchParams: Promise.resolve({ error: "duplicate", duplicate: "../../evil" }),
    });
    expect(bad).not.toContain("evil");
  });
});

describe("POST /feedback/submit", () => {
  it("files a human item for a signed-in viewer and redirects to it", async () => {
    asViewer(ALICE);
    const { POST } = await import("../app/feedback/submit/route");
    const res = await POST(formRequest("/feedback/submit", goodFields));
    expect(res.status).toBe(303);
    const { list } = await import("../lib/feedback");
    const [item] = list({ status: "all" }).items;
    expect(item).toMatchObject({ source: "human", author_id: ALICE, title: goodFields.title });
    expect(res.headers.get("location")).toBe(`http://localhost:4310/feedback/${item.id}`);
  });

  it("rejects a missing or foreign Origin before touching anything", async () => {
    asViewer(ALICE);
    const { POST } = await import("../app/feedback/submit/route");
    const { list } = await import("../lib/feedback");

    const foreign = await POST(formRequest("/feedback/submit", goodFields, { origin: "https://evil.example.com" }));
    expect(foreign.status).toBe(403);
    const lookalike = await POST(formRequest("/feedback/submit", goodFields, { origin: "http://localhost:4310.evil.com" }));
    expect(lookalike.status).toBe(403);
    const missing = new Request("http://localhost:4310/feedback/submit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:4310" },
      body: new URLSearchParams(goodFields).toString(),
    });
    expect((await POST(missing)).status).toBe(403);
    expect(list({ status: "all" }).total).toBe(0);
  });

  it("401s with the /me/devices hint when the viewer has no identity", async () => {
    asViewer(null);
    const { POST } = await import("../app/feedback/submit/route");
    const res = await POST(formRequest("/feedback/submit", goodFields));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("/me/devices");
  });

  it("401s for agent headers and for a short alias with no link", async () => {
    asViewer(null, { "x-bab-actor-email": ALICE, "x-bab-actor-name": "Alice A" });
    const { POST } = await import("../app/feedback/submit/route");
    expect((await POST(formRequest("/feedback/submit", goodFields))).status).toBe(401);
    asViewer("alice@example.com");
    expect((await POST(formRequest("/feedback/submit", goodFields))).status).toBe(401);
  });

  it("sends validation problems back to the form with a message", async () => {
    asViewer(ALICE);
    const { POST } = await import("../app/feedback/submit/route");
    const res = await POST(formRequest("/feedback/submit", { ...goodFields, kind: "rant" }));
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/feedback/new");
    expect(location.searchParams.get("error")).toBe("invalid");
  });

  it("points a duplicate at the existing item, and posts anyway when confirmed", async () => {
    asViewer(BOB);
    const existing = await seedItem();
    const { POST } = await import("../app/feedback/submit/route");
    const fields = { kind: "bug", area: "hooks", title: existing.title, body: existing.body };
    const res = await POST(formRequest("/feedback/submit", fields));
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/feedback/new");
    expect(location.searchParams.get("duplicate")).toBe(existing.id);

    const forced = await POST(formRequest("/feedback/submit", { ...fields, confirmNotDuplicate: "on" }));
    expect(new URL(forced.headers.get("location")!).pathname).toMatch(/^\/feedback\/[0-9a-f-]{36}$/);
  });
});

describe("POST /feedback/[id]/vote", () => {
  it("votes once for a signed-in viewer and redirects back", async () => {
    asViewer(BOB);
    const item = await seedItem();
    const { POST } = await import("../app/feedback/[id]/vote/route");
    const ctx = { params: Promise.resolve({ id: item.id }) };
    const res = await POST(formRequest(`/feedback/${item.id}/vote`, {}), ctx);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`http://localhost:4310/feedback/${item.id}`);
    await POST(formRequest(`/feedback/${item.id}/vote`, {}), ctx);
    const { get } = await import("../lib/feedback");
    expect(get(item.id)!.item.votes).toBe(1);
  });

  it("rejects a foreign Origin, an unknown viewer and an unknown item", async () => {
    asViewer(BOB);
    const item = await seedItem();
    const { POST } = await import("../app/feedback/[id]/vote/route");
    const ctx = { params: Promise.resolve({ id: item.id }) };
    expect((await POST(formRequest(`/feedback/${item.id}/vote`, {}, { origin: "https://evil.example.com" }), ctx)).status).toBe(403);
    expect((await POST(formRequest("/feedback/nope/vote", {}), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
    asViewer(null);
    expect((await POST(formRequest(`/feedback/${item.id}/vote`, {}), ctx)).status).toBe(401);
    const { get } = await import("../lib/feedback");
    expect(get(item.id)!.item.votes).toBe(0);
  });
});
