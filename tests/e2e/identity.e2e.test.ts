import { describe, it, expect } from "vitest";
import { api, ALICE, uniqueActor } from "./helpers";

describe("e2e: identity", () => {
  it("401s with no identity headers", async () => {
    const res = await api("/api/me");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Identity required/);
  });

  it("401s with the specific message for a short alias", async () => {
    const res = await api("/api/me", {
      actor: { email: "alice@example.com", name: "Alice Example" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/long address/);
  });

  it("200s for a long-form identity", async () => {
    const res = await api("/api/me", { actor: ALICE });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.actor?.email ?? body.actor?.id).toBeTruthy();
  });

  it("does not let a later mismatching name overwrite the canonical stored name", async () => {
    // lib/users.ts upsertUser: on first sight of a long-form email, the header
    // name is kept only when it loosely (anagram-of-letters) matches the name
    // derived from the email's local part — otherwise the derived name wins.
    // So the first call's name must be exactly the title-cased local part
    // for the stored name to actually be that name rather than a derived
    // override.
    const fresh = uniqueActor("firstname derivedmatch");
    const [local] = fresh.email.split("@");
    fresh.name = local
      .split(".")
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");
    const first = await api("/api/me", { actor: fresh });
    expect(first.status).toBe(200);
    expect((await first.json()).actor.name).toBe(fresh.name);

    const second = await api("/api/me", { actor: { ...fresh, name: "Totally Different Name" } });
    expect(second.status).toBe(200);
    const body = await second.json();
    // Stored name wins; the mismatching request name is used nowhere.
    expect(body.actor.name).toBe(fresh.name);
  });
});

describe("e2e: Authorization is ignored", () => {
  // Personal tokens are gone. Old plugin configs may still send a bearer;
  // it must never lock anyone out, so it is not read at all and the headers decide.
  const NOT_A_TOKEN = ["bab", "_", "B".repeat(43)].join("");

  it("serves /api/me from the actor headers whatever Authorization says", async () => {
    const res = await api("/api/me", { actor: ALICE, headers: { Authorization: `Bearer ${NOT_A_TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it("a bearer alone is not an identity (401), same as no header", async () => {
    const res = await api("/api/me", { headers: { Authorization: `Bearer ${NOT_A_TOKEN}` } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/Identity required/);
  });

  it("ignores a non-bearer Authorization header", async () => {
    const res = await api("/api/me", { actor: ALICE, headers: { Authorization: "Basic Zm9vOmJhcg==" } });
    expect(res.status).toBe(200);
  });
});

describe("e2e: devices", () => {
  // A made-up secret is an unknown device: /mcp still connects and tells it to call bab_identify.
  const unknownDevice = () => ({ "X-Bab-Device": ["c", "d", "e", "f"].join("").repeat(16) });

  it("lists the tools for an unknown device", async () => {
    const res = await api("/mcp", {
      method: "POST",
      headers: unknownDevice(),
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const out = await res.json();
    expect(out.error).toBeUndefined();
    expect(out.result.tools.length).toBeGreaterThan(0);
  });

  it("answers a tool call from an unknown device with the identify text", async () => {
    const res = await api("/mcp", {
      method: "POST",
      headers: unknownDevice(),
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bab_inbox", arguments: {} } },
    });
    const out = await res.json();
    expect(out.result.isError).toBe(false);
    expect(out.result.content[0].text).toMatch(/^BAB does not know who you are yet\. Call bab_identify/);
  });

  it("keeps header identity working from an unknown device, with no tip", async () => {
    const res = await api("/mcp", {
      method: "POST",
      actor: ALICE,
      headers: unknownDevice(),
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bab_inbox", arguments: {} } },
    });
    const out = await res.json();
    expect(out.result.isError).toBeFalsy();
    expect(out.result.content[0].text).not.toMatch(/Tip:|\/connect\/|does not know who you are/);
  });
});
