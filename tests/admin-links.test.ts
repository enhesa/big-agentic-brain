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
  process.env.BAB_TRUST_PROXY_IDENTITY = "1";
  process.env.BAB_MAINTAINERS = MAINT;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  delete process.env.BAB_MAINTAINERS;
  vi.doUnmock("next/headers");
  vi.restoreAllMocks();
  vi.resetModules();
});

function mockHeaders(map: Record<string, string>) {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(map) }));
}
function asViewer(email: string, name = "Some Viewer") {
  mockHeaders({ "x-auth-request-user": "proxy-admin", "x-auth-request-email": email, "x-auth-request-preferred-username": name });
}

/** A wrongly linked alias viewer. */
async function seedLink() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: TARGET, email: TARGET, name: null, roles: [] });
  upsertUser({ id: MAINT, email: MAINT, name: "Mia Maint", roles: [] });
  const { claimSuggestedLink, getLinkedUserId } = await import("../lib/proxy-links");
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

    const { getLinkedUserId } = await import("../lib/proxy-links");
    expect(getLinkedUserId("oid-wrong")).toBeNull();

    const { getDb } = await import("../lib/db");
    const row = getDb()
      .prepare("SELECT actor_id, entity, entity_id, via, details FROM audit_log WHERE action = 'unlink-browser'")
      .get() as { actor_id: string; entity: string; entity_id: string; via: string; details: string };
    expect({ ...row, details: JSON.parse(row.details) }).toEqual({
      actor_id: MAINT,
      entity: "proxy_link",
      entity_id: "oid-wrong",
      via: "ui",
      details: { email: TARGET, devicesRevoked: 0, connectionsEnded: 0 },
    });
  });

  it("removes the link by proxy user id", async () => {
    await seedLink();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/unlink/route");
    expect((await POST(unlink({ proxyUserId: "oid-wrong" }))).status).toBe(200);
    const { getLinkedUserId } = await import("../lib/proxy-links");
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
    const { getLinkedUserId } = await import("../lib/proxy-links");
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
    expect((await POST(unlink({ email: TARGET }, { origin: "https://evil.example.com" }))).status).toBe(403);
    expect((await POST(unlink({ email: TARGET }, { "content-type": "text/plain" }))).status).toBe(415);
    const { getLinkedUserId } = await import("../lib/proxy-links");
    expect(getLinkedUserId("oid-wrong")).toBe(TARGET);
  });
});

const REFUSED = "oid-refused";

/** A colleague with a middle name whose typed claim was refused (guessed alias differs). */
async function seedRefusal() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: MAINT, email: MAINT, name: "Mia Maint", roles: [] });
  const { claimTypedIdentity } = await import("../lib/proxy-links");
  expect(() =>
    claimTypedIdentity(REFUSED, "jpsmith@example.com", "John Paul Smith", "john.paul.smith@example.com"),
  ).toThrow(/admin\/links/);
}

function link(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/admin/links/link", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /admin/links/link", () => {
  it("links a refused sign-in user to an address and audits it with the sign-in email and name", async () => {
    await seedRefusal();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/link/route");
    const res = await POST(link({ proxyUserId: REFUSED, email: " John.Paul.Smith@Example.com " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: "john.paul.smith@example.com" });

    const { getLinkedUserId, listRefusedSignIns, listLinks } = await import("../lib/proxy-links");
    expect(getLinkedUserId(REFUSED)).toBe("john.paul.smith@example.com");
    expect(listRefusedSignIns()).toEqual([]);
    expect(listLinks()[0]).toMatchObject({ proxyUserId: REFUSED, proxyEmail: "jpsmith@example.com", proxyName: "John Paul Smith" });

    const { getDb } = await import("../lib/db");
    const row = getDb()
      .prepare("SELECT actor_id, entity, entity_id, via, details FROM audit_log WHERE action = 'link-browser-admin'")
      .get() as { actor_id: string; entity: string; entity_id: string; via: string; details: string };
    expect({ ...row, details: JSON.parse(row.details) }).toEqual({
      actor_id: MAINT,
      entity: "proxy_link",
      entity_id: REFUSED,
      via: "ui",
      details: { email: "john.paul.smith@example.com", proxyEmail: "jpsmith@example.com", proxyName: "John Paul Smith" },
    });
  });

  it("is idempotent for the same address and 409s for another one", async () => {
    await seedRefusal();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/link/route");
    expect((await POST(link({ proxyUserId: REFUSED, email: "john.paul.smith@example.com" }))).status).toBe(200);
    expect((await POST(link({ proxyUserId: REFUSED, email: "john.paul.smith@example.com" }))).status).toBe(200);
    expect((await POST(link({ proxyUserId: REFUSED, email: "jane.other@example.com" }))).status).toBe(409);
  });

  it("keeps first come wins: 409 when the address is linked to another browser", async () => {
    await seedRefusal();
    await seedLink();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/link/route");
    expect((await POST(link({ proxyUserId: REFUSED, email: TARGET }))).status).toBe(409);
    const { getLinkedUserId } = await import("../lib/proxy-links");
    expect(getLinkedUserId(REFUSED)).toBeNull();
    expect(getLinkedUserId("oid-wrong")).toBe(TARGET);
  });

  it("404s for a user id with no refusal on record, 400s on a bad address or no id", async () => {
    await seedRefusal();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/link/route");
    expect((await POST(link({ proxyUserId: "oid-unknown", email: "john.paul.smith@example.com" }))).status).toBe(404);
    expect((await POST(link({ proxyUserId: REFUSED, email: "jsmith@example.com" }))).status).toBe(400);
    expect((await POST(link({ email: "john.paul.smith@example.com" }))).status).toBe(400);
    const { getLinkedUserId } = await import("../lib/proxy-links");
    expect(getLinkedUserId(REFUSED)).toBeNull();
  });

  it("403s for a non-maintainer and while BAB_MAINTAINERS is unset, linking nothing", async () => {
    await seedRefusal();
    asViewer("alice.example@example.com");
    const { POST } = await import("../app/admin/links/link/route");
    expect((await POST(link({ proxyUserId: REFUSED, email: "john.paul.smith@example.com" }))).status).toBe(403);
    delete process.env.BAB_MAINTAINERS;
    expect((await POST(link({ proxyUserId: REFUSED, email: "john.paul.smith@example.com" }))).status).toBe(403);
    const { getLinkedUserId } = await import("../lib/proxy-links");
    expect(getLinkedUserId(REFUSED)).toBeNull();
  });

  it("keeps the roles of an existing users row", async () => {
    await seedRefusal();
    const { upsertUser, getUser } = await import("../lib/users");
    upsertUser({ id: "john.paul.smith@example.com", email: "john.paul.smith@example.com", name: "John", roles: ["lead"] });
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/link/route");
    expect((await POST(link({ proxyUserId: REFUSED, email: "john.paul.smith@example.com" }))).status).toBe(200);
    expect(getUser("john.paul.smith@example.com")?.roles).toBe("lead");
  });

  it("drops a refusal from before an unlink: not listed, and no longer enough to link", async () => {
    await seedRefusal();
    asViewer(MAINT);
    const { POST } = await import("../app/admin/links/link/route");
    expect((await POST(link({ proxyUserId: REFUSED, email: "john.paul.smith@example.com" }))).status).toBe(200);
    const { unlinkBrowser, listRefusedSignIns } = await import("../lib/proxy-links");
    unlinkBrowser(MAINT, { proxyUserId: REFUSED });
    expect(listRefusedSignIns()).toEqual([]);
    expect((await POST(link({ proxyUserId: REFUSED, email: "john.paul.smith@example.com" }))).status).toBe(404);
  });

  it("401s for agent headers, 403s cross-origin, 415s for text/plain", async () => {
    await seedRefusal();
    mockHeaders({ "x-bab-actor-email": MAINT, "x-bab-actor-name": "Mia Maint" });
    const { POST } = await import("../app/admin/links/link/route");
    const body = { proxyUserId: REFUSED, email: "john.paul.smith@example.com" };
    expect((await POST(link(body))).status).toBe(401);
    expect((await POST(link(body, { origin: "https://evil.example.com" }))).status).toBe(403);
    expect((await POST(link(body, { "content-type": "text/plain" }))).status).toBe(415);
  });
});

describe("/admin/links page", () => {
  async function render() {
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: Page } = await import("../app/admin/links/page");
    return new Response(await renderToReadableStream((await Page()) as never)).text();
  }

  it("lists links for a maintainer, with the proxy name and email from the claim audit", async () => {
    await seedLink();
    asViewer(MAINT);
    const html = await render();
    expect(html).toContain(TARGET);
    expect(html).toContain("oid-wrong");
    expect(html).toContain("aexample@example.com");
    expect(html).toContain("Alice Example");
    expect(html).toContain("Unlink");
  });

  it("lists refused sign-ins with the sign-in email, name, reason and a prefilled Link form", async () => {
    await seedRefusal();
    asViewer(MAINT);
    const html = await render();
    expect(html).toContain("Refused sign-ins");
    expect(html).toContain(REFUSED);
    expect(html).toContain("jpsmith@example.com");
    expect(html).toContain("John Paul Smith");
    expect(html).toContain("Sign-in email does not fit");
    expect(html).toContain('value="john.paul.smith@example.com"');
  });

  it("shows but does not prefill the address when the sign-in name did not fit it", async () => {
    const { claimTypedIdentity } = await import("../lib/proxy-links");
    expect(() => claimTypedIdentity("oid-other", "bother@example.com", "Bob Other", "alice.example@example.com")).toThrow();
    asViewer(MAINT);
    const html = await render();
    expect(html).toContain("oid-other");
    expect(html).toContain("alice.example@example.com");
    expect(html).toContain("Name does not fit the address");
    expect(html).not.toContain('value="alice.example@example.com"');
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
