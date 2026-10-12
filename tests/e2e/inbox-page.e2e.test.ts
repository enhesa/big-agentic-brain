import { describe, it, expect } from "vitest";
import { api, origin, registerActor, uniqueActor, actorHeaders } from "./helpers";

/**
 * The /inbox page against the real standalone server (docs/spec.md "Inbox page"). The server runs
 * with BAB_TRUST_PROXY_IDENTITY=1, so a request carrying the proxy identity headers is a signed-in viewer
 * (what the SSO proxy adds in front of /inbox) and one carrying only X-Bab-Actor-* is an agent,
 * which the page must treat as nobody. No browser here: the HTML, the routes and the stream are
 * checked over real HTTP; the client script is covered by the unit tests of its pure parts.
 */

function sso(actor: { email: string; name: string }): Record<string, string> {
  return {
    "x-auth-request-user": `e2e-inbox-${actor.email}`,
    "x-auth-request-email": actor.email,
    "x-auth-request-preferred-username": actor.name,
  };
}

async function viewerGet(path: string, actor: { email: string; name: string }) {
  return fetch(`${origin()}${path}`, { headers: sso(actor) });
}

async function newThread(from: { email: string; name: string }, to: { email: string; name: string }, subject: string, body: string) {
  const res = await api("/api/messages", { method: "POST", actor: from, body: { to: to.email, subject, body } });
  expect(res.status).toBe(201);
  return (await res.json()) as { thread: { id: string }; message: { id: string }; delivery: { page: string; agent: string; note: string } };
}

/** Reads an SSE response until `done(text)` or the time limit; returns what arrived. */
async function readStream(res: Response, done: (text: string) => boolean, ms = 4000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  // One read stays pending across the loop: racing a fresh read() against a timer would let a
  // timed-out read swallow the next chunk.
  let pending: ReturnType<typeof reader.read> | null = null;
  while (Date.now() < deadline && !done(text)) {
    pending ??= reader.read();
    const next = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 100))]);
    if (next === null) continue;
    pending = null;
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return text;
}

describe("e2e: /inbox page", () => {
  it("shows a viewer their own thread, and nobody else's", async () => {
    const alice = uniqueActor("Alice");
    const bob = uniqueActor("Bob");
    const carl = uniqueActor("Carl");
    for (const a of [alice, bob, carl]) await registerActor(a);
    const subject = `Inbox e2e ${Date.now()}`;
    const { thread } = await newThread(alice, bob, subject, "Please look at this");

    const asBob = await viewerGet("/inbox", bob);
    expect(asBob.status).toBe(200);
    const bobHtml = await asBob.text();
    expect(bobHtml).toContain(subject);
    expect(bobHtml).toContain(`/inbox?thread=${thread.id}`);

    const carlHtml = await (await viewerGet("/inbox", carl)).text();
    expect(carlHtml).not.toContain(subject);

    // Opening Bob's thread as Bob shows the text and the hand-off; as Carl it is just "not found".
    const open = await (await viewerGet(`/inbox?thread=${thread.id}`, bob)).text();
    expect(open).toContain("Please look at this");
    expect(open).toContain("Continue in Claude app");
    expect(open).toContain("claude://code/new?q=");
    expect(open).toContain("Mark as read");

    const stolen = await viewerGet(`/inbox?thread=${thread.id}`, carl);
    expect(stolen.status).toBe(200);
    const stolenHtml = await stolen.text();
    expect(stolenHtml).toContain("was not found");
    expect(stolenHtml).not.toContain("Please look at this");
    expect(stolenHtml).not.toContain(subject);
  });

  it("is nothing to an agent header: the same person gets no threads from X-Bab-Actor alone", async () => {
    const alice = uniqueActor("Alice");
    const bob = uniqueActor("Bob");
    await registerActor(alice);
    await registerActor(bob);
    const subject = `Agent header ${Date.now()}`;
    await newThread(alice, bob, subject, "body");

    const res = await fetch(`${origin()}/inbox`, { headers: actorHeaders(bob) });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("signed-in browser");
    expect(html).not.toContain(subject);
    expect((await fetch(`${origin()}/inbox/unread`, { headers: actorHeaders(bob) })).status).toBe(401);
    expect((await fetch(`${origin()}/inbox/events`, { headers: actorHeaders(bob) })).status).toBe(401);
  });

  it("renders a hostile subject and body as inert text", async () => {
    const alice = uniqueActor("Alice");
    const bob = uniqueActor("Bob");
    await registerActor(alice);
    await registerActor(bob);
    const { thread } = await newThread(alice, bob, "</title><script>alert(1)</script>", "<img src=x onerror=alert(2)>");

    for (const path of ["/inbox", `/inbox?thread=${thread.id}`]) {
      const html = await (await viewerGet(path, bob)).text();
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).not.toContain("<img src=x onerror=alert(2)>");
      expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    }
    // The tab title is a count, never the subject.
    const html = await (await viewerGet("/inbox", bob)).text();
    expect(html).toMatch(/<title>\(\d+\) Inbox<\/title>/);
  });

  it("marks a thread read through POST /inbox/read, same origin only, viewer only", async () => {
    const alice = uniqueActor("Alice");
    const bob = uniqueActor("Bob");
    await registerActor(alice);
    await registerActor(bob);
    const { thread } = await newThread(alice, bob, `Read me ${Date.now()}`, "hello");
    const post = (headers: Record<string, string>, body: unknown = { threadId: thread.id }) =>
      fetch(`${origin()}/inbox/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

    expect((await post({ ...sso(bob) })).status).toBe(403); // no Origin
    expect((await post({ ...sso(bob), Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ ...actorHeaders(bob), Origin: origin() })).status).toBe(401); // an agent is not a viewer

    const before = await (await viewerGet("/inbox/unread", bob)).json();
    expect(before.unread).toBeGreaterThanOrEqual(1);

    const other = uniqueActor("Carl");
    await registerActor(other);
    expect((await post({ ...sso(other), Origin: origin() })).status).toBe(404); // not their thread

    const ok = await post({ ...sso(bob), Origin: origin() });
    expect(ok.status).toBe(200);
    expect((await ok.json()).unread).toBe(before.unread - 1);
    // The agent side sees the same: nothing unread for Bob now.
    const me = await (await api("/api/me", { actor: bob })).json();
    expect(me.counts.unreadMessages).toBe(0);
  });

  it("serves the manifest and the unread count to a viewer", async () => {
    const bob = uniqueActor("Bob");
    await registerActor(bob);
    const res = await viewerGet("/inbox/manifest", bob);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const manifest = await res.json();
    expect(manifest.start_url).toBe("/inbox");
    // The icons the manifest lists are really served.
    for (const icon of manifest.icons.filter((i: { type: string }) => i.type === "image/png")) {
      const img = await viewerGet(icon.src, bob);
      expect(img.status).toBe(200);
      expect(img.headers.get("content-type")).toBe("image/png");
    }
    expect(await (await viewerGet("/inbox/unread", bob)).json()).toEqual({ unread: expect.any(Number) });
  });

  it("refuses a cross-site stream request and serves a same-origin one", async () => {
    const bob = uniqueActor("Bob");
    await registerActor(bob);
    expect((await fetch(`${origin()}/inbox/events`, { headers: { ...sso(bob), "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${origin()}/inbox/events`, { headers: { ...sso(bob), Origin: "https://evil.example" } })).status).toBe(403);
    const controller = new AbortController();
    const ok = await fetch(`${origin()}/inbox/events`, {
      headers: { ...sso(bob), "Sec-Fetch-Site": "same-origin", Origin: origin() },
      signal: controller.signal,
    });
    expect(ok.status).toBe(200);
    controller.abort();
  });

  it("streams only the viewer's events, and the sender sees the page as connected while it is open", async () => {
    const alice = uniqueActor("Alice");
    const bob = uniqueActor("Bob");
    const carl = uniqueActor("Carl");
    for (const a of [alice, bob, carl]) await registerActor(a);
    // Bob has written to Alice before: only then may Alice be told his Inbox page is open.
    await newThread(bob, alice, "Earlier from Bob", "hello Alice");

    const controller = new AbortController();
    const stream = await fetch(`${origin()}/inbox/events`, { headers: sso(bob), signal: controller.signal });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const reader = readStream(stream, (t) => t.includes('"kind":"message"') && t.includes("event: inbox"), 6000);

    // The first send happens after the stream is open, so it reports the page as connected.
    await new Promise((r) => setTimeout(r, 300));
    const toCarl = await newThread(alice, carl, "Not for Bob", "private TOP-SECRET-1");
    const toBob = await newThread(alice, bob, "For Bob", "private TOP-SECRET-2");
    expect(toBob.delivery.page).toBe("connected");
    expect(toCarl.delivery.page).toBe("none");
    expect(toBob.delivery.note).toMatch(/Inbox page is open/);
    // A sender Bob has never written to learns nothing about his page.
    const fromCarl = await newThread(carl, bob, "Stranger", "hi Bob");
    expect(fromCarl.delivery.page).toBe("none");
    expect(fromCarl.delivery.note).not.toMatch(/Inbox/);

    const text = await reader;
    expect(text).toContain("event: ping");
    expect(text).toContain(`"threadId":"${toBob.thread.id}"`);
    expect(text).not.toContain(toCarl.thread.id);
    expect(text).not.toContain("TOP-SECRET");
    controller.abort();

    // The slot frees when the client goes away, so a later send says the page is closed.
    let page = "connected";
    for (let i = 0; i < 20 && page === "connected"; i++) {
      await new Promise((r) => setTimeout(r, 150));
      page = (await newThread(alice, bob, `After close ${i}`, "x")).delivery.page;
    }
    expect(page).toBe("none");
  });

  it("forwards old /handoff links to the Inbox, and opens the app only for a participant", async () => {
    const alice = uniqueActor("Alice");
    const bob = uniqueActor("Bob");
    const carl = uniqueActor("Carl");
    for (const a of [alice, bob, carl]) await registerActor(a);
    const { thread } = await newThread(alice, bob, `Handoff e2e ${Date.now()}`, "Please look at this");

    const plain = await fetch(`${origin()}/handoff/${thread.id}`, { headers: sso(bob), redirect: "manual" });
    expect(plain.status).toBe(307);
    const target = new URL(plain.headers.get("location")!, origin());
    expect(target.pathname + target.search).toBe(`/inbox?thread=${thread.id}`);
    const withOpen = await fetch(`${origin()}/handoff/${thread.id}?open=app&x=y`, { headers: sso(bob), redirect: "manual" });
    expect(new URL(withOpen.headers.get("location")!, origin()).search).toBe(`?thread=${thread.id}&open=app`);

    const asBob = await (await viewerGet(`/inbox?thread=${thread.id}&open=app`, bob)).text();
    expect(asBob).toContain("Opening Claude");
    expect(asBob).toContain("Copy prompt");
    expect(await (await viewerGet(`/inbox?thread=${thread.id}`, bob)).text()).not.toContain("Opening Claude");
    const asCarl = await (await viewerGet(`/inbox?thread=${thread.id}&open=app`, carl)).text();
    expect(asCarl).not.toContain("Opening Claude");
    expect(asCarl).toContain("was not found");
  });
});
