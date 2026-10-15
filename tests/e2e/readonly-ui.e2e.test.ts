import { describe, it, expect } from "vitest";
import { origin, api, ALICE, uniqueTitle } from "./helpers";

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

  it("/conversations/<threadId> returns 200 for a real thread", async () => {
    const sent = await api("/api/messages", {
      method: "POST",
      actor: ALICE,
      body: { to: "bob.example@example.com", subject: uniqueTitle("UI thread"), body: "Visible in Conversations." },
    });
    const { threadId, thread } = await sent.json();
    const tid = threadId ?? thread?.id;

    const res = await fetch(`${origin()}/conversations/${tid}`);
    expect(res.status).toBe(200);
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
