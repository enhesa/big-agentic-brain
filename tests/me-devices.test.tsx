import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkForTests } from "./link-helper";
import { _resetConfigForTests } from "@/lib/config";

/**
 * /me/devices (replaces /me/token): the device list, Forget, Unlink this browser, and for an
 * unlinked viewer "Yes, that's me" and the typed claim. Secrets are assembled at runtime.
 */

let dataDir: string;
const ALICE = "alice.example@example.com";
const MARIE = "marie.curie@example.com";
const secret = (c: string) => c.repeat(64);
let current: Record<string, string> = {};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-me-devices-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  vi.resetModules();
  current = {};
  vi.doMock("next/headers", () => ({ headers: async () => new Headers({ host: "localhost:4310", ...current }) }));
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

function asAliasViewer(opts: { id?: string; email?: string; name?: string } = {}) {
  current = {
    "x-auth-request-user": opts.id ?? "forge-oid-1",
    "x-auth-request-email": opts.email ?? "aexample@example.com",
    "x-auth-request-preferred-username": opts.name ?? "Alice Example",
  };
}

async function render(search: Record<string, string> = {}) {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const { default: Page } = await import("../app/me/devices/page");
  const element = await Page({ searchParams: Promise.resolve(search) });
  return new Response(await renderToReadableStream(element as never)).text();
}

/** A device bound to `who`; `forgeUserId` stands for one an earlier release connected through a browser. */
async function connect(c: string, who: string, label: string, forgeUserId?: string, ip: string | null = null) {
  const d = await import("../lib/devices");
  const h = d.hashSecret(secret(c))!;
  d.bindDevice(h, who, label, ip);
  if (forgeUserId) {
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE devices SET bound_via_forge_id = ? WHERE secret_hash = ?").run(forgeUserId, h);
  }
}

function post(url: string, fields: Record<string, string> = {}, opts: { json?: boolean; headers?: Record<string, string> } = {}) {
  const json = opts.json ?? false;
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      "content-type": json ? "application/json" : "application/x-www-form-urlencoded",
      ...opts.headers,
    },
    body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
  });
}

describe("/me/devices page", () => {
  it("asks for sign-in when there is no proxy viewer", async () => {
    expect(await render()).toContain("Sign in through the BAB web UI");
  });

  it("agent headers are not a viewer", async () => {
    current = { "x-bab-actor-email": ALICE, "x-bab-actor-name": "Alice Example" };
    const html = await render();
    expect(html).toContain("Sign in through the BAB web UI");
    expect(html).not.toContain("Forget");
  });

  it("offers 'Yes, that's me' and the typed claim to an unlinked viewer with one fitting person", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: ALICE, email: ALICE, name: "Alice Example", roles: [] });
    asAliasViewer();
    const html = await render();
    expect(html).toContain("Are you");
    expect(html).toContain(ALICE);
    expect(html).toContain("that&#x27;s me");
    expect(html).toContain("Your address");
    expect(html).toContain('action="/me/devices/claim"');
    expect(html).toContain('method="post"');
    expect(html).not.toContain("Forget");
    expect(html).not.toContain("Unlink this browser");
  });

  it("with no fitting person it shows only the typed claim", async () => {
    asAliasViewer();
    const html = await render();
    expect(html).toContain("Your address");
    expect(html).not.toContain("Are you");
  });

  it("shows a claim refusal as one fixed line and ignores an unknown code", async () => {
    asAliasViewer();
    expect(await render({ claim: "mismatch" })).toContain("does not fit the name your sign-in shows");
    expect(await render({ claim: "<script>x</script>" })).not.toContain("<script>x");
    expect(await render({ claim: "constructor" })).not.toContain("function");
  });

  it("offers the unlink when the browser's old link no longer fits the SSO name", async () => {
    await linkForTests("forge-oid-1", ALICE);
    asAliasViewer({ name: "Marie Curie", email: "mcurie@example.com" });
    const html = await render();
    expect(html).toContain("Unlink this browser");
    expect(html).toContain('action="/me/devices/unlink"');
  });

  it("lists the viewer's devices with a Forget each, and nobody else's", async () => {
    await linkForTests("forge-oid-1", ALICE);
    await connect("a", ALICE, "MINGW64_NT-10.0 LAPTOP-123");
    await connect("b", ALICE, "Mac mini");
    await connect("c", MARIE, "Maries laptop");
    asAliasViewer();
    const html = await render();
    expect(html).toContain("Your devices");
    expect(html).toContain("MINGW64_NT-10.0 LAPTOP-123");
    expect(html).toContain("Mac mini");
    expect(html).not.toContain("Maries laptop");
    expect(html.match(/action="\/me\/devices\/revoke"/g)).toHaveLength(3); // two rows + forget all
    expect(html).toContain("Forget all my devices");
    expect(html).not.toContain("Revoke");
    expect(html).toContain("Unlink this browser");
  });

  it("shows when each was identified and last seen, and never a secret or hash", async () => {
    await linkForTests("forge-oid-1", ALICE);
    await connect("a", ALICE, "Laptop");
    const d = await import("../lib/devices");
    d.lookupDevice(d.hashSecret(secret("a"))!); // marks it seen
    asAliasViewer();
    const html = await render();
    expect(html).toContain(new Date().toISOString().slice(0, 10));
    expect(html).toContain("just now");
    expect(html).not.toContain(secret("a"));
    expect(html).not.toContain(d.hashSecret(secret("a"))!);
  });

  it("an empty list says Claude identifies the device by itself", async () => {
    await linkForTests("forge-oid-1", ALICE);
    asAliasViewer();
    const html = await render();
    expect(html).toContain("No devices yet");
    expect(html).toContain("tells BAB who you are by itself");
  });

  it("has no token UI and no deprecation banner: personal tokens are gone", async () => {
    await linkForTests("forge-oid-1", ALICE);
    asAliasViewer();
    const html = await render();
    expect(html).not.toMatch(/New token|Personal token|bab_token/i);
    expect(html).not.toMatch(/being replaced/i);
  });
});

describe("POST /me/devices/revoke", () => {
  async function seed() {
    await linkForTests("forge-oid-1", ALICE);
    await connect("a", ALICE, "One");
    await connect("b", ALICE, "Two");
    await connect("c", MARIE, "Hers");
    const d = await import("../lib/devices");
    return { d, mine: d.listDevices(ALICE), hers: d.listDevices(MARIE)[0] };
  }

  it("revokes one of the viewer's own devices, audits it and redirects", async () => {
    const { d, mine } = await seed();
    asAliasViewer();
    const { POST } = await import("../app/me/devices/revoke/route");
    const res = await POST(post("/me/devices/revoke", { id: mine[0].id }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/me/devices");
    expect(d.listDevices(ALICE)).toHaveLength(1);
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT entity_id FROM audit_log WHERE action = 'device-revoke'").all()).toEqual([{ entity_id: mine[0].id }]);
  });

  it("cannot revoke someone else's device with a forged id", async () => {
    const { d, hers } = await seed();
    asAliasViewer();
    const { POST } = await import("../app/me/devices/revoke/route");
    await POST(post("/me/devices/revoke", { id: hers.id }));
    expect(d.listDevices(MARIE)).toHaveLength(1);
  });

  it("revoke all takes every one of the viewer's devices and none of anyone else's", async () => {
    const { d } = await seed();
    asAliasViewer();
    const { POST } = await import("../app/me/devices/revoke/route");
    const res = await POST(post("/me/devices/revoke", { all: "1" }, { json: true }));
    expect(await res.json()).toEqual({ ok: true, revoked: 2 });
    expect(d.listDevices(ALICE)).toHaveLength(0);
    expect(d.listDevices(MARIE)).toHaveLength(1);
  });

  it("forget all also ends the viewer's identified connections, and nobody else's", async () => {
    await seed();
    const c = await import("../lib/mcp-connections");
    const mineConn = c._insertConnectionForTests();
    c.bindConnection(mineConn, ALICE);
    const hersConn = c._insertConnectionForTests();
    c.bindConnection(hersConn, MARIE);
    asAliasViewer();
    const { POST } = await import("../app/me/devices/revoke/route");
    await POST(post("/me/devices/revoke", { all: "1" }, { json: true }));
    expect(c.lookupConnection(mineConn)).toBeNull();
    expect(c.lookupConnection(hersConn)?.userId).toBe(MARIE);
  });

  it("forgetting ONE device leaves the connections alone", async () => {
    const { mine } = await seed();
    const c = await import("../lib/mcp-connections");
    const conn = c._insertConnectionForTests();
    c.bindConnection(conn, ALICE);
    asAliasViewer();
    const { POST } = await import("../app/me/devices/revoke/route");
    await POST(post("/me/devices/revoke", { id: mine[0].id }));
    expect(c.lookupConnection(conn)?.userId).toBe(ALICE);
  });

  it("the connections block says what Forget all does and that one Forget does not", async () => {
    await linkForTests("forge-oid-1", ALICE);
    const c = await import("../lib/mcp-connections");
    c.bindConnection(c._insertConnectionForTests(), ALICE);
    asAliasViewer();
    const html = await render();
    expect(html).toContain("all at once with Forget all my devices");
    expect(html).toContain("Forgetting one device does not touch them");
  });

  it("is refused cross-site (sameOrigin) and revokes nothing", async () => {
    const { d, mine } = await seed();
    asAliasViewer();
    const { POST } = await import("../app/me/devices/revoke/route");
    expect((await POST(post("/me/devices/revoke", { id: mine[0].id }, { headers: { origin: "https://evil.example.test" } }))).status).toBe(403);
    const noOrigin = new Request("http://localhost/me/devices/revoke", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ all: "1" }).toString(),
    });
    expect((await POST(noOrigin)).status).toBe(403);
    expect(d.listDevices(ALICE)).toHaveLength(2);
  });

  it("refuses agent headers (not a browser viewer) and revokes nothing", async () => {
    const { d, mine } = await seed();
    current = { "x-bab-actor-email": ALICE, "x-bab-actor-name": "Alice Example" };
    const { POST } = await import("../app/me/devices/revoke/route");
    const res = await POST(post("/me/devices/revoke", { id: mine[0].id }, { json: true }));
    expect(res.status).toBe(401);
    expect(d.listDevices(ALICE)).toHaveLength(2);
  });

  it("a device-authenticated request cannot revoke either (the device secret never drives a browser route)", async () => {
    const { d, mine } = await seed();
    current = { "x-bab-device": secret("a") };
    const { POST } = await import("../app/me/devices/revoke/route");
    expect((await POST(post("/me/devices/revoke", { id: mine[0].id }, { json: true }))).status).toBe(401);
    expect(d.listDevices(ALICE)).toHaveLength(2);
  });
});

describe("POST /me/devices/unlink", () => {
  it("unlinks the browser and revokes the devices connected through it, only those", async () => {
    await linkForTests("forge-oid-1", ALICE);
    await connect("a", ALICE, "Via this browser", "forge-oid-1");
    await connect("b", ALICE, "Via another", "forge-oid-other");
    asAliasViewer();
    const { POST } = await import("../app/me/devices/unlink/route");
    const res = await POST(post("/me/devices/unlink"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/me/devices");
    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId("forge-oid-1")).toBeNull();
    const d = await import("../lib/devices");
    expect(d.listDevices(ALICE).map((x) => x.label)).toEqual(["Via another"]);
  });

  it("is refused cross-site and changes nothing", async () => {
    await linkForTests("forge-oid-1", ALICE);
    await connect("a", ALICE, "Via this browser", "forge-oid-1");
    asAliasViewer();
    const { POST } = await import("../app/me/devices/unlink/route");
    expect((await POST(post("/me/devices/unlink", {}, { headers: { origin: "https://evil.example.test" } }))).status).toBe(403);
    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId("forge-oid-1")).toBe(ALICE);
  });
});

// Coverage that used to live in tests/reminders-unlink.test.ts, now that /me/devices/unlink is the only
// self-unlink route (same shared logic, lib/unlink-own-web.ts).
describe("POST /me/devices/unlink: the rest of the self-unlink contract", () => {
  const FORGE_ID = "forge-oid-1";

  it("audits the unlink as unlink-browser-self under the person", async () => {
    await linkForTests(FORGE_ID, ALICE);
    asAliasViewer();
    const { POST } = await import("../app/me/devices/unlink/route");
    await POST(post("/me/devices/unlink"));
    const { getDb } = await import("../lib/db");
    const rows = getDb().prepare("SELECT actor_id FROM audit_log WHERE action = 'unlink-browser-self'").all();
    expect(rows).toEqual([{ actor_id: ALICE }]);
  });

  it("answers JSON for a JSON caller", async () => {
    await linkForTests(FORGE_ID, ALICE);
    asAliasViewer();
    const { POST } = await import("../app/me/devices/unlink/route");
    const res = await POST(post("/me/devices/unlink", {}, { json: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unlinked: true });
  });

  it("refuses a post with no Origin at all, and removes nothing", async () => {
    await linkForTests(FORGE_ID, ALICE);
    asAliasViewer();
    const { POST } = await import("../app/me/devices/unlink/route");
    const noOrigin = new Request("http://localhost/me/devices/unlink", { method: "POST", headers: { host: "localhost" } });
    expect((await POST(noOrigin)).status).toBe(403);
    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId(FORGE_ID)).toBe(ALICE);
  });

  it("only ever removes the caller's own link, whatever the body says", async () => {
    await linkForTests(FORGE_ID, ALICE);
    await linkForTests("forge-oid-other", MARIE);
    asAliasViewer();
    const { POST } = await import("../app/me/devices/unlink/route");
    await POST(post("/me/devices/unlink", { forgeUserId: "forge-oid-other", email: MARIE }, { json: true }));
    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId(FORGE_ID)).toBeNull();
    expect(getLinkedUserId("forge-oid-other")).toBe(MARIE);
  });

  it("401s with no proxy viewer, or when proxy headers are not trusted", async () => {
    current = {};
    const { POST } = await import("../app/me/devices/unlink/route");
    expect((await POST(post("/me/devices/unlink"))).status).toBe(401);
    delete process.env.BAB_TRUST_PROXY_IDENTITY;
    (await import("../lib/config"))._resetConfigForTests();
    asAliasViewer();
    expect((await POST(post("/me/devices/unlink"))).status).toBe(401);
  });

  it("is a harmless no-op for a browser that was not linked", async () => {
    asAliasViewer({ id: "forge-oid-never" });
    const { POST } = await import("../app/me/devices/unlink/route");
    const res = await POST(post("/me/devices/unlink", {}, { json: true }));
    expect(await res.json()).toEqual({ ok: true, unlinked: false });
  });
});

describe("POST /me/devices/claim", () => {
  it("links an alias-only SSO account with no users row and redirects to the page", async () => {
    asAliasViewer();
    const { POST } = await import("../app/me/devices/claim/route");
    const res = await POST(post("/me/devices/claim", { email: ALICE }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/me/devices");
    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId("forge-oid-1")).toBe(ALICE);
  });

  it("refuses a mismatch with a code, never the message", async () => {
    asAliasViewer({ name: "Marie Curie", email: "mcurie@example.com" });
    const { POST } = await import("../app/me/devices/claim/route");
    const res = await POST(post("/me/devices/claim", { email: ALICE }));
    expect(res.headers.get("location")).toBe("http://localhost/me/devices?claim=mismatch");
  });

  it("is refused cross-site", async () => {
    asAliasViewer();
    const { POST } = await import("../app/me/devices/claim/route");
    expect((await POST(post("/me/devices/claim", { email: ALICE }, { headers: { origin: "https://evil.example.test" } }))).status).toBe(403);
  });
});

describe("the old /me/token address", () => {
  it("redirects permanently to /me/devices, including the old sub-paths", async () => {
    const { default: config } = await import("../next.config");
    const redirects = await config.redirects!();
    const match = (p: string) => redirects.find((r) => r.source === p);
    expect(match("/me/token")).toMatchObject({ destination: "/me/devices", permanent: true });
    expect(match("/me/token/:path*")).toMatchObject({ destination: "/me/devices", permanent: true });
  });

  it("no route or page is left under app/me/token", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(new URL("../app/me/token", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../lib/tokens.ts", import.meta.url))).toBe(false);
  });
});

describe("the address a device identified from, and the connections", () => {
  it("shows the address in a From column", async () => {
    await linkForTests("forge-oid-1", ALICE);
    await connect("a", ALICE, "Windows laptop", undefined, "192.0.2.5");
    await connect("b", ALICE, "Mac mini", undefined, null);
    asAliasViewer();
    const html = await render();
    expect(html).toContain("From");
    expect(html).toContain("192.0.2.5");
    expect(html).toContain("unknown");
  });

  it("has no new-device banner, no (new) mark and no hold text any more", async () => {
    await linkForTests("forge-oid-1", ALICE);
    await connect("a", ALICE, "Windows laptop", undefined, "192.0.2.5");
    asAliasViewer();
    const html = await render();
    expect(html).not.toMatch(/New device connected|\(new\)|Not you\?|held/i);
    expect(html).not.toContain("Revoke");
    expect(html).not.toContain("/connect/");
  });

  it("lists the connections that said they are the person in the last 7 days, without the session id", async () => {
    await linkForTests("forge-oid-1", ALICE);
    const c = await import("../lib/mcp-connections");
    const mine = c._insertConnectionForTests();
    c.bindConnection(mine, ALICE);
    const hers = c._insertConnectionForTests();
    c.bindConnection(hers, MARIE);
    c._insertConnectionForTests(); // never identified
    asAliasViewer();
    const html = await render();
    expect(html).toContain("Connections that told BAB they are you in the last 7 days");
    expect(html.match(/MCP session/g)).toHaveLength(1);
    expect(html).not.toContain(mine);
    expect(html).not.toContain(hers);
  });

  it("shows no connections block when there are none, or only old ones", async () => {
    await linkForTests("forge-oid-1", ALICE);
    const c = await import("../lib/mcp-connections");
    const { getDb } = await import("../lib/db");
    const old = c._insertConnectionForTests();
    c.bindConnection(old, ALICE);
    getDb().prepare("UPDATE mcp_connections SET last_seen_at = ?").run(Date.now() - 8 * 86_400_000);
    asAliasViewer();
    expect(await render()).not.toContain("MCP session");
  });

  it("labels an address nobody has verified, and not once BAB_CLIENT_IP_HEADER is set", async () => {
    await linkForTests("forge-oid-1", ALICE);
    await connect("a", ALICE, "Laptop", undefined, "192.0.2.5");
    asAliasViewer();
    expect(await render()).toContain("192.0.2.5 (unverified)");
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    (await import("@/lib/config"))._resetConfigForTests(); // same module registry as the routes
    try {
      const verified = await render();
      expect(verified).toContain("192.0.2.5");
      expect(verified).not.toContain("(unverified)");
    } finally {
      delete process.env.BAB_CLIENT_IP_HEADER;
      _resetConfigForTests();
    }
  });

  it("the unlink text no longer promises to take devices with it", async () => {
    await linkForTests("forge-oid-1", ALICE);
    asAliasViewer();
    const html = await render();
    expect(html).toContain("This browser is linked to");
    expect(html).not.toContain("Devices connected through this browser");
  });
});
