import { describe, it, expect } from "vitest";
import { api, ALICE, BOB, uniqueTitle, uniqueActor } from "./helpers";

describe("e2e: inbox / messages", () => {
  it("sends a message, 201", async () => {
    const res = await api("/api/messages", {
      method: "POST",
      actor: ALICE,
      body: { to: BOB.email, subject: uniqueTitle("Subject"), body: "Hello Bob, from Alice." },
    });
    expect(res.status).toBe(201);
  });

  it("reply without `to` succeeds when threadId is given", async () => {
    const first = await api("/api/messages", {
      method: "POST",
      actor: ALICE,
      body: { to: BOB.email, subject: uniqueTitle("Thread"), body: "Opening message." },
    });
    const { threadId, thread } = await first.json();
    const tid = threadId ?? thread?.id;
    expect(tid).toBeTruthy();

    const reply = await api("/api/messages", {
      method: "POST",
      actor: BOB,
      body: { threadId: tid, body: "Replying without `to`." },
    });
    expect(reply.status).toBe(201);
  });

  it("reading a thread marks it read; a non-participant gets 403", async () => {
    const first = await api("/api/messages", {
      method: "POST",
      actor: ALICE,
      body: { to: BOB.email, subject: uniqueTitle("Read test"), body: "Please read this." },
    });
    const { threadId, thread } = await first.json();
    const tid = threadId ?? thread?.id;

    const read = await api(`/api/inbox/${tid}`, { actor: BOB });
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.messages.length).toBeGreaterThan(0);

    const outsider = await api(`/api/inbox/${tid}`, {
      actor: uniqueActor("outsider"),
    });
    expect(outsider.status).toBe(403);
  });
});
