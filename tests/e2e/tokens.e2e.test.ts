import { describe, it, expect } from "vitest";

// A second server booted by global-setup with BAB_API_TOKENS=t1=alice.example@example.com.
function tokensOrigin(): string {
  const o = process.env.BAB_E2E_TOKENS_ORIGIN;
  if (!o) throw new Error("BAB_E2E_TOKENS_ORIGIN not set, did global setup run?");
  return o;
}

const bearer = { Authorization: "Bearer t1" };

describe("whitelabel: the built image honours BAB_ORG_NAME", () => {
  it("GET / shows the configured organisation, not the default one", async () => {
    const res = await fetch(`${tokensOrigin()}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Zeta Corp");
    expect(html).not.toContain("Acme");
  });
});

describe("bearer tokens (BAB_API_TOKENS set)", () => {
  it("GET /api/learnings without a bearer is 401", async () => {
    const res = await fetch(`${tokensOrigin()}/api/learnings`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "token required" });
  });

  it("GET /api/learnings with a wrong bearer is 401", async () => {
    const res = await fetch(`${tokensOrigin()}/api/learnings`, { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  it("GET /api/learnings with the bearer is 200 (identity pinned by the token)", async () => {
    const res = await fetch(`${tokensOrigin()}/api/learnings`, { headers: bearer });
    expect(res.status).toBe(200);
  });

  it("GET /api/me answers the token's email, whatever identity is declared", async () => {
    const res = await fetch(`${tokensOrigin()}/api/me`, {
      headers: { ...bearer, "X-Bab-Actor-Email": "bob.example@example.com", "X-Bab-Actor-Name": "Bob Example" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actor: { email: string } };
    expect(body.actor.email).toBe("alice.example@example.com");
  });

  it("public paths need no bearer", async () => {
    expect((await fetch(`${tokensOrigin()}/healthz`)).status).toBe(200);
    expect((await fetch(`${tokensOrigin()}/api`)).status).toBe(200);
  });
});
