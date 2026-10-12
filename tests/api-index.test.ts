import { describe, it, expect } from "vitest";

describe("GET /api", () => {
  it("returns a JSON endpoint map with no auth required", async () => {
    const { GET } = await import("../app/api/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoints["GET /api/learnings"]).toBeTruthy();
    expect(body.endpoints["POST /api/messages"]).toBeTruthy();
  });
});
