import { describe, it, expect } from "vitest";
import { origin, api, ALICE, uniqueActor, registerActor, ssoHeaders, uniqueTitle } from "./helpers";

describe("e2e: read-only UI", () => {
  it("/ returns 200 and contains expected landing text", async () => {
    const res = await fetch(`${origin()}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).toContain("agentic");
  });

  it("/memory returns 200; its only form is a GET search box, no write form", async () => {
    const res = await fetch(`${origin()}/memory`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // The page is read-only: the one <form is a plain GET search box
    // (action="/memory" method="get"), never a POST/write form.
    expect(text).not.toMatch(/<form[^>]*method=["']?post/i);
  });

  it("/memory/<id> returns 200 and shows the learning, no <form at all", async () => {
    const created = await api("/api/learnings", {
      method: "POST",
      actor: ALICE,
      body: { title: uniqueTitle("UI visible learning"), body: "Body content visible via /memory/[id].", tags: ["ui"] },
    });
    const { learning } = await created.json();

    const res = await fetch(`${origin()}/memory/${learning.id}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("<form");
    expect(text).toContain(learning.title.slice(0, 10));
  });

  it("/conversations (the removed Chats list) redirects to /inbox", async () => {
    const res = await fetch(`${origin()}/conversations`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/inbox");
  });

  describe("/conversations/<threadId> is for the people in the thread", () => {
    const BODY = "Visible only to the participants.";

    async function newThread() {
      const alice = uniqueActor("Alice");
      const bob = uniqueActor("Bob");
      const carl = uniqueActor("Carl");
      for (const a of [alice, bob, carl]) await registerActor(a);
      const sent = await api("/api/messages", {
        method: "POST",
        actor: alice,
        body: { to: bob.email, subject: uniqueTitle("UI thread"), body: BODY },
      });
      expect(sent.status).toBe(201);
      const { thread } = await sent.json();
      return { alice, bob, carl, tid: thread.id as string };
    }

    it("returns 200 with the messages to the sender and to the recipient, signed in through the proxy", async () => {
      const { alice, bob, tid } = await newThread();
      for (const who of [alice, bob]) {
        const res = await fetch(`${origin()}/conversations/${tid}`, { headers: ssoHeaders(who) });
        expect(res.status).toBe(200);
        expect(await res.text()).toContain(BODY);
      }
    });

    it("returns 404 to a signed-in person who is not in the thread, without the message text", async () => {
      const { carl, tid } = await newThread();
      const res = await fetch(`${origin()}/conversations/${tid}`, { headers: ssoHeaders(carl) });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(BODY);
    });

    it("returns 404 to a visitor the proxy did not identify, without the message text", async () => {
      const { tid } = await newThread();
      const res = await fetch(`${origin()}/conversations/${tid}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(BODY);
    });
  });

  it("/people redirects to the Users section of /usage", async () => {
    const res = await fetch(`${origin()}/people`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/usage#users");
  });

  it("/board redirects (307) to /memory", async () => {
    const res = await fetch(`${origin()}/board`, { redirect: "manual" });
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/memory");
  });
});
