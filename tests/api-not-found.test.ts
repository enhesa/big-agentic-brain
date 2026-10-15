import { describe, it, expect, afterEach, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function req(method: string, headers: Record<string, string> = {}) {
  return new Request("http://bab.test/api/does-not-exist", { method, headers });
}

describe("catch-all /api/[...slug]", () => {
  it("answers an unknown path with 404 JSON, with actor headers", async () => {
    const { GET } = await import("../app/api/[...slug]/route");
    const res = await GET(req("GET", { "X-Bab-Actor-Email": "you@example.com", "X-Bab-Actor-Name": "You" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("answers an unknown path with 404 JSON, without actor headers", async () => {
    const { GET } = await import("../app/api/[...slug]/route");
    const res = await GET(req("GET"));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it.each(METHODS)("exports %s", async (method) => {
    const mod = (await import("../app/api/[...slug]/route")) as unknown as Record<string, (r: Request) => Response>;
    const res = mod[method](req(method));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    if (method !== "HEAD") expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("does not shadow GET /api (the endpoint index is its own route file)", async () => {
    const { GET } = await import("../app/api/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("bab agent API");
  });

  it("open mode: the gate lets an unknown path through to the handler", async () => {
    vi.resetModules();
    vi.stubEnv("BAB_API_TOKENS", "");
    vi.stubEnv("BAB_API_TOKENS_FILE", "");
    const { gate } = await import("../lib/gate");
    expect(gate(new Request("http://bab.test/api/does-not-exist"))).toBeNull();
  });

  it("token mode: the gate answers 401 before the handler without a token, passes with one", async () => {
    vi.resetModules();
    vi.stubEnv("BAB_API_TOKENS", "secret-one");
    const { gate } = await import("../lib/gate");
    const res = gate(new Request("http://bab.test/api/does-not-exist"));
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "token required" });
    expect(gate(new Request("http://bab.test/api/does-not-exist", { headers: { authorization: "Bearer secret-one" } }))).toBeNull();
  });
});
