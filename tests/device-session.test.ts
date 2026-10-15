import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Identity order on the opt-in agent paths (/api/*, /mcp): a known device, then the
 * self-asserted headers. Pages (getSessionUser) never take a device.
 */

let dataDir: string;
const ALICE = "alice.example@example.com";
const MARIE = "marie.curie@example.com";
const OTHER = "other.person@example.com";
const secret = (c: string) => c.repeat(64);
let current: Record<string, string> = {};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-device-session-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  // One mock for the whole test; mockHeaders only swaps what it returns, so a test can
  // change the request without reloading modules (which would orphan the open database).
  current = {};
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_DEVICES;
  (await import("../lib/config"))._resetConfigForTests();
  delete process.env.BAB_TRUST_PROXY_IDENTITY;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

function mockHeaders(map: Record<string, string>) {
  current = map;
}

const asHeaders = (email: string) => ({ "x-bab-actor-email": email, "x-bab-actor-name": "Some Agent" });

/** A device bound to `who`, the way bab_identify binds it. */
async function connectDevice(c: string, who: string) {
  const d = await import("../lib/devices");
  d.bindDevice(d.hashSecret(secret(c))!, who, "Test device", null);
}

const SESSION = (c: string) => c.repeat(43);

/** A connection bound to `who`, the way bab_identify binds it. */
async function connectSession(c: string, who: string) {
  const m = await import("../lib/mcp-connections");
  m.bindConnection(SESSION(c), who);
}

// Built at runtime so no token-shaped literal sits in the source. Personal tokens are gone, so
// Authorization is ignored whatever it carries.
const bearer = () => `Bearer ${["bab", "_", "B".repeat(43)].join("")}`;

describe("requireActorForApi with a device", () => {
  it("a known device decides identity with source device, and ignores X-Bab-Actor-*", async () => {
    await connectDevice("a", ALICE);
    mockHeaders({ "x-bab-device": secret("a"), ...asHeaders(OTHER) });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.source).toBe("device");
    expect(user.id).toBe(ALICE);
    expect(user.email).toBe(ALICE);
    expect(user.name).toBe("Alice Example");
  });

  it("a known device ignores Authorization (no 401, no effect)", async () => {
    await connectDevice("a", ALICE);
    mockHeaders({ "x-bab-device": secret("a"), authorization: bearer() });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.source).toBe("device");
    expect(user.id).toBe(ALICE);
  });

  it("upserts the user row, so a device user shows up like any agent", async () => {
    await connectDevice("a", ALICE);
    mockHeaders({ "x-bab-device": secret("a") });
    const { requireActorForApi } = await import("../lib/session");
    await requireActorForApi();
    const { getUser } = await import("../lib/users");
    expect(getUser(ALICE)).toBeTruthy();
  });

  it("an unknown device falls back to header identity, so current installs keep working", async () => {
    mockHeaders({ "x-bab-device": secret("e"), ...asHeaders(OTHER) });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.source).toBe("declared");
    expect(user.id).toBe(OTHER);
  });

  it("an unknown device with nothing else (Authorization does not count) is a 401, not a crash", async () => {
    mockHeaders({ "x-bab-device": secret("e"), authorization: bearer() });
    const { requireActorForApi } = await import("../lib/session");
    await expect(requireActorForApi()).rejects.toMatchObject({ status: 401 });
  });

  it("a forgotten (revoked) device is unknown: the headers decide, no 401, and it can be bound again", async () => {
    await connectDevice("a", ALICE);
    const d = await import("../lib/devices");
    d.revokeDevice(d.listDevices(ALICE)[0].id, { id: ALICE });
    mockHeaders({ "x-bab-device": secret("a"), ...asHeaders(OTHER) });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.source).toBe("declared");
    expect(user.id).toBe(OTHER);
    d.bindDevice(d.hashSecret(secret("a"))!, ALICE, "Back", null);
    expect((await requireActorForApi()).source).toBe("device");
  });

  it("a forgotten device with nothing else is a plain 401 identity-required, not a special refusal", async () => {
    await connectDevice("a", ALICE);
    const d = await import("../lib/devices");
    d.revokeDevice(d.listDevices(ALICE)[0].id, { id: ALICE });
    mockHeaders({ "x-bab-device": secret("a") });
    const { requireActorForApi } = await import("../lib/session");
    const res = await requireActorForApi().then(
      () => null,
      (e: unknown) => e as Response,
    );
    expect(res?.status).toBe(401);
    expect(await res!.text()).not.toMatch(/disconnected/);
  });

  it("the header is lowercased before it is checked, so an upper-cased hex secret is the same device", async () => {
    await connectDevice("a", ALICE);
    mockHeaders({ "x-bab-device": `  ${secret("a").toUpperCase()}  `, ...asHeaders(OTHER) });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.source).toBe("device");
    expect(user.id).toBe(ALICE);
  });

  it("a malformed device value is treated as absent", async () => {
    await connectDevice("a", ALICE);
    for (const bad of ["a".repeat(63), `${secret("a")}0`, "not hex at all"]) {
      mockHeaders({ "x-bab-device": bad, ...asHeaders(OTHER) });
      const { requireActorForApi } = await import("../lib/session");
      expect((await requireActorForApi()).source).toBe("declared");
    }
  });

  it("BAB_DEVICES=0 ignores the device header", async () => {
    await connectDevice("a", ALICE);
    process.env.BAB_DEVICES = "0";
    (await import("../lib/config"))._resetConfigForTests();
    mockHeaders({ "x-bab-device": secret("a"), ...asHeaders(OTHER) });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.source).toBe("declared");
    expect(user.id).toBe(OTHER);
  });
});

describe("SSO paths never take a device", () => {
  it("getSessionUser ignores the device header", async () => {
    await connectDevice("a", ALICE);
    mockHeaders({ "x-bab-device": secret("a") });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("a proxy viewer still wins over a device header", async () => {
    await connectDevice("a", ALICE);
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    mockHeaders({
      "x-bab-device": secret("a"),
      "x-auth-request-user": "forge-oid",
      "x-auth-request-email": "marie.curie@example.com",
      "x-auth-request-preferred-username": "Marie Curie",
    });
    const { getSessionUser } = await import("../lib/session");
    const user = await getSessionUser();
    expect(user?.source).toBe("forge");
    expect(user?.id).toBe(MARIE);
  });

  it("getViewer refuses a device-only request (browser-only routes stay browser-only)", async () => {
    await connectDevice("a", ALICE);
    mockHeaders({ "x-bab-device": secret("a") });
    const { getViewer } = await import("../lib/notify-auth");
    await expect(getViewer()).resolves.toBeNull();
  });
});

describe("deviceState", () => {
  it("reports absent, unknown and known", async () => {
    await connectDevice("a", ALICE);
    const { deviceState } = await import("../lib/session");

    mockHeaders({});
    expect(await deviceState()).toBeNull();

    mockHeaders({ "x-bab-device": secret("e") });
    const unknown = await deviceState();
    expect(unknown?.known).toBe(false);

    mockHeaders({ "x-bab-device": secret("a") });
    const known = await deviceState();
    expect(known?.known).toBe(true);
    expect(known).not.toHaveProperty("revoked");
    expect(known?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(known?.hash).not.toBe(secret("a"));
  });
});

describe("requireActorForApi with an identified connection (Mcp-Session-Id)", () => {
  it("a known, identified connection decides identity with source connection, and ignores X-Bab-Actor-*", async () => {
    await connectSession("c", ALICE);
    mockHeaders({ "mcp-session-id": SESSION("c"), ...asHeaders(OTHER) });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.source).toBe("connection");
    expect(user.id).toBe(ALICE);
    expect(user.name).toBe("Alice Example");
  });

  it("a known device beats a known connection", async () => {
    await connectDevice("a", ALICE);
    await connectSession("c", OTHER);
    mockHeaders({ "x-bab-device": secret("a"), "mcp-session-id": SESSION("c") });
    const { requireActorForApi } = await import("../lib/session");
    const user = await requireActorForApi();
    expect(user.source).toBe("device");
    expect(user.id).toBe(ALICE);
  });

  it("an unknown device does not hide a known connection", async () => {
    await connectSession("c", ALICE);
    mockHeaders({ "x-bab-device": secret("e"), "mcp-session-id": SESSION("c") });
    const { requireActorForApi } = await import("../lib/session");
    expect((await requireActorForApi()).source).toBe("connection");
  });

  it("a connection that was never identified falls through to the headers", async () => {
    const { _insertConnectionForTests } = await import("../lib/mcp-connections");
    const id = _insertConnectionForTests();
    mockHeaders({ "mcp-session-id": id, ...asHeaders(OTHER) });
    const { requireActorForApi } = await import("../lib/session");
    expect((await requireActorForApi()).source).toBe("declared");
  });

  it("an unknown or malformed session id is no connection, never an error", async () => {
    for (const id of [SESSION("u"), "garbage", ""]) {
      mockHeaders({ "mcp-session-id": id, ...asHeaders(OTHER) });
      const { requireActorForApi } = await import("../lib/session");
      expect((await requireActorForApi()).source).toBe("declared");
    }
  });

  it("is honoured, and BAB_DEVICES=0 switches it off with the devices", async () => {
    await connectSession("c", ALICE);
    mockHeaders({ "mcp-session-id": SESSION("c"), ...asHeaders(OTHER) });
    const { requireActorForApi } = await import("../lib/session");
    expect((await requireActorForApi()).source).toBe("connection");
    process.env.BAB_DEVICES = "0";
    (await import("../lib/config"))._resetConfigForTests();
    expect((await requireActorForApi()).source).toBe("declared");
  });

  it("SSO paths never take a connection: getSessionUser ignores it, and getViewer refuses it", async () => {
    await connectSession("c", ALICE);
    mockHeaders({ "mcp-session-id": SESSION("c") });
    const { getSessionUser } = await import("../lib/session");
    await expect(getSessionUser()).resolves.toBeNull();
    const { getViewer } = await import("../lib/notify-auth");
    await expect(getViewer()).resolves.toBeNull();
  });

  it("a proxy viewer still wins over a connection header", async () => {
    await connectSession("c", ALICE);
    process.env.BAB_TRUST_PROXY_IDENTITY = "1";
    mockHeaders({
      "mcp-session-id": SESSION("c"),
      "x-auth-request-user": "forge-oid",
      "x-auth-request-email": "marie.curie@example.com",
      "x-auth-request-preferred-username": "Marie Curie",
    });
    const { getSessionUser } = await import("../lib/session");
    expect((await getSessionUser())?.source).toBe("forge");
  });

  it("ownerIdFor treats a connection user like a declared agent, never a browser viewer", async () => {
    const { ownerIdFor } = await import("../lib/reminders-view");
    expect(ownerIdFor({ id: ALICE, email: ALICE, source: "connection" })).toBe(ALICE);
  });
});
