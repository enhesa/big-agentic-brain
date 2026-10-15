import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkForTests } from "./link-helper";

/**
 * lib/devices.ts: the device secret hash, the device row, forgetting a device. A device is bound
 * by bab_identify (tests/identify.test.ts covers that path); here the row is bound directly.
 * Secrets are assembled at runtime so no credential-shaped literal sits in the source.
 */

let dataDir: string;
const ALICE = "alice.example@example.com";
const MARIE = "marie.curie@example.com";
const secret = (c: string) => c.repeat(64);

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-devices-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _setDeviceClockForTests } = await import("../lib/devices");
  _setDeviceClockForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_DEVICES;
  (await import("../lib/config"))._resetConfigForTests();
});

/** Binds the device behind secret `c` to `who`; `proxyId` stands for a device an earlier release connected through a browser. */
async function connect(c: string, who: string, label = "Dev", proxyId?: string) {
  const d = await import("../lib/devices");
  const h = d.hashSecret(secret(c))!;
  d.bindDevice(h, who, label, null);
  if (proxyId) {
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE devices SET bound_via_proxy_id = ? WHERE secret_hash = ?").run(proxyId, h);
  }
  return h;
}

describe("hashSecret", () => {
  it("hashes exactly 64 lowercase hex chars to a sha256 hex", async () => {
    const { hashSecret } = await import("../lib/devices");
    const { createHash } = await import("node:crypto");
    const s = secret("a");
    expect(hashSecret(s)).toBe(createHash("sha256").update(s).digest("hex"));
    expect(hashSecret(s)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(s)).not.toBe(s);
  });

  it("treats anything else as absent", async () => {
    const { hashSecret } = await import("../lib/devices");
    expect(hashSecret(secret("A"))).toBeNull(); // uppercase
    expect(hashSecret("a".repeat(63))).toBeNull();
    expect(hashSecret("a".repeat(65))).toBeNull();
    expect(hashSecret("g".repeat(64))).toBeNull();
    expect(hashSecret(` ${secret("a")}`)).toBeNull();
    expect(hashSecret("")).toBeNull();
    expect(hashSecret(null)).toBeNull();
    expect(hashSecret(undefined)).toBeNull();
  });
});

describe("bindDevice", () => {
  it("creates a device for a person, with the label and address, and stores only the hash", async () => {
    const d = await import("../lib/devices");
    const h = d.hashSecret(secret("a"))!;
    const bound = d.bindDevice(h, ALICE, "Windows laptop", "192.0.2.9");
    expect(bound.previousUserId).toBeNull();
    const row = d.lookupDevice(h)!;
    expect(row).toMatchObject({ id: bound.deviceId, userId: ALICE, label: "Windows laptop" });
    expect(d.listDevices(ALICE)[0].connectedIp).toBe("192.0.2.9");
    const { getDb } = await import("../lib/db");
    expect(JSON.stringify(getDb().prepare("SELECT * FROM devices").all())).not.toContain(secret("a"));
  });

  it("rebinding the same secret updates the one row and reports who had it", async () => {
    const d = await import("../lib/devices");
    const h = d.hashSecret(secret("a"))!;
    const first = d.bindDevice(h, ALICE, "One", null);
    const second = d.bindDevice(h, MARIE, "Two", null);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.previousUserId).toBe(ALICE);
    expect(d.listDevices(ALICE)).toHaveLength(0);
    expect(d.listDevices(MARIE).map((x) => x.label)).toEqual(["Two"]);
  });

  it("binds a forgotten device again on the same row, live", async () => {
    const d = await import("../lib/devices");
    const h = d.hashSecret(secret("a"))!;
    const first = d.bindDevice(h, ALICE, "One", null);
    d.revokeDevice(first.deviceId, { id: ALICE });
    expect(d.lookupDevice(h)).toBeNull();
    const again = d.bindDevice(h, ALICE, "Back", null);
    expect(again.deviceId).toBe(first.deviceId);
    expect(d.lookupDevice(h)?.userId).toBe(ALICE);
  });
});

describe("lookupDevice", () => {
  it("returns null for an unknown hash", async () => {
    const { lookupDevice, hashSecret } = await import("../lib/devices");
    expect(lookupDevice(hashSecret(secret("e"))!)).toBeNull();
  });

  it("writes last_seen_at at most every 5 minutes", async () => {
    const { lookupDevice, _setDeviceClockForTests, LAST_SEEN_WRITE_INTERVAL_MS } = await import("../lib/devices");
    let now = 2_000_000;
    _setDeviceClockForTests(() => now);
    const h = await connect("a", ALICE);
    const seen = () => lookupDevice(h)!.lastSeenAt;
    const first = seen();
    expect(first).toBe(now);
    now += 60_000;
    expect(seen()).toBe(first);
    now += LAST_SEEN_WRITE_INTERVAL_MS;
    expect(seen()).toBe(now);
  });

  it("ignores a forgotten device", async () => {
    const { lookupDevice, listDevices, revokeDevice } = await import("../lib/devices");
    const h = await connect("a", ALICE);
    expect(revokeDevice(listDevices(ALICE)[0].id, { id: ALICE })).toBe(true);
    expect(lookupDevice(h)).toBeNull();
  });
});

describe("listDevices / revokeDevice (Forget)", () => {
  it("lists only the user's live devices, newest first, without the hash", async () => {
    const d = await import("../lib/devices");
    let now = 3_000_000;
    d._setDeviceClockForTests(() => now);
    await connect("a", ALICE, "Old");
    now += 1000;
    await connect("b", ALICE, "New");
    await connect("c", MARIE, "Hers");
    const mine = d.listDevices(ALICE);
    expect(mine.map((x) => x.label)).toEqual(["New", "Old"]);
    expect(JSON.stringify(mine)).not.toContain(d.hashSecret(secret("a"))!);
    expect(mine[0]).not.toHaveProperty("isNew");
  });

  it("only the owner or a maintainer can forget, and it is audited", async () => {
    process.env.BAB_MAINTAINERS = "mia.maint@example.com";
    try {
      const d = await import("../lib/devices");
      await connect("a", ALICE);
      const id = d.listDevices(ALICE)[0].id;
      expect(d.revokeDevice(id, { id: MARIE })).toBe(false);
      expect(d.listDevices(ALICE)).toHaveLength(1);
      expect(d.revokeDevice("no-such-id", { id: ALICE })).toBe(false);
      expect(d.revokeDevice(id, { id: "mia.maint@example.com" })).toBe(true);
      expect(d.revokeDevice(id, { id: ALICE })).toBe(false); // already forgotten
      const { getDb } = await import("../lib/db");
      const rows = getDb().prepare("SELECT actor_id, entity_id FROM audit_log WHERE action = 'device-revoke'").all();
      expect(rows).toEqual([{ actor_id: "mia.maint@example.com", entity_id: id }]);
    } finally {
      delete process.env.BAB_MAINTAINERS;
    }
  });

  it("forgetting does not hold anyone to anything: there is no confirm-after-revoke any more", async () => {
    const d = await import("../lib/devices");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: ALICE, email: ALICE, name: "Alice Example", roles: [] });
    await connect("a", ALICE);
    d.revokeDevice(d.listDevices(ALICE)[0].id, { id: ALICE });
    d.revokeDevicesForUser(ALICE);
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT require_confirm_until AS t FROM users WHERE id = ?").get(ALICE)).toEqual({ t: null });
  });

  it("revokeDevicesForUser forgets all of one person's devices and counts them", async () => {
    const d = await import("../lib/devices");
    await connect("a", ALICE);
    await connect("b", ALICE);
    await connect("c", MARIE);
    expect(d.revokeDevicesForUser(ALICE)).toBe(2);
    expect(d.listDevices(ALICE)).toHaveLength(0);
    expect(d.listDevices(MARIE)).toHaveLength(1);
  });
});

describe("unlinking a browser forgets the devices an earlier release connected through it", () => {
  async function seed() {
    const d = await import("../lib/devices");
    await linkForTests("proxy-oid-1", ALICE);
    await connect("a", ALICE, "Via link", "proxy-oid-1");
    await connect("b", ALICE, "Other browser", "proxy-oid-other");
    await connect("c", MARIE, "Hers", "proxy-oid-2");
    await connect("d", ALICE, "Identified, no browser");
    return d;
  }

  it("unlinkOwnBrowser forgets only the devices bound by that proxy id, and leaves connections alone", async () => {
    const d = await seed();
    const c = await import("../lib/mcp-connections");
    const conn = c._insertConnectionForTests();
    c.bindConnection(conn, ALICE);
    const { unlinkOwnBrowser } = await import("../lib/proxy-links");
    unlinkOwnBrowser("proxy-oid-1");
    expect(d.listDevices(ALICE).map((x) => x.label).sort()).toEqual(["Identified, no browser", "Other browser"]);
    expect(d.listDevices(MARIE)).toHaveLength(1);
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT details FROM audit_log WHERE action = 'unlink-browser-self'").get() as { details: string };
    expect(JSON.parse(row.details).devicesRevoked).toBe(1);
    expect(c.lookupConnection(conn)?.userId).toBe(ALICE);
  });

  it("a maintainer unlink forgets the devices of that address too", async () => {
    process.env.BAB_MAINTAINERS = "mia.maint@example.com";
    try {
      const d = await seed();
      const { unlinkBrowser } = await import("../lib/proxy-links");
      const c = await import("../lib/mcp-connections");
      const mine = c._insertConnectionForTests();
      c.bindConnection(mine, ALICE);
      const hers = c._insertConnectionForTests();
      c.bindConnection(hers, MARIE);
      unlinkBrowser("mia.maint@example.com", { email: ALICE });
      expect(d.listDevices(ALICE)).toHaveLength(0);
      expect(d.listDevices(MARIE)).toHaveLength(1);
      // The identified connections of that address end with it; another person's stay.
      expect(c.lookupConnection(mine)).toBeNull();
      expect(c.lookupConnection(hers)?.userId).toBe(MARIE);
    } finally {
      delete process.env.BAB_MAINTAINERS;
    }
  });
});

describe("label", () => {
  it("is X-Bab-Device-Label reduced to letters, digits, space, dot, dash and underscore, max 60, else generic", async () => {
    const { deviceLabelFrom } = await import("../lib/devices");
    expect(deviceLabelFrom(new Headers({ "x-bab-device-label": "MINGW64_NT-10.0 LAPTOP-123" }))).toBe("MINGW64_NT-10.0 LAPTOP-123");
    expect(deviceLabelFrom(new Headers({ "x-bab-device-label": "  Windows 11 (ALICE-PC)  " }))).toBe("Windows 11 ALICE-PC");
    expect(deviceLabelFrom(new Headers({ "x-bab-device-label": "<script>x</script>" }))).toBe("scriptxscript");
    expect(deviceLabelFrom(new Headers({ "x-bab-device-label": "x".repeat(200) }))).toHaveLength(60);
    expect(deviceLabelFrom(new Headers({ "x-bab-device-label": "***" }))).toBe("Unknown device");
    expect(deviceLabelFrom(new Headers({ "x-bab-device-label": "   " }))).toBe("Unknown device");
    expect(deviceLabelFrom(new Headers())).toBe("Unknown device");
  });

  it("never decides identity: it is stored on the device and nothing else reads it", async () => {
    const d = await import("../lib/devices");
    const h = await connect("a", MARIE, "alice.example example.com");
    expect(d.lookupDevice(h)?.userId).toBe(MARIE);
  });
});

describe("kill switch", () => {
  it("devicesEnabled is false only for BAB_DEVICES=0", async () => {
    const { devicesEnabled } = await import("../lib/devices");
    expect(devicesEnabled()).toBe(true);
    process.env.BAB_DEVICES = "0";
    (await import("../lib/config"))._resetConfigForTests();
    expect(devicesEnabled()).toBe(false);
    process.env.BAB_DEVICES = "1";
    (await import("../lib/config"))._resetConfigForTests();
    expect(devicesEnabled()).toBe(true);
  });
});

describe("forgetting devices not seen for 90 days (the maintenance sweep)", () => {
  const DAY = 86_400_000;

  it("forgets a device last seen over 90 days ago and keeps a recent one", async () => {
    const d = await import("../lib/devices");
    let now = 1_700_000_000_000;
    d._setDeviceClockForTests(() => now);
    const old = await connect("a", ALICE, "Old");
    d.lookupDevice(old); // seen at t0
    const active = await connect("b", ALICE, "Active");
    now += 91 * DAY;
    d.lookupDevice(active); // seen just now
    expect(d.revokeStaleDevices()).toBe(1);
    expect(d.listDevices(ALICE).map((x) => x.label)).toEqual(["Active"]);
  });

  it("uses BAB_STALE_AFTER_DAYS: with 1 a device unseen for 2 days is forgotten", async () => {
    process.env.BAB_STALE_AFTER_DAYS = "1";
    (await import("../lib/config"))._resetConfigForTests();
    try {
      const d = await import("../lib/devices");
      let now = 1_700_000_000_000;
      d._setDeviceClockForTests(() => now);
      const h = await connect("a", ALICE, "Old");
      d.lookupDevice(h);
      now += 2 * DAY;
      expect(d.revokeStaleDevices()).toBe(1);
    } finally {
      delete process.env.BAB_STALE_AFTER_DAYS;
      (await import("../lib/config"))._resetConfigForTests();
    }
  });

  it("uses created_at for a device that was never seen", async () => {
    const d = await import("../lib/devices");
    const { getDb } = await import("../lib/db");
    let now = 1_700_000_000_000;
    d._setDeviceClockForTests(() => now);
    await connect("a", ALICE, "Never seen");
    getDb().prepare("UPDATE devices SET last_seen_at = NULL").run();
    now += 89 * DAY;
    expect(d.revokeStaleDevices()).toBe(0);
    now += 2 * DAY;
    expect(d.revokeStaleDevices()).toBe(1);
  });

  it("is run by the maintenance sweep and reported", async () => {
    const d = await import("../lib/devices");
    const { getDb } = await import("../lib/db");
    await connect("a", ALICE, "Old");
    getDb().prepare("UPDATE devices SET created_at = ?, last_seen_at = NULL").run(Date.now() - 100 * DAY);
    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();
    expect(runMaintenance(true)?.devicesExpired).toBe(1);
    expect(d.listDevices(ALICE)).toHaveLength(0);
  });

  it("leaves one aggregated audit row per run, none when it forgot nothing", async () => {
    const d = await import("../lib/devices");
    let now = 1_700_000_000_000;
    d._setDeviceClockForTests(() => now);
    await connect("a", ALICE, "A");
    await connect("b", MARIE, "B");
    const { getDb } = await import("../lib/db");
    const rows = () =>
      getDb().prepare("SELECT actor_id, details FROM audit_log WHERE action = 'device-expire'").all() as { actor_id: string; details: string }[];
    expect(d.revokeStaleDevices()).toBe(0);
    expect(rows()).toHaveLength(0);
    now += 91 * DAY;
    expect(d.revokeStaleDevices()).toBe(2);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].actor_id).toBe("system");
    expect(JSON.parse(rows()[0].details)).toEqual({ count: 2, maxAgeDays: 90 });
  });
});
