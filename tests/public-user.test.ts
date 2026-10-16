import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * Agent- and API-facing user objects are built from an ALLOWLIST (publicUser, lib/users.ts), never
 * by spreading the users row: a column added to the table later must not leak by default. The
 * live leak was `require_confirm_until` (a security hold), plus the unused `listening_until` and
 * `listen_mode`.
 */

let dataDir: string;
const ME = "caller.t@example.com";
const OTHER = "other.person@example.com";
const PUBLIC_KEYS = ["created_at", "email", "id", "last_seen_at", "name", "roles", "trust"];
const INTERNAL_KEYS = ["require_confirm_until", "listening_until", "listen_mode", "future_internal"];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-public-user-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": ME, "x-bab-actor-name": "Caller T" }),
  }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

/** Real users with every internal column set, plus a column "added later" that nothing knows about. */
async function seed() {
  const { getDb } = await import("../lib/db");
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: ME, email: ME, name: "Caller T", roles: ["dev"] });
  upsertUser({ id: OTHER, email: OTHER, name: "Other Person", roles: [] });
  const db = getDb();
  db.exec("ALTER TABLE users ADD COLUMN future_internal TEXT");
  db.prepare("UPDATE users SET require_confirm_until = 9999999999999, future_internal = 'secret', listening_until = datetime('now', '+1 hour'), listen_mode = 'draft'").run();
}

function expectOnlyPublic(user: Record<string, unknown>, extra: string[] = []) {
  for (const key of INTERNAL_KEYS) expect(user, key).not.toHaveProperty(key);
  for (const key of PUBLIC_KEYS) expect(user, key).toHaveProperty(key);
  expect(Object.keys(user).sort()).toEqual([...PUBLIC_KEYS, ...extra].sort());
}

describe("publicUser", () => {
  it("returns exactly id, email, name, roles, created_at, last_seen_at and trust", async () => {
    await seed();
    const { getUser, publicUser } = await import("../lib/users");
    const row = getUser(ME)!;
    expect(Object.keys(row)).toEqual(expect.arrayContaining(INTERNAL_KEYS));
    const out = publicUser(row);
    expect(Object.keys(out).sort()).toEqual(PUBLIC_KEYS);
    expect(out).toMatchObject({ id: ME, email: ME, name: "Caller T", roles: "dev" });
    expect(typeof out.trust).toBe("number");
  });

  it("does not carry over a column it has not been told about", async () => {
    await seed();
    const { getUser, publicUser } = await import("../lib/users");
    const widened = { ...getUser(ME)!, brand_new_column: "x" };
    expect(publicUser(widened)).not.toHaveProperty("brand_new_column");
  });
});

describe("GET /api/people", () => {
  it("lists only the allowlisted fields plus the derived ones, for every user", async () => {
    await seed();
    const { GET } = await import("../app/api/people/route");
    const body = (await (await GET(new Request("http://localhost/api/people"))).json()) as { users: Record<string, unknown>[] };
    expect(body.users).toHaveLength(2);
    for (const u of body.users) {
      expectOnlyPublic(u, ["learningCount", "homeTeam", "areas"]);
    }
  });
});

describe("bab_people", () => {
  it("lists only the allowlisted fields plus the derived ones, for every user", async () => {
    await seed();
    const { POST } = await import("../app/mcp/route");
    const res = await POST(
      new Request("https://bab.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", host: "bab.example.com" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bab_people", arguments: {} } }),
      }),
    );
    const out = await res.json();
    expect(out.result.isError).toBeFalsy();
    const text: string = out.result.content[0].text;
    const users = (JSON.parse(text) as { users: Record<string, unknown>[] }).users;
    expect(users).toHaveLength(2);
    for (const u of users) {
      expectOnlyPublic(u, ["learningCount", "homeTeam", "areas"]);
    }
    for (const key of INTERNAL_KEYS) expect(text).not.toContain(key);
  });
});

describe("POST /api/me", () => {
  it("answers with the allowlisted fields, not the whole row", async () => {
    await seed();
    const { POST } = await import("../app/api/me/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(
      new NextRequest("http://x/api/me", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Caller Renamed" }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actor: Record<string, unknown> };
    expectOnlyPublic(body.actor);
    expect(body.actor.name).toBe("Caller Renamed");
  });

  it("GET /api/me carries no internal column either", async () => {
    await seed();
    const { GET } = await import("../app/api/me/route");
    const text = await (await GET()).text();
    for (const key of INTERNAL_KEYS) expect(text).not.toContain(key);
  });
});
