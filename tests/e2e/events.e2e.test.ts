import { describe, it, expect } from "vitest";
import { origin, api, ALICE, uniqueTitle } from "./helpers";

describe("e2e: GET /api/events (SSE)", () => {
  it("delivers a live event within 5s of a message being sent", async () => {
    const controller = new AbortController();
    const res = await fetch(`${origin()}/api/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const eventPromise = (async () => {
      let buffer = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes("event:") && buffer.includes("data:")) return buffer;
      }
      return buffer;
    })();

    // Trigger an event once the stream is open.
    await api("/api/messages", {
      method: "POST",
      actor: ALICE,
      body: { to: "bob.example@example.com", subject: uniqueTitle("SSE trigger"), body: "Triggering an SSE event." },
    });

    const streamed = await eventPromise;
    controller.abort();

    expect(streamed).toMatch(/event: message\.created/);
    expect(streamed).toMatch(/data: /);
  }, 15000);

  it("replays events after Last-Event-ID / ?since= before switching to live", async () => {
    // Prime the ring buffer with at least one event.
    await api("/api/messages", {
      method: "POST",
      actor: ALICE,
      body: { to: "bob.example@example.com", subject: uniqueTitle("SSE replay"), body: "Priming the buffer." },
    });

    const res = await fetch(`${origin()}/api/events?since=0`);
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !buffer.includes("event:")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    expect(buffer).toMatch(/event: message\.created/);
  }, 10000);
});
