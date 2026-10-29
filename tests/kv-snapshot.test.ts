import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;
const ME = { id: "owner.one@example.com" };
const T0 = Date.parse("2026-10-29T10:00:00.000Z");
type Kv = typeof import("../lib/kv");
let kv: Kv;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-kv-snap-test-"));
  process.env.DATA_DIR = dataDir;
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
  vi.resetModules();
});

const file = () => path.join(dataDir, "kv-snapshot.json");

/** A restart: the in-memory store is gone, the next call loads the snapshot. */
function restart() {
  kv._resetKvForTests();
}

describe("kv snapshot", () => {
  it("writes nothing before the store is used, and nothing when unchanged", () => {
    kv.flushKvSnapshot();
    expect(existsSync(file())).toBe(false);
    kv.kvGet(ME, "a");
    expect(kv.saveKvSnapshot()).toBe(false);
    expect(existsSync(file())).toBe(false);
    expect(kv.saveKvSnapshot(true)).toBe(true);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ version: 1, entries: [] });
  });

  it("keeps values, counters, locks and throttles across a restart and drops what expired meanwhile", () => {
    kv.kvSet(ME, { key: "long", value: { a: 1 }, ttlSeconds: 600 }, "mcp");
    kv.kvSet(ME, { key: "short", value: "x", ttlSeconds: 5 }, "mcp");
    kv.kvIncr(ME, { key: "count", by: 7, ttlSeconds: 600 }, "mcp");
    const lock = kv.kvLock(ME, { key: "shared/bitbucket-push/lock", ttlSeconds: 600 }, "mcp");
    kv.kvThrottle(ME, { key: "shared/bitbucket-push/pace", minIntervalSeconds: 60 }, "mcp");
    kv.kvThrottle(ME, { key: "shared/bitbucket-push/pace", minIntervalSeconds: 60 }, "mcp");
    kv.flushKvSnapshot();
    expect(kv.saveKvSnapshot()).toBe(false);
    restart();
    vi.advanceTimersByTime(10_000);

    expect(kv.kvGet(ME, "long")).toMatchObject({ value: { a: 1 }, ttlSeconds: 590 });
    expect(kv.kvGet(ME, "short").found).toBe(false);
    expect(kv.kvGet(ME, "count").value).toBe(7);
    expect(kv.kvLock(ME, { key: "shared/bitbucket-push/lock", ttlSeconds: 10 }, "mcp").acquired).toBe(false);
    if (lock.acquired) expect(kv.kvUnlock(ME, { key: "shared/bitbucket-push/lock", token: lock.token }, "mcp").released).toBe(true);
    // The pace carries on from the last booked slot (T0 + 60 s), not from scratch.
    expect(kv.kvThrottle(ME, { key: "shared/bitbucket-push/pace", minIntervalSeconds: 60 }, "mcp").waitSeconds).toBe(110);
    expect(kv.kvUsage(ME.id).keys).toBe(2);
  });

  it("saves on its timer only when something changed", () => {
    kv.kvSet(ME, { key: "a", value: 1, ttlSeconds: 600 }, "mcp");
    expect(existsSync(file())).toBe(false);
    vi.advanceTimersByTime(kv.KV_SNAPSHOT_INTERVAL_MS);
    expect(existsSync(file())).toBe(true);
    rmSync(file());
    vi.advanceTimersByTime(kv.KV_SNAPSHOT_INTERVAL_MS);
    expect(existsSync(file())).toBe(false);
    kv.kvSet(ME, { key: "b", value: 2, ttlSeconds: 600 }, "mcp");
    vi.advanceTimersByTime(kv.KV_SNAPSHOT_INTERVAL_MS);
    expect(JSON.parse(readFileSync(file(), "utf8")).entries.map((e: [string]) => e[0])).toEqual([`u/${ME.id}/a`, `u/${ME.id}/b`]);
  });

  it("never writes a value to the snapshot that has expired", () => {
    kv.kvSet(ME, { key: "a", value: "soon-gone", ttlSeconds: 1 }, "mcp");
    vi.advanceTimersByTime(1500);
    kv.saveKvSnapshot(true);
    expect(readFileSync(file(), "utf8")).not.toContain("soon-gone");
  });

  it("starts empty from a broken or odd snapshot, and skips malformed entries", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(file(), "{ not json");
    expect(kv.kvGet(ME, "a").found).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not valid JSON"));
    restart();
    writeFileSync(file(), JSON.stringify({ version: 1 }));
    expect(kv.kvGet(ME, "a").found).toBe(false);
    restart();
    const later = T0 + 60_000;
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        entries: [
          [`u/${ME.id}/ok`, { kind: "value", value: "1", expiresAt: later, bucket: ME.id }],
          [`u/${ME.id}/badkind`, { kind: "other", value: "1", expiresAt: later, bucket: ME.id }],
          [`u/${ME.id}/nolock`, { kind: "lock", expiresAt: later, bucket: ME.id }],
          [`u/${ME.id}/nothrottle`, { kind: "throttle", expiresAt: later, bucket: ME.id }],
          [`u/${ME.id}/noexp`, { kind: "value", value: "1", bucket: ME.id }],
          [42, { kind: "value", value: "1", expiresAt: later, bucket: ME.id }],
          "not an entry",
        ],
      }),
    );
    expect(kv.kvList(ME, "").keys.map((k) => k.key)).toEqual([`u/${ME.id}/ok`]);
  });

  it("logs and carries on when the snapshot cannot be written", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    kv.kvSet(ME, { key: "a", value: 1, ttlSeconds: 600 }, "mcp");
    // A folder where the file should go makes the rename fail.
    rmSync(file(), { force: true });
    mkdirSync(file());
    expect(kv.saveKvSnapshot()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not write the key-value snapshot"));
    expect(existsSync(file() + ".tmp")).toBe(false);
  });
});
