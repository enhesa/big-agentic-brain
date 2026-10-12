import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;
const MAINT = "mia.maint@example.com";
const TARGET = "alice.example@example.com";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-admin-links-test-"));
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
  vi.restoreAllMocks();
  vi.resetModules();
});

function mockHeaders(map: Record<string, string>) {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(map) }));
}
function asViewer(email: string, name = "Some Viewer") {
  mockHeaders({ "x-auth-request-user": "forge-admin", "x-auth-request-email": email, "x-auth-request-preferred-username": name });
}

/** A wrongly linked alias viewer. */
async function seedLink() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: TARGET, email: TARGET, name: null, roles: [] });
  upsertUser({ id: MAINT, email: MAINT, name: "Mia Maint", roles: [] });
  const { claimSuggestedLink, getLinkedUserId } = await import("../lib/forge-links");
  claimSuggestedLink("oid-wrong", "aexample@example.com", "Alice Example", TARGET);
  expect(getLinkedUserId("oid-wrong")).toBe(TARGET);
}

function unlink(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/admin/links/unlink", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /admin/links/unlink", () => {
  it("removes the link by email and audits it", async () => {
    await seedLink();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/unlink/route");
    const res = await POST(unlink({ email: TARGET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 1 });

    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId("oid-wrong")).toBeNull();

    const { getDb } = await import("../lib/db");
    const row = getDb()
      .prepare("SELECT actor_id, entity, entity_id, via, details FROM audit_log WHERE action = 'unlink-browser'")
      .get() as { actor_id: string; entity: string; entity_id: string; via: string; details: string };
    expect({ ...row, details: JSON.parse(row.details) }).toEqual({
      actor_id: MAINT,
      entity: "forge_link",
      entity_id: "oid-wrong",
      via: "ui",
      details: { email: TARGET, devicesRevoked: 0, connectionsEnded: 0 },
    });
  });

  it("removes the link by forge user id", async () => {
    await seedLink();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/unlink/route");
    expect((await POST(unlink({ forgeUserId: "oid-wrong" }))).status).toBe(200);
    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId("oid-wrong")).toBeNull();
  });

  it("404s when nothing matches, and 400s on a body with neither field", async () => {
    await seedLink();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/unlink/route");
    expect((await POST(unlink({ email: "nobody.here@example.com" }))).status).toBe(404);
    expect((await POST(unlink({}))).status).toBe(400);
  });

  it("403s for a viewer who is not a maintainer, changing nothing", async () => {
    await seedLink();
    asViewer("alice.example@example.com");
    const { POST } = await import("../app/admin/links/unlink/route");
    expect((await POST(unlink({ email: TARGET }))).status).toBe(403);
    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId("oid-wrong")).toBe(TARGET);
  });

  it("403s with a clear message while BAB_MAINTAINERS is unset", async () => {
    await seedLink();
    delete process.env.BAB_MAINTAINERS;
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/unlink/route");
    const res = await POST(unlink({ email: TARGET }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("BAB_MAINTAINERS is not configured");
  });

  it("refuses agent headers even for a maintainer email (401)", async () => {
    await seedLink();
    mockHeaders({ "x-bab-actor-email": MAINT, "x-bab-actor-name": "Mia Maint" });
    const { POST } = await import("../app/admin/links/unlink/route");
    expect((await POST(unlink({ email: TARGET }))).status).toBe(401);
  });

  it("403s cross-origin and 415s for text/plain", async () => {
    await seedLink();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/unlink/route");
    expect((await POST(unlink({ email: TARGET }, { origin: "https://evil.forge.example.com" }))).status).toBe(403);
    expect((await POST(unlink({ email: TARGET }, { "content-type": "text/plain" }))).status).toBe(415);
    const { getLinkedUserId } = await import("../lib/forge-links");
    expect(getLinkedUserId("oid-wrong")).toBe(TARGET);
  });
});

describe("/admin/links page", () => {
  async function render() {
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: Page } = await import("../app/admin/links/page");
    return new Response(await renderToReadableStream((await Page()) as never)).text();
  }

  it("lists links for a maintainer, with the forge name and email from the claim audit", async () => {
    await seedLink();
    asViewer(MAINT);
    const html = await render();
    expect(html).toContain(TARGET);
    expect(html).toContain("oid-wrong");
    expect(html).toContain("aexample@example.com");
    expect(html).toContain("Alice Example");
    expect(html).toContain("Unlink");
  });

  it("is a 404 for a non-maintainer", async () => {
    await seedLink();
    asViewer("alice.example@example.com");
    await expect(render()).rejects.toThrow();
  });

  it("is a 404 while BAB_MAINTAINERS is unset", async () => {
    await seedLink();
    delete process.env.BAB_MAINTAINERS;
    asViewer(MAINT);
    await expect(render()).rejects.toThrow();
  });
});
