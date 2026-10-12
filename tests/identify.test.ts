import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * lib/identify.ts: bab_identify, the honour-system identity (owner, 2026-10-01). BAB is internal
 * and VPN-only, so a client says who it is and BAB remembers that on the device secret, or else on
 * the MCP connection, or else for the one call. Secrets are assembled at runtime.
 */

let dataDir: string;
const ALICE = "alice.example@example.com";
const MARIE = "marie.curie@example.com";
const secret = (c: string) => c.repeat(64);
const SESSION = (c: string) => c.repeat(43);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-identify-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetIdentifyLimiterForTests, _setIdentifyClockForTests } = await import("../lib/identify");
  _resetIdentifyLimiterForTests();
  _setIdentifyClockForTests();
  const { _setDeviceClockForTests } = await import("../lib/devices");
  _setDeviceClockForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_DEVICES;
  (await import("../lib/config"))._resetConfigForTests();
});

async function deps() {
  const identify = await import("../lib/identify");
  const devices = await import("../lib/devices");
  const connections = await import("../lib/mcp-connections");
  const { getDb } = await import("../lib/db");
  return { ...identify, devices, connections, db: getDb() };
}

const ctxOf = async (over: Partial<{ deviceHash: string | null; deviceLabel: string; connectionId: string | null; ip: string | null }> = {}) => {
  const { devices } = await deps();
  return { deviceHash: devices.hashSecret(secret("a")), deviceLabel: "Windows laptop", connectionId: null, ip: "192.0.2.9", ...over };
};

describe("the address and the name", () => {
  it("accepts a long-form work address, lower-cased and trimmed, and derives the name when none is given", async () => {
    const { identify } = await deps();
    const out = identify({ email: "  Alice.Example@Example.com " }, await ctxOf());
    expect(out.identifiedAs).toEqual({ email: ALICE, name: "Alice Example" });
  });

  it("uses the name given on first use, and the stored name wins afterwards", async () => {
    const { identify } = await deps();
    expect(identify({ email: ALICE, name: "Alice Example" }, await ctxOf()).identifiedAs.name).toBe("Alice Example");
    expect(identify({ email: ALICE, name: "Someone Different" }, await ctxOf()).identifiedAs.name).toBe("Alice Example");
  });

  it("treats an empty or blank name as absent", async () => {
    const { identify } = await deps();
    expect(identify({ email: MARIE, name: "   " }, await ctxOf()).identifiedAs.name).toBe("Marie Curie");
    expect(identify({ email: "ada.lovelace@example.com", name: "" }, await ctxOf()).identifiedAs.name).toBe("Ada Lovelace");
  });

  it.each([
    ["the short alias", "aexample@example.com", /long address|first\.last@example.com/],
    ["another domain", "alice.example@other.test", /@example.com/],
    ["no address", "", /email is required|first\.last@example.com/],
    ["not an address", "Alice Example", /first\.last@example.com/],
  ])("refuses %s", async (_label, email, message) => {
    const { identify } = await deps();
    expect(() => identify({ email }, await_ctx_sync())).toThrow(message);
  });

  it("refuses a name that is a single character or longer than 80", async () => {
    const { identify } = await deps();
    expect(() => identify({ email: ALICE, name: "I" }, await_ctx_sync())).toThrow(/2-80/);
    expect(() => identify({ email: ALICE, name: "x".repeat(81) }, await_ctx_sync())).toThrow(/2-80/);
  });

  it("creates the users row, so the person exists for messages and reminders", async () => {
    const { identify, db } = await deps();
    identify({ email: ALICE }, await ctxOf());
    expect(db.prepare("SELECT name FROM users WHERE id = ?").get(ALICE)).toEqual({ name: "Alice Example" });
  });
});

// A context that never reaches the database: validation fails before anything is read.
function await_ctx_sync() {
  return { deviceHash: null, deviceLabel: "Unknown device", connectionId: null, ip: null };
}

describe("remembered on the device", () => {
  it("binds the device secret to the person, with the label and address", async () => {
    const { identify, devices } = await deps();
    const out = identify({ email: ALICE }, await ctxOf());
    expect(out.remembered).toBe("device");
    const device = devices.lookupDevice(devices.hashSecret(secret("a"))!)!;
    expect(device.userId).toBe(ALICE);
    expect(device.label).toBe("Windows laptop");
    expect(devices.listDevices(ALICE)[0].connectedIp).toBe("192.0.2.9");
  });

  it("identifying again as the same person keeps one device row", async () => {
    const { identify, devices } = await deps();
    identify({ email: ALICE }, await ctxOf());
    identify({ email: ALICE }, await ctxOf({ deviceLabel: "Renamed laptop" }));
    const list = devices.listDevices(ALICE);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("Renamed laptop");
  });

  it("may rebind a device bound to someone else (the honour system), and audits it as device-rebind with old and new", async () => {
    const { identify, devices, db } = await deps();
    identify({ email: ALICE }, await ctxOf());
    const id = devices.listDevices(ALICE)[0].id;
    identify({ email: MARIE }, await ctxOf());
    expect(devices.lookupDevice(devices.hashSecret(secret("a"))!)!.userId).toBe(MARIE);
    expect(devices.listDevices(ALICE)).toHaveLength(0);

    const row = db.prepare("SELECT actor_id, entity, entity_id, details FROM audit_log WHERE action = 'device-rebind'").get() as {
      actor_id: string;
      entity: string;
      entity_id: string;
      details: string;
    };
    expect(row.actor_id).toBe(MARIE);
    expect(row.entity).toBe("device");
    expect(row.entity_id).toBe(id);
    expect(JSON.parse(row.details)).toMatchObject({ from: ALICE, to: MARIE });
  });

  it("does not audit a rebind when the same person identifies again, or for a first bind", async () => {
    const { identify, db } = await deps();
    identify({ email: ALICE }, await ctxOf());
    identify({ email: ALICE }, await ctxOf());
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'device-rebind'").get()).toEqual({ n: 0 });
  });

  it("a forgotten (revoked) device is bound again by identifying, on the same row", async () => {
    const { identify, devices } = await deps();
    identify({ email: ALICE }, await ctxOf());
    const id = devices.listDevices(ALICE)[0].id;
    devices.revokeDevice(id, { id: ALICE });
    expect(devices.lookupDevice(devices.hashSecret(secret("a"))!)).toBeNull();
    identify({ email: ALICE }, await ctxOf());
    const list = devices.listDevices(ALICE);
    expect(list.map((d) => d.id)).toEqual([id]);
    expect(devices.lookupDevice(devices.hashSecret(secret("a"))!)!.userId).toBe(ALICE);
  });

  it("a forgotten device may be bound to someone else", async () => {
    const { identify, devices } = await deps();
    identify({ email: ALICE }, await ctxOf());
    devices.revokeDevice(devices.listDevices(ALICE)[0].id, { id: ALICE });
    identify({ email: MARIE }, await ctxOf());
    expect(devices.listDevices(MARIE)).toHaveLength(1);
  });

  it("device wins over a connection when the request has both, and the connection is left alone", async () => {
    const { identify, connections } = await deps();
    const id = connections._insertConnectionForTests();
    const out = identify({ email: ALICE }, await ctxOf({ connectionId: id }));
    expect(out.remembered).toBe("device");
    expect(connections.lookupConnection(id)!.userId).toBeNull();
  });

  it("stores only the hash, never the secret, and audits without either", async () => {
    const { identify, db, devices } = await deps();
    identify({ email: ALICE }, await ctxOf());
    const dump = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
    expect(dump).not.toContain(secret("a"));
    expect(dump).not.toContain(devices.hashSecret(secret("a"))!);
  });

  it("with BAB_DEVICES=0 the device is not used", async () => {
    const { identify } = await deps();
    process.env.BAB_DEVICES = "0";
    (await import("../lib/config"))._resetConfigForTests();
    expect(identify({ email: ALICE }, await ctxOf()).remembered).toBe("none");
  });
});

describe("remembered on the connection", () => {
  it("binds the MCP connection when there is no device", async () => {
    const { identify, connections } = await deps();
    const id = connections._insertConnectionForTests();
    const out = identify({ email: ALICE }, await ctxOf({ deviceHash: null, connectionId: id }));
    expect(out).toMatchObject({ identifiedAs: { email: ALICE }, remembered: "connection" });
    expect(connections.lookupConnection(id)!.userId).toBe(ALICE);
  });

  it("may rebind a connection to someone else", async () => {
    const { identify, connections } = await deps();
    const id = connections._insertConnectionForTests();
    identify({ email: ALICE }, await ctxOf({ deviceHash: null, connectionId: id }));
    identify({ email: MARIE }, await ctxOf({ deviceHash: null, connectionId: id }));
    expect(connections.lookupConnection(id)!.userId).toBe(MARIE);
  });

  it("adopts a well-formed connection id BAB has not seen (the server restarted or the row expired)", async () => {
    const { identify, connections } = await deps();
    const out = identify({ email: ALICE }, await ctxOf({ deviceHash: null, connectionId: SESSION("q") }));
    expect(out.remembered).toBe("connection");
    expect(connections.lookupConnection(SESSION("q"))!.userId).toBe(ALICE);
  });
});

describe("remembered for this call only", () => {
  it("says so when the client keeps neither a device nor a session", async () => {
    const { identify, devices } = await deps();
    const out = identify({ email: ALICE }, await ctxOf({ deviceHash: null, connectionId: null }));
    expect(out.remembered).toBe("none");
    expect(out.identifiedAs.email).toBe(ALICE);
    expect(out.note).toBe("BAB cannot remember you in this app (no device or session), so its tools will keep asking. Tell the user once, in plain words, and do not retry bab_identify in this session. The fix: in the BAB plugin's settings, fill in \"your work address\" and \"your display name\", then restart Claude.");
    expect(devices.listAllDevices()).toHaveLength(0);
  });

  it("has no note when something is remembered", async () => {
    const { identify } = await deps();
    expect(identify({ email: ALICE }, await ctxOf()).note).toBeUndefined();
  });
});

describe("audit", () => {
  it.each([
    ["device", {}],
    ["connection", { deviceHash: null, connectionId: SESSION("c") }],
    ["none", { deviceHash: null, connectionId: null }],
  ] as const)("every identify is audited with its source (%s)", async (source, over) => {
    const { identify, db } = await deps();
    identify({ email: ALICE }, await ctxOf(over));
    const row = db.prepare("SELECT actor_id, entity, entity_id, details FROM audit_log WHERE action = 'identify'").get() as {
      actor_id: string;
      entity: string;
      entity_id: string;
      details: string;
    };
    expect(row.actor_id).toBe(ALICE);
    expect(row.entity_id).toBe(ALICE);
    expect(JSON.parse(row.details)).toMatchObject({ source, ip: "192.0.2.9" });
  });

  it("a refused identify writes no identify row", async () => {
    const { identify, db } = await deps();
    const ctx = await ctxOf();
    expect(() => identify({ email: "nope" }, ctx)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'identify'").get()).toEqual({ n: 0 });
  });
});

describe("rate limit: IDENTIFY_LIMIT_PER_MINUTE a minute per device or connection", () => {
  it("has the raised limits (60 a key, 300 an address)", async () => {
    const { IDENTIFY_LIMIT_PER_MINUTE, IDENTIFY_LIMIT_PER_ADDRESS_PER_MINUTE } = await deps();
    expect(IDENTIFY_LIMIT_PER_MINUTE).toBe(60);
    expect(IDENTIFY_LIMIT_PER_ADDRESS_PER_MINUTE).toBe(300);
  });

  it("allows the limit, refuses the next, and clears after a minute", async () => {
    const { identify, TooManyIdentifiesError, IDENTIFY_LIMIT_PER_MINUTE, _setIdentifyClockForTests } = await deps();
    let now = 1_000_000;
    _setIdentifyClockForTests(() => now);
    const ctx = await ctxOf();
    for (let i = 0; i < IDENTIFY_LIMIT_PER_MINUTE; i++) identify({ email: ALICE }, ctx);
    expect(() => identify({ email: ALICE }, ctx)).toThrow(TooManyIdentifiesError);
    now += 60_001;
    expect(() => identify({ email: ALICE }, ctx)).not.toThrow();
  });

  it("counts per device and per connection, not globally", async () => {
    const { identify, TooManyIdentifiesError, devices, IDENTIFY_LIMIT_PER_MINUTE } = await deps();
    const a = await ctxOf();
    const b = await ctxOf({ deviceHash: devices.hashSecret(secret("b")) });
    const c = await ctxOf({ deviceHash: null, connectionId: SESSION("c") });
    for (let i = 0; i < IDENTIFY_LIMIT_PER_MINUTE; i++) identify({ email: ALICE }, a);
    expect(() => identify({ email: ALICE }, a)).toThrow(TooManyIdentifiesError);
    expect(() => identify({ email: ALICE }, b)).not.toThrow();
    expect(() => identify({ email: ALICE }, c)).not.toThrow();
  });

  it("a caller with neither is limited by address", async () => {
    const { identify, TooManyIdentifiesError, IDENTIFY_LIMIT_PER_MINUTE } = await deps();
    const none = await ctxOf({ deviceHash: null, connectionId: null, ip: "192.0.2.50" });
    for (let i = 0; i < IDENTIFY_LIMIT_PER_MINUTE; i++) identify({ email: ALICE }, none);
    expect(() => identify({ email: ALICE }, none)).toThrow(TooManyIdentifiesError);
    expect(() => identify({ email: ALICE }, { ...none, ip: "192.0.2.51" })).not.toThrow();
  });

  it("a refused (invalid) attempt still counts, so guessing is not free", async () => {
    const { identify, TooManyIdentifiesError, IDENTIFY_LIMIT_PER_MINUTE } = await deps();
    const ctx = await ctxOf();
    for (let i = 0; i < IDENTIFY_LIMIT_PER_MINUTE; i++) expect(() => identify({ email: "nope" }, ctx)).toThrow(/first\.last/);
    expect(() => identify({ email: ALICE }, ctx)).toThrow(TooManyIdentifiesError);
  });
});

describe("rate limit per client address: IDENTIFY_LIMIT_PER_ADDRESS_PER_MINUTE a minute alongside the device or connection key", () => {
  it("rotating device secrets from one address stops at the address limit", async () => {
    const { identify, TooManyIdentifiesError, devices, IDENTIFY_LIMIT_PER_ADDRESS_PER_MINUTE } = await deps();
    for (let i = 0; i < IDENTIFY_LIMIT_PER_ADDRESS_PER_MINUTE; i++) {
      const ctx = await ctxOf({ deviceHash: devices.hashSecret(`${i.toString(16).padStart(4, "0")}${"a".repeat(60)}`), ip: "192.0.2.70" });
      identify({ email: ALICE }, ctx);
    }
    const next = await ctxOf({ deviceHash: devices.hashSecret(secret("f")), ip: "192.0.2.70" });
    expect(() => identify({ email: ALICE }, next)).toThrow(TooManyIdentifiesError);
    // Another address is untouched.
    expect(() => identify({ email: ALICE }, { ...next, ip: "192.0.2.71" })).not.toThrow();
  });

  it("rotating connection ids from one address is limited too", async () => {
    const { identify, TooManyIdentifiesError, IDENTIFY_LIMIT_PER_ADDRESS_PER_MINUTE } = await deps();
    for (let i = 0; i < IDENTIFY_LIMIT_PER_ADDRESS_PER_MINUTE; i++) {
      identify({ email: ALICE }, { deviceHash: null, deviceLabel: "L", connectionId: String(i).padStart(43, "q"), ip: "192.0.2.72" });
    }
    expect(() => identify({ email: ALICE }, { deviceHash: null, deviceLabel: "L", connectionId: "z".repeat(43), ip: "192.0.2.72" })).toThrow(
      TooManyIdentifiesError,
    );
  });

  it("a refused attempt counts nowhere, and the window clears after a minute", async () => {
    const { identify, TooManyIdentifiesError, IDENTIFY_LIMIT_PER_MINUTE, _setIdentifyClockForTests } = await deps();
    let now = 1_000_000;
    _setIdentifyClockForTests(() => now);
    const ctx = await ctxOf({ ip: "192.0.2.73" });
    for (let i = 0; i < IDENTIFY_LIMIT_PER_MINUTE; i++) identify({ email: ALICE }, ctx);
    for (let i = 0; i < 5; i++) expect(() => identify({ email: ALICE }, ctx)).toThrow(TooManyIdentifiesError);
    now += 60_001;
    expect(() => identify({ email: ALICE }, ctx)).not.toThrow();
  });
});

describe("the limiter map is pruned in bounded time", () => {
  it("a full map is scanned at most once a minute, not on every call", async () => {
    const { identify, _setIdentifyClockForTests, _limiterSizeForTests } = await deps();
    let now = 5_000_000;
    _setIdentifyClockForTests(() => now);
    const ctxFor = (ip: string) => ({ deviceHash: null, deviceLabel: "L", connectionId: null, ip });
    // 6000 distinct addresses fill the map past the prune threshold.
    for (let i = 0; i < 6000; i++) identify({ email: ALICE }, ctxFor(`10.${i >> 8}.${i & 255}.1`));
    expect(_limiterSizeForTests()).toBeGreaterThan(5000);
    // A minute later every entry is old; the next call prunes them once.
    now += 61_000;
    identify({ email: ALICE }, ctxFor("10.250.250.250"));
    expect(_limiterSizeForTests()).toBeLessThan(10);
    // Fill again inside the same minute: no second scan, so the map keeps its entries.
    for (let i = 0; i < 5100; i++) identify({ email: ALICE }, ctxFor(`11.${i >> 8}.${i & 255}.1`));
    now += 1000;
    identify({ email: ALICE }, ctxFor("11.250.250.250"));
    expect(_limiterSizeForTests()).toBeGreaterThan(5000);
  });
});
