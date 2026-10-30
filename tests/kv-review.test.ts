// Regression tests for the security review of the key-value store (namespace squatting, throttle
// pace, audit failures, snapshot trust, the single-process lease). Several started as exploit tests.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;
const A = { id: "attacker.one@example.com" };
const B = { id: "victim.two@example.com" };
const BOSS = { id: "keeper.three@example.com" };
const T0 = Date.parse("2026-10-29T10:00:00.000Z");
type Kv = typeof import("../lib/kv");
let kv: Kv;

async function reconfigure(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  (await import("../lib/config"))._resetConfigForTests();
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-kv-review-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_MAINTAINERS = BOSS.id;
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: T0 });
  vi.resetModules();
  kv = await import("../lib/kv");
  kv._resetKvForTests();
});

afterEach(async () => {
  kv._resetKvForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  for (const k of Object.keys(process.env)) if (k.startsWith("BAB_KV") || k === "BAB_REPLICAS") delete process.env[k];
  (await import("../lib/config"))._resetConfigForTests();
  vi.resetModules();
});

function status(fn: () => unknown): number {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

describe("M1: one person cannot fill a shared namespace", () => {
  it("caps each person's keys inside a shared namespace, so others still get in", () => {
    for (let i = 0; i < 50; i += 1) kv.kvLock(A, { key: `shared/bitbucket-push/l${i}`, ttlSeconds: 3600 }, "mcp");
    expect(() => kv.kvLock(A, { key: "shared/bitbucket-push/l50", ttlSeconds: 3600 }, "mcp")).toThrow(/You already hold 50 keys in shared\/bitbucket-push\/, the limit per person is 50/);
    expect(kv.kvSet(B, { key: "shared/bitbucket-push/x", value: 1, ttlSeconds: 60 }, "mcp").set).toBe(true);
    expect(kv.kvLock(B, { key: "shared/bitbucket-push/repo", ttlSeconds: 60 }, "mcp").acquired).toBe(true);
    // A's own space is a separate allowance.
    expect(kv.kvSet(A, { key: "mine", value: 1, ttlSeconds: 60 }, "mcp").set).toBe(true);
  });

  it("counts a shared value against whoever wrote it last", async () => {
    await reconfigure({ BAB_KV_SHARED_MAX_KEYS_PER_USER: "2" });
    kv.kvSet(A, { key: "shared/bitbucket-push/a", value: 1, ttlSeconds: 60 }, "mcp");
    kv.kvSet(A, { key: "shared/bitbucket-push/b", value: 1, ttlSeconds: 60 }, "mcp");
    expect(status(() => kv.kvSet(A, { key: "shared/bitbucket-push/c", value: 1, ttlSeconds: 60 }, "mcp"))).toBe(507);
    // B takes over a: it now counts against B, and A has room again.
    kv.kvSet(B, { key: "shared/bitbucket-push/a", value: 2, ttlSeconds: 60 }, "mcp");
    expect(kv.kvSet(A, { key: "shared/bitbucket-push/c", value: 1, ttlSeconds: 60 }, "mcp").set).toBe(true);
    // Overwriting your own key never counts twice.
    expect(kv.kvSet(A, { key: "shared/bitbucket-push/c", value: 3, ttlSeconds: 60 }, "mcp").set).toBe(true);
  });

  it("caps each person's bytes inside a shared namespace", async () => {
    await reconfigure({ BAB_KV_SHARED_MAX_BYTES_PER_USER: "70000" });
    kv.kvSet(A, { key: "shared/bitbucket-push/a", value: "x".repeat(60000), ttlSeconds: 60 }, "mcp");
    expect(() => kv.kvSet(A, { key: "shared/bitbucket-push/b", value: "x".repeat(20000), ttlSeconds: 60 }, "mcp")).toThrow(/limit per person is 70000/);
  });

  it("gives shared keys a shorter TTL cap", () => {
    expect(() => kv.kvLock(A, { key: "shared/bitbucket-push/l", ttlSeconds: 86400 }, "mcp")).toThrow(/1 to 3600 in a shared namespace/);
    expect(() => kv.kvSet(A, { key: "shared/bitbucket-push/v", value: 1, ttlSeconds: 3601 }, "mcp")).toThrow(/3600/);
    expect(kv.kvLock(A, { key: "own-lock", ttlSeconds: 86400 }, "mcp").acquired).toBe(true);
    const lock = kv.kvLock(A, { key: "shared/bitbucket-push/l", ttlSeconds: 3600 }, "mcp");
    if (lock.acquired) expect(() => kv.kvRenew(A, { key: "shared/bitbucket-push/l", token: lock.token, ttlSeconds: 7200 }, "mcp")).toThrow(/3600/);
  });

  it("lets a maintainer force-delete a shared lock, and nobody else", async () => {
    kv.kvLock(A, { key: "shared/bitbucket-push/stuck", ttlSeconds: 3600 }, "mcp");
    expect(status(() => kv.kvForceDelete(B, { key: "shared/bitbucket-push/stuck" }, "mcp"))).toBe(403);
    expect(kv.kvForceDelete(BOSS, { key: "shared/bitbucket-push/stuck" }, "mcp")).toEqual({ key: "shared/bitbucket-push/stuck", deleted: true, kind: "lock", writer: A.id });
    expect(kv.kvLock(B, { key: "shared/bitbucket-push/stuck", ttlSeconds: 60 }, "mcp").acquired).toBe(true);
    expect(kv.kvForceDelete(BOSS, { key: "shared/bitbucket-push/none" }, "mcp").deleted).toBe(false);
    // Still no reach into someone else's own space.
    expect(status(() => kv.kvForceDelete(BOSS, { key: `u/${A.id}/x` }, "mcp"))).toBe(403);
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT actor_id, details FROM audit_log WHERE action = 'kv_force_delete' ORDER BY id LIMIT 1").get() as { actor_id: string; details: string };
    expect(row.actor_id).toBe(BOSS.id);
    expect(JSON.parse(row.details)).toMatchObject({ result: "deleted", kind: "lock", writer: A.id });
  });

  it("lets a maintainer purge one person's keys and frees their share", () => {
    for (let i = 0; i < 50; i += 1) kv.kvLock(A, { key: `shared/bitbucket-push/l${i}`, ttlSeconds: 3600 }, "mcp");
    kv.kvSet(A, { key: "private", value: 1, ttlSeconds: 60 }, "mcp");
    kv.kvLock(B, { key: "shared/bitbucket-push/b", ttlSeconds: 60 }, "mcp");
    expect(status(() => kv.kvPurge(B, { user: A.id }, "mcp"))).toBe(403);
    expect(status(() => kv.kvPurge(BOSS, { user: "" }, "mcp"))).toBe(400);
    expect(kv.kvPurge(BOSS, { user: A.id.toUpperCase() }, "mcp")).toEqual({ user: A.id, deleted: 51 });
    expect(kv.kvList(B, "shared/bitbucket-push/").keys.map((k) => k.key)).toEqual(["shared/bitbucket-push/b"]);
    expect(kv.kvGet(A, "private").found).toBe(false);
    expect(kv.kvLock(A, { key: "shared/bitbucket-push/again", ttlSeconds: 60 }, "mcp").acquired).toBe(true);
  });

  it("runs the maintainer actions through runKv", () => {
    const boss = { ...BOSS, source: "device" as const };
    kv.kvLock(A, { key: "shared/bitbucket-push/stuck", ttlSeconds: 60 }, "mcp");
    expect(kv.runKv(boss, { action: "force_delete", key: "shared/bitbucket-push/stuck" }, "mcp")).toMatchObject({ deleted: true });
    expect(kv.runKv(boss, { action: "purge", user: A.id }, "mcp")).toMatchObject({ deleted: 0 });
  });
});

describe("M2: the pace is fixed by whoever creates the throttle", () => {
  it("refuses another interval with 409 instead of stalling or skipping the pace", () => {
    kv.kvThrottle(B, { key: "shared/bitbucket-push/pull-requests", minIntervalSeconds: 30 }, "mcp");
    let message = "";
    try {
      kv.kvThrottle(A, { key: "shared/bitbucket-push/pull-requests", minIntervalSeconds: 3600 }, "mcp");
    } catch (e) {
      expect((e as { status: number }).status).toBe(409);
      message = (e as Error).message;
    }
    expect(message).toMatch(/paces at 30 seconds/);
    expect(status(() => kv.kvThrottle(A, { key: "shared/bitbucket-push/pull-requests", minIntervalSeconds: 0.1 }, "mcp"))).toBe(409);
    expect(kv.kvThrottle(A, { key: "shared/bitbucket-push/pull-requests", minIntervalSeconds: 30 }, "mcp").waitSeconds).toBe(30);
    expect(kv.kvGet(A, "shared/bitbucket-push/pull-requests")).toMatchObject({ kind: "throttle", minIntervalSeconds: 30 });
  });

  it("caps one person's future slots, so nobody books the pace an hour ahead alone", () => {
    // The first slot is now, so it is not a future one; the next four are.
    const waits = Array.from({ length: 5 }, () => kv.kvThrottle(A, { key: "shared/bitbucket-push/p", minIntervalSeconds: 30 }, "mcp").waitSeconds);
    expect(waits).toEqual([0, 30, 60, 90, 120]);
    expect(() => kv.kvThrottle(A, { key: "shared/bitbucket-push/p", minIntervalSeconds: 30 }, "mcp")).toThrow(/already hold 4 future slots/);
    expect(kv.kvThrottle(B, { key: "shared/bitbucket-push/p", minIntervalSeconds: 30 }, "mcp").waitSeconds).toBe(150);
    // Once some of A's slots pass, A may book again, after B.
    vi.advanceTimersByTime(91_000);
    expect(kv.kvThrottle(A, { key: "shared/bitbucket-push/p", minIntervalSeconds: 30 }, "mcp").waitSeconds).toBe(89);
  });

  it("starts a new pace once the old throttle expires", () => {
    kv.kvThrottle(A, { key: "shared/bitbucket-push/p", minIntervalSeconds: 600 }, "mcp");
    vi.advanceTimersByTime(600_000);
    expect(kv.kvThrottle(B, { key: "shared/bitbucket-push/p", minIntervalSeconds: 30 }, "mcp").waitSeconds).toBe(0);
  });
});

describe("N1: a failed audit row undoes the write", () => {
  it("leaves no lock behind when the audit row cannot be written", async () => {
    kv.kvSet(A, { key: "v", value: "old", ttlSeconds: 60 }, "mcp");
    const { getDb } = await import("../lib/db");
    const { _resetAuditStatementCache } = await import("../lib/audit");
    getDb().exec("DROP TABLE audit_log");
    _resetAuditStatementCache();
    expect(() => kv.kvLock(A, { key: "shared/bitbucket-push/l", ttlSeconds: 60 }, "mcp")).toThrow();
    expect(kv.kvGet(B, "shared/bitbucket-push/l").found).toBe(false);
    expect(() => kv.kvSet(A, { key: "v", value: "new", ttlSeconds: 60 }, "mcp")).toThrow();
    expect(kv.kvGet(A, "v").value).toBe("old");
    expect(() => kv.kvDelete(A, { key: "v" }, "mcp")).toThrow();
    expect(kv.kvGet(A, "v").value).toBe("old");
    expect(() => kv.kvPurge(BOSS, { user: A.id }, "mcp")).toThrow();
    expect(kv.kvGet(A, "v").value).toBe("old");
    expect(kv.kvUsage(A.id).keys).toBe(1);
  });
});

describe("N2: incr checks numbers like any value", () => {
  it("refuses a step or a result that looks like a card number", () => {
    expect(() => kv.kvIncr(A, { key: "c", by: 4111111111111111, ttlSeconds: 60 }, "mcp")).toThrow(/confidential/);
    kv.kvIncr(A, { key: "d", ttlSeconds: 60 }, "mcp");
    expect(() => kv.kvIncr(A, { key: "d", by: 4111111111111110 }, "mcp")).toThrow(/confidential/);
    expect(kv.kvGet(A, "d").value).toBe(1);
  });
});

describe("N3: throttles honour the TTL cap", () => {
  it("never keeps a throttle or books a slot past BAB_KV_MAX_TTL_SECONDS", async () => {
    await reconfigure({ BAB_KV_MAX_TTL_SECONDS: "60" });
    kv.kvThrottle(A, { key: "t", minIntervalSeconds: 40 }, "mcp");
    kv.kvThrottle(A, { key: "t", minIntervalSeconds: 40 }, "mcp");
    expect(kv.kvGet(A, "t").ttlSeconds).toBeLessThanOrEqual(60);
    expect(() => kv.kvThrottle(A, { key: "t", minIntervalSeconds: 40 }, "mcp")).toThrow(/more than 60 seconds ahead/);
  });

  it("refuses an interval longer than the namespace's TTL cap with 400 (X3)", async () => {
    await reconfigure({ BAB_KV_MAX_TTL_SECONDS: "60" });
    expect(status(() => kv.kvThrottle(A, { key: "t", minIntervalSeconds: 61 }, "mcp"))).toBe(400);
    expect(() => kv.kvThrottle(A, { key: "t", minIntervalSeconds: 3600 }, "mcp")).toThrow(/at most 60/);
    await reconfigure({ BAB_KV_MAX_TTL_SECONDS: undefined, BAB_KV_SHARED_MAX_TTL_SECONDS: "600" });
    expect(() => kv.kvThrottle(A, { key: "shared/bitbucket-push/p", minIntervalSeconds: 601 }, "mcp")).toThrow(/at most 600 in a shared namespace/);
    expect(kv.kvGet(A, "t").found).toBe(false);
    expect(kv.kvGet(A, "shared/bitbucket-push/p").found).toBe(false);
  });

  it("ends a throttle one TTL cap after its creation, however often its creator calls it", () => {
    // The creator pins a slow pace and books once per interval, which used to push the expiry on for ever.
    const key = "shared/bitbucket-push/squat";
    for (const t of [0, 1199, 2399, 3599]) {
      vi.setSystemTime(T0 + t * 1000);
      kv.kvThrottle(A, { key, minIntervalSeconds: 1200 }, "mcp");
      expect(kv.kvGet(B, key).ttlSeconds).toBeLessThanOrEqual(3600 - t);
    }
    vi.setSystemTime(T0 + 3600_000);
    expect(kv.kvGet(B, key).found).toBe(false);
    expect(kv.kvThrottle(B, { key, minIntervalSeconds: 30 }, "mcp")).toMatchObject({ waitSeconds: 0, minIntervalSeconds: 30 });
  });
});

describe("N4: the snapshot is checked again on load", () => {
  const later = () => T0 + 60_000;
  function load(entries: unknown[]) {
    writeFileSync(path.join(dataDir, "kv-snapshot.json"), JSON.stringify({ version: 1, entries }).replace('"__INF__"', "1e400"));
  }

  it("drops infinite expiry, foreign buckets, bad keys, bad tokens and duplicates", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = "a".repeat(32);
    load([
      [`u/${B.id}/inf`, { kind: "value", value: "1", expiresAt: "__INF__", bucket: A.id }],
      [`u/${B.id}/far`, { kind: "value", value: "1", expiresAt: T0 + 2 * 86_400_000, writer: B.id }],
      ["../../evil", { kind: "value", value: "2", expiresAt: later() }],
      [`u/${B.id}/UPPER`, { kind: "value", value: "1", expiresAt: later(), writer: B.id }],
      ["shared/unknown/x", { kind: "value", value: "1", expiresAt: later(), writer: B.id }],
      [`u/${B.id}/spoofed`, { kind: "value", value: "1", expiresAt: later(), writer: A.id }],
      [`u/${B.id}/badjson`, { kind: "value", value: "{", expiresAt: later(), writer: B.id }],
      [`u/${B.id}/locked`, { kind: "lock", holder: A.id, token, expiresAt: later() }],
      ["shared/bitbucket-push/badtoken", { kind: "lock", holder: A.id, token: "short", expiresAt: later() }],
      ["shared/bitbucket-push/longlock", { kind: "lock", holder: A.id, token, expiresAt: T0 + 7200_000 }],
      ["shared/bitbucket-push/badpace", { kind: "throttle", slotAt: T0, intervalMs: 10, expiresAt: later(), writer: A.id }],
      [`u/${B.id}/ok`, { kind: "value", value: "1", expiresAt: later(), writer: B.id }],
      [`u/${B.id}/ok`, { kind: "value", value: "2", expiresAt: later(), writer: B.id }],
      ["shared/bitbucket-push/lock", { kind: "lock", holder: A.id, token, expiresAt: later() }],
      ["shared/bitbucket-push/pace", { kind: "throttle", slotAt: T0, intervalMs: 30_000, booked: { [A.id]: [T0 + 10_000, "x"], "a/b": [T0 + 10_000] }, expiresAt: later(), writer: A.id }],
    ]);
    expect(kv.kvList(B, "").keys.map((k) => k.key)).toEqual([`u/${B.id}/ok`]);
    expect(kv.kvGet(B, "ok").value).toBe(1);
    expect(kv.kvList(B, "shared/bitbucket-push/").keys.map((k) => k.key)).toEqual(["shared/bitbucket-push/lock", "shared/bitbucket-push/pace"]);
    expect(kv.kvUnlock(A, { key: "shared/bitbucket-push/lock", token }, "mcp").released).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped 12 key-value snapshot entries/));
  });

  it("re-checks values for secrets and bounds throttle slots and creation on load (X7)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    load([
      [`u/${B.id}/card`, { kind: "value", value: "4111111111111111", expiresAt: later(), writer: B.id }],
      [`u/${B.id}/nested`, { kind: "value", value: JSON.stringify({ note: { password: "Hunter2Hunter2!" } }), expiresAt: later(), writer: B.id }],
      ["shared/bitbucket-push/farslot", { kind: "throttle", slotAt: T0 + 3601_000, intervalMs: 30_000, createdAt: T0, expiresAt: later(), writer: A.id }],
      ["shared/bitbucket-push/old", { kind: "throttle", slotAt: T0, intervalMs: 30_000, createdAt: T0 - 3600_000, expiresAt: later(), writer: A.id }],
      ["shared/bitbucket-push/future", { kind: "throttle", slotAt: T0, intervalMs: 30_000, createdAt: T0 + 1000, expiresAt: later(), writer: A.id }],
      ["shared/bitbucket-push/ok", { kind: "throttle", slotAt: T0 + 30_000, intervalMs: 30_000, createdAt: T0 - 1000, booked: { [A.id]: [T0 + 30_000, T0 + 7200_000] }, expiresAt: later(), writer: A.id }],
      [`u/${B.id}/fine`, { kind: "value", value: JSON.stringify({ step: 3 }), expiresAt: later(), writer: B.id }],
    ]);
    expect(kv.kvList(B, "").keys.map((k) => k.key)).toEqual([`u/${B.id}/fine`]);
    expect(kv.kvList(A, "shared/bitbucket-push/").keys.map((k) => k.key)).toEqual(["shared/bitbucket-push/ok"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped 5 key-value snapshot entries/));
  });

  it("applies the limits to what it loads", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await reconfigure({ BAB_KV_MAX_KEYS_PER_USER: "2", BAB_KV_SHARED_MAX_KEYS_PER_USER: "2" });
    load(["a", "b", "c", "d"].map((n) => [`u/${B.id}/${n}`, { kind: "value", value: "1", expiresAt: later(), writer: B.id }]));
    expect(kv.kvUsage(B.id).keys).toBe(2);
  });
});

describe("N5: one process serves the store", () => {
  const leaseFile = () => path.join(dataDir, "kv.lease");

  it("takes a lease on first use and gives it up on shutdown", () => {
    kv.kvGet(A, "x");
    const lease = JSON.parse(readFileSync(leaseFile(), "utf8"));
    expect(lease).toMatchObject({ host: hostname(), pid: process.pid });
    kv.kvSet(A, { key: "x", value: 1, ttlSeconds: 60 }, "mcp");
    kv.flushKvSnapshot();
    expect(existsSync(leaseFile())).toBe(false);
    expect(existsSync(path.join(dataDir, "kv-snapshot.json"))).toBe(true);
  });

  it("refuses the store with 503 while another live process holds the lease", () => {
    writeFileSync(leaseFile(), JSON.stringify({ instance: "other", host: "another-pod", pid: 1, at: T0 - 5_000 }));
    expect(status(() => kv.kvGet(A, "x"))).toBe(503);
    expect(() => kv.kvGet(A, "x")).toThrow(/another BAB process serves it/);
    // Its lease goes stale after 30 seconds without a heartbeat: a crashed process is taken over.
    vi.advanceTimersByTime(30_000);
    expect(kv.kvGet(A, "x").found).toBe(false);
  });

  it("takes over a lease from this host whose process is gone, or from this very process", () => {
    writeFileSync(leaseFile(), JSON.stringify({ instance: "old", host: hostname(), pid: process.pid, at: T0 }));
    expect(kv.kvGet(A, "x").found).toBe(false);
    kv._resetKvForTests();
    writeFileSync(leaseFile(), JSON.stringify({ instance: "old", host: hostname(), pid: 2_147_483_000, at: T0 }));
    expect(kv.kvGet(A, "x").found).toBe(false);
  });

  it("stops serving when another process takes the lease, and does not save the snapshot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    kv.kvSet(A, { key: "x", value: 1, ttlSeconds: 60 }, "mcp");
    writeFileSync(leaseFile(), JSON.stringify({ instance: "intruder", host: "another-pod", pid: 1, at: T0 }));
    const { _kvLeaseHeartbeatForTests } = await import("../lib/kv-lease");
    _kvLeaseHeartbeatForTests();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("took the key-value lease"));
    expect(status(() => kv.kvGet(A, "x"))).toBe(503);
    expect(kv.saveKvSnapshot(true)).toBe(false);
  });

  it("refreshes its lease on the heartbeat", () => {
    kv.kvGet(A, "x");
    vi.advanceTimersByTime(10_000);
    expect(JSON.parse(readFileSync(leaseFile(), "utf8")).at).toBe(T0 + 10_000);
  });
});

describe("N6: snapshot writes", () => {
  it("removes a stale temp file before writing", () => {
    writeFileSync(path.join(dataDir, "kv-snapshot.json.tmp"), "half a file from a crash");
    kv.kvSet(A, { key: "x", value: 1, ttlSeconds: 60 }, "mcp");
    expect(kv.saveKvSnapshot()).toBe(true);
    expect(existsSync(path.join(dataDir, "kv-snapshot.json.tmp"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dataDir, "kv-snapshot.json"), "utf8")).entries).toHaveLength(1);
  });
});

describe("values from the review", () => {
  it("refuses a deeply nested value with 400, not a crash", () => {
    let v: unknown = 1;
    for (let i = 0; i < 20000; i += 1) v = [v];
    expect(status(() => kv.kvSet(A, { key: "deep", value: v, ttlSeconds: 60 }, "mcp"))).toBe(400);
    expect(() => kv.kvSet(A, { key: "deep", value: v, ttlSeconds: 60 }, "mcp")).toThrow(/nested more than 64 levels/);
  });

  it("stores __proto__ as plain data without polluting objects", () => {
    const v = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"p":2}}}');
    kv.kvSet(A, { key: "proto", value: v, ttlSeconds: 60 }, "mcp");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses private keys, tokens and passwords, at the top or nested", () => {
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA1234567890abcdefghijABCDEFGHIJ1234567890abcdefghij", "-----END RSA PRIVATE KEY-----"].join("\n");
    const ghp = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const pw = ["pass", "word=Hunter2Hunter2!"].join("");
    for (const value of [pem, { k: pem }, ghp, { t: ghp }, pw, { password: "Hunter2Hunter2!" }]) {
      expect(() => kv.kvSet(A, { key: "s", value, ttlSeconds: 60 }, "mcp"), JSON.stringify(value).slice(0, 40)).toThrow(/confidential/);
    }
  });
});
