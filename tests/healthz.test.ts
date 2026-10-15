import { describe, it, expect } from "vitest";
import { GET } from "../app/healthz/route";

describe("GET /healthz", () => {
  it("returns status ok", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
