import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkForTests } from "./link-helper";

/**
 * "Your team and areas" on /me/devices and its POST /me/devices/profile: the signed-in person's
 * own home team and area contacts, as plain forms (and JSON).
 */

let dataDir: string;
const ALICE = "alice.example@example.com";
const BOB = "bob.b@example.com";
let current: Record<string, string> = {};

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-me-profile-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  vi.resetModules();
  current = {
    "x-auth-request-user": "proxy-oid-1",
    "x-auth-request-email": "aexample@example.com",
    "x-auth-request-preferred-username": "Alice Example",
  };
  vi.doMock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:4310", ...current }) }));
  const { getDb } = await import("../lib/db");
  const db = getDb();
  for (const id of [ALICE, BOB]) db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(id, id, id.split(".")[0]);
  await linkForTests("proxy-oid-1", ALICE);
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

async function render(search: Record<string, string> = {}) {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const { default: Page } = await import("../app/me/devices/page");
  const element = await Page({ searchParams: Promise.resolve(search) });
  return new Response(await renderToReadableStream(element as never)).text();
}

function post(fields: Record<string, string>, opts: { json?: boolean; origin?: string } = {}) {
  const json = opts.json ?? false;
  return new Request("http://localhost/me/devices/profile", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: opts.origin ?? "http://localhost",
      "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
    },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
  });
}

describe("/me/devices profile section", () => {
  it("shows the form with no team and no areas yet", async () => {
    const html = await render();
    expect(html).toContain("Your team and areas");
    expect(html).toContain('action="/me/devices/profile"');
    expect(html).toContain('name="team"');
    expect(html).toContain("toxicology");
    expect(html).not.toContain("Ask me about</th>");
  });

  it("shows the saved team and areas", async () => {
    const { setHomeTeam, addAreaContact } = await import("../lib/area-contacts");
    setHomeTeam(ALICE, "regulatory", "ui");
    addAreaContact(ALICE, "toxicology", "chemical hazard assessments", "ui");
    const html = await render();
    expect(html).toMatch(/<option value="regulatory" selected/);
    expect(html).toContain("chemical hazard assessments");
    expect(html).toContain('name="action" value="remove"');
  });

  it("lists the default teams with readable labels", async () => {
    const html = await render();
    expect(html).toMatch(/<option value="engineering">Engineering<\/option>/);
    expect(html).toMatch(/<option value="hr">HR<\/option>/);
    expect(html).not.toContain("expert-services");
  });

  it("shows a configured team as a labelled option and accepts it", async () => {
    process.env.BAB_TEAM_TAGS = "engineering,expert-services";
    try {
      const { _resetConfigForTests } = await import("../lib/config");
      _resetConfigForTests();
      const { setHomeTeam } = await import("../lib/area-contacts");
      setHomeTeam(ALICE, "expert-services", "ui");
      const html = await render();
      expect(html).toMatch(/<option value="expert-services" selected[^>]*>Expert services<\/option>/);
      expect(html).not.toContain('value="marketing"');
    } finally {
      delete process.env.BAB_TEAM_TAGS;
      const { _resetConfigForTests } = await import("../lib/config");
      _resetConfigForTests();
    }
  });

  it("says one fixed line after a refusal", async () => {
    expect(await render({ profile: "invalid" })).toContain("That did not work.");
    expect(await render({ profile: "<script>" })).not.toContain("That did not work.");
  });

  it("is absent for a viewer who is not linked", async () => {
    current = { ...current, "x-auth-request-user": "proxy-oid-9" };
    expect(await render()).not.toContain("Your team and areas");
  });
});

describe("POST /me/devices/profile", () => {
  it("sets the team, adds an area and removes it, redirecting each time", async () => {
    const { POST } = await import("../app/me/devices/profile/route");
    const { getUser } = await import("../lib/users");
    const { areasOf } = await import("../lib/area-contacts");

    let res = await POST(post({ action: "team", team: "legal" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/me/devices");
    expect(getUser(ALICE)?.home_team).toBe("legal");

    res = await POST(post({ action: "add", area: "Toxicology", note: "hazards" }));
    expect(res.status).toBe(303);
    expect(areasOf(ALICE)).toEqual([{ area: "toxicology", note: "hazards" }]);

    res = await POST(post({ action: "remove", area: "toxicology" }));
    expect(res.status).toBe(303);
    expect(areasOf(ALICE)).toEqual([]);

    const { getDb } = await import("../lib/db");
    const actions = (getDb().prepare("SELECT action FROM audit_log WHERE via = 'ui' AND entity IN ('user', 'area_contact') ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(["home_team_set", "area_contact_add", "area_contact_remove"]);
    // Every attempt is audited as a request, refused ones included.
    await POST(post({ action: "team", team: "wizards" }));
    const reqs = getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE path = '/me/devices/profile'").get() as { n: number };
    expect(reqs.n).toBe(4);
  });

  it("redirects with a refusal code for bad input and changes nothing", async () => {
    const { POST } = await import("../app/me/devices/profile/route");
    const { getUser } = await import("../lib/users");
    const bad: Record<string, string>[] = [{ action: "team", team: "wizards" }, { action: "add", area: "" }, { action: "add", area: "x", note: "n".repeat(201) }, { action: "nope" }];
    for (const fields of bad) {
      const res = await POST(post(fields));
      expect(res.headers.get("location")).toBe("http://localhost/me/devices?profile=invalid");
    }
    expect(getUser(ALICE)?.home_team).toBeNull();
  });

  it("answers a JSON caller with JSON", async () => {
    const { POST } = await import("../app/me/devices/profile/route");
    expect(await (await POST(post({ action: "add", area: "toxicology" }, { json: true }))).json()).toEqual({ ok: true });
    const bad = await POST(post({ action: "team", team: "wizards" }, { json: true }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/team must be one of/);
    const unknown = await POST(post({ action: "nope" }, { json: true }));
    expect(unknown.status).toBe(400);
  });

  it("only ever changes the signed-in person's own profile", async () => {
    const { POST } = await import("../app/me/devices/profile/route");
    const { addAreaContact, areasOf } = await import("../lib/area-contacts");
    addAreaContact(BOB, "toxicology", null, "ui");
    await POST(post({ action: "remove", area: "toxicology", user: BOB }));
    expect(areasOf(BOB)).toHaveLength(1);
  });

  it("refuses a form from another site and a viewer who is not signed in", async () => {
    const { POST } = await import("../app/me/devices/profile/route");
    expect((await POST(post({ action: "team", team: "it" }, { origin: "https://evil.example.org" }))).status).toBe(403);
    current = { ...current, "x-auth-request-user": "proxy-oid-9" };
    const res = await POST(post({ action: "team", team: "it" }));
    expect(res.headers.get("location")).toBe("http://localhost/me/devices");
    expect((await POST(post({ action: "team", team: "it" }, { json: true }))).status).toBe(401);
  });
});
