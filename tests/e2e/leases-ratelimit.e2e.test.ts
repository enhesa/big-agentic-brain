import { describe, it, expect } from "vitest";
import { api, uniqueActor, registerActor } from "./helpers";
import { RATE_LIMIT_PER_MINUTE } from "../../lib/rate-limit";

describe("e2e: leases", () => {
  it("records a lease, decrements on X-Bab-Lease sends, and refuses at 0", async () => {
    const sender = uniqueActor("lease sender");
    const receiver = uniqueActor("lease receiver");
    await registerActor(receiver);

    const open = await api("/api/messages", {
      method: "POST",
      actor: sender,
      body: { to: receiver.email, subject: "Lease thread", body: "Starting." },
    });
    const { threadId, thread } = await open.json();
    const tid = threadId ?? thread?.id;

    const lease = await api(`/api/inbox/${tid}/lease`, {
      method: "POST",
      actor: receiver,
      body: { turns: 1, minutes: 5 },
    });
    expect(lease.status).toBe(200);

    const send1 = await api("/api/messages", {
      method: "POST",
      actor: receiver,
      body: { threadId: tid, body: "Reply 1" },
      headers: { "X-Bab-Lease": "1" },
    });
    expect(send1.status).toBe(201);

    const send2 = await api("/api/messages", {
      method: "POST",
      actor: receiver,
      body: { threadId: tid, body: "Reply 2, should be refused" },
      headers: { "X-Bab-Lease": "1" },
    });
    expect([400, 403, 409]).toContain(send2.status);
  });
});

describe("e2e: rate limit", () => {
  it("429s after RATE_LIMIT_PER_MINUTE fast GETs on /api/me for one identity", async () => {
    const actor = uniqueActor("rate limit person");
    let sawTooMany = false;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE + 50; i++) {
      const res = await api("/api/me", { actor });
      if (res.status === 429) {
        sawTooMany = true;
        break;
      }
    }
    expect(sawTooMany).toBe(true);
  }, 60000);
});
