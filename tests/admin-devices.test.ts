import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Devices on /admin/links: the list and the maintainer-only Revoke. */

let dataDir: string;
const MAINT = "mia.maint@example.com";
const ALICE = "alice.example@example.com";
const secret = (c: string) => c.repeat(64);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-admin-devices-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_TRUST_FORGE_HEADERS = "1";
  process.env.BAB_MAINTAINERS = MAINT;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_FORGE_HEADERS;
  delete process.env.BAB_MAINTAINERS;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

function mockHeaders(map: Record<string, string>) {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(map) }));
}
function asViewer(email: string, name = "Some Viewer") {
  mockHeaders({ "x-auth-request-user": "forge-admin", "x-auth-request-email": email, "x-auth-request-preferred-username": name });
}

async function seed() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: MAINT, email: MAINT, name: "Mia Maint", roles: [] });
  upsertUser({ id: ALICE, email: ALICE, name: "Alice Example", roles: [] });
  const d = await import("../lib/devices");
  d.bindDevice(d.hashSecret(secret("a"))!, ALICE, "Alices laptop", null);
  return { d, id: d.listDevices(ALICE)[0].id };
}

function revoke(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/admin/links/devices/revoke", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /admin/links/devices/revoke", () => {
  it("lets a maintainer revoke anyone's device and audits it", async () => {
    const { d, id } = await seed();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/devices/revoke/route");
    const res = await POST(revoke({ id }));
    expect(res.status).toBe(200);
    expect(d.listDevices(ALICE)).toHaveLength(0);
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT actor_id FROM audit_log WHERE action = 'device-revoke' AND entity_id = ?").get(id);
    expect(row).toEqual({ actor_id: MAINT });
  });

  it("403s for a non-maintainer and revokes nothing", async () => {
    const { d, id } = await seed();
    asViewer("someone.else@example.com");
    const { POST } = await import("../app/admin/links/devices/revoke/route");
    expect((await POST(revoke({ id }))).status).toBe(403);
    expect(d.listDevices(ALICE)).toHaveLength(1);
  });

  it("403s with a clear message while BAB_MAINTAINERS is unset", async () => {
    const { id } = await seed();
    delete process.env.BAB_MAINTAINERS;
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/devices/revoke/route");
    const res = await POST(revoke({ id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("BAB_MAINTAINERS is not configured");
  });

  it("refuses agent headers even for a maintainer email (401)", async () => {
    const { d, id } = await seed();
    mockHeaders({ "x-bab-actor-email": MAINT, "x-bab-actor-name": "Mia Maint" });
    const { POST } = await import("../app/admin/links/devices/revoke/route");
    expect((await POST(revoke({ id }))).status).toBe(401);
    expect(d.listDevices(ALICE)).toHaveLength(1);
  });

  it("403s cross-origin and 415s for text/plain (sameOrigin and a JSON body)", async () => {
    const { d, id } = await seed();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/devices/revoke/route");
    expect((await POST(revoke({ id }, { origin: "https://evil.forge.example.com" }))).status).toBe(403);
    expect((await POST(revoke({ id }, { "content-type": "text/plain" }))).status).toBe(415);
    expect(d.listDevices(ALICE)).toHaveLength(1);
  });

  it("404s an unknown or already revoked device and 400s a missing id", async () => {
    const { id } = await seed();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/devices/revoke/route");
    expect((await POST(revoke({ id: "nope" }))).status).toBe(404);
    expect((await POST(revoke({}))).status).toBe(400);
    expect((await POST(revoke({ id }))).status).toBe(200);
    expect((await POST(revoke({ id }))).status).toBe(404);
  });
});

describe("/admin/links page devices list", () => {
  async function render() {
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: Page } = await import("../app/admin/links/page");
    return new Response(await renderToReadableStream((await Page()) as never)).text();
  }

  it("lists devices for a maintainer with the person, label and a Revoke each", async () => {
    await seed();
    asViewer(MAINT);
    const html = await render();
    expect(html).toContain("Devices");
    expect(html).toContain(ALICE);
    expect(html).toContain("Alices laptop");
    expect(html).toContain("Revoke");
  });

  it("shows the address each device identified from", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: MAINT, email: MAINT, name: "Mia Maint", roles: [] });
    const d = await import("../lib/devices");
    d.bindDevice(d.hashSecret(secret("a"))!, ALICE, "Alices laptop", "192.0.2.44");
    asViewer(MAINT);
    const html = await render();
    expect(html).toContain("From");
    expect(html).toContain("192.0.2.44");
  });

  it("never shows a secret or hash", async () => {
    const { d } = await seed();
    asViewer(MAINT);
    const html = await render();
    expect(html).not.toContain(secret("a"));
    expect(html).not.toContain(d.hashSecret(secret("a"))!);
  });

  it("says so when there are none", async () => {
    asViewer(MAINT);
    expect(await render()).toContain("No devices yet.");
  });

  it("does not list a revoked device", async () => {
    const { d, id } = await seed();
    d.revokeDevice(id, { id: ALICE });
    asViewer(MAINT);
    const html = await render();
    expect(html).not.toContain("Alices laptop");
  });

  it("is a 404 for a non-maintainer", async () => {
    await seed();
    asViewer(ALICE, "Alice Example");
    await expect(render()).rejects.toThrow();
  });
});

describe("/admin/links devices: unverified addresses", () => {
  it("labels the address until the proxy header is verified", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: MAINT, email: MAINT, name: "Mia Maint", roles: [] });
    const d = await import("../lib/devices");
    d.bindDevice(d.hashSecret(secret("a"))!, ALICE, "Alices laptop", "192.0.2.44");
    asViewer(MAINT);
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: Page } = await import("../app/admin/links/page");
    const html = await new Response(await renderToReadableStream((await Page()) as never)).text();
    expect(html).toContain("192.0.2.44 (unverified)");
  });
});
