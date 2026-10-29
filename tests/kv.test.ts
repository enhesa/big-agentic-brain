import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;
const ME = { id: "owner.one@example.com" };
const THEM = { id: "other.two@example.com" };
const T0 = Date.parse("2026-10-29T10:00:00.000Z");

type Kv = typeof import("../lib/kv");
let kv: Kv;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-kv-test-"));
  process.env.DATA_DIR = dataDir;
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: T0 });
  vi.resetModules();
  kv = await import("../lib/kv");
  kv._resetKvForTests();
});

afterEach(async () => {
  kv._resetKvForTests();
  vi.useRealTimers();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  for (const k of Object.keys(process.env)) if (k.startsWith("BAB_KV") || k === "BAB_REPLICAS") delete process.env[k];
  (await import("../lib/config"))._resetConfigForTests();
  vi.resetModules();
});

async function auditRows(action?: string) {
  const { getDb } = await import("../lib/db");
  const sql = action ? "SELECT * FROM audit_log WHERE action = ? ORDER BY id" : "SELECT * FROM audit_log WHERE action LIKE 'kv_%' ORDER BY id";
  return (action ? getDb().prepare(sql).all(action) : getDb().prepare(sql).all()) as unknown as { actor_id: string; action: string; entity: string; entity_id: string; details: string }[];
}

describe("keys and namespaces", () => {
  it("puts a key with no namespace in the caller's own u/ space", () => {
    expect(kv.resolveKey(ME.id, "build/lock")).toMatchObject({ key: "u/owner.one@example.com/build/lock", own: true, bucket: ME.id });
    expect(kv.resolveKey(ME.id, "u/owner.one@example.com/build/lock").key).toBe("u/owner.one@example.com/build/lock");
  });

  it("allows the default shared namespace and refuses any other", () => {
    expect(kv.resolveKey(ME.id, "shared/bitbucket-push/slot")).toMatchObject({ key: "shared/bitbucket-push/slot", own: false, bucket: "shared/bitbucket-push" });
    expect(() => kv.resolveKey(ME.id, "shared/unknown/x")).toThrow(/not a shared namespace/);
    expect(() => kv.resolveKey(ME.id, "shared/bitbucket-push")).toThrow(/needs a name/);
    expect(() => kv.resolveKey(ME.id, "shared//x")).toThrow(/Name a shared namespace/);
    expect(() => kv.resolveKey(ME.id, "shared")).toThrow(/Name a shared namespace/);
  });

  it("refuses another person's u/ space with 403", () => {
    for (const k of ["u/other.two@example.com/x", "u/owner.one@example.com.evil/x", "u/owner.one@example.co/x", "u/x", "u"]) {
      try {
        kv.resolveKey(ME.id, k);
        throw new Error("no throw for " + k);
      } catch (e) {
        expect((e as { status?: number }).status, k).toBe(403);
      }
    }
  });

  it("refuses escape, case and encoding tricks instead of mapping them", () => {
    const bad = [
      "../x", "a/../b", "./a", "a/./b", "a//b", "/a", "a/", "..", ".",
      "U/other.two@example.com/x", "Shared/bitbucket-push/x", "shared/Bitbucket-Push/x", "Build",
      "a%2e%2e/b", "%2e%2e", "a\\b", "a b", "a\u0000b", "café", "a‮b", "u%2fother", "x@y",
      "shared/bitbucket-push/../../u/other.two@example.com/x",
      "u/owner.one@example.com/../../u/other.two@example.com/x",
    ];
    for (const k of bad) expect(() => kv.resolveKey(ME.id, k), JSON.stringify(k)).toThrow();
    expect(() => kv.resolveKey(ME.id, "")).toThrow(/key is required/);
    expect(() => kv.resolveKey(ME.id, 42)).toThrow(/must be a string/);
  });

  it("refuses an identity with a slash, so one person's space is never a prefix of another's", () => {
    const sneaky = "owner.one@example.com/secret";
    for (const call of [() => kv.resolveKey(sneaky, "k"), () => kv.resolvePrefix(sneaky, ""), () => kv.kvGet({ id: sneaky }, "k"), () => kv.kvList({ id: sneaky }, "")]) {
      try {
        call();
        throw new Error("no throw");
      } catch (e) {
        expect((e as { status?: number }).status).toBe(403);
        expect((e as Error).message).toMatch(/contains a slash/);
      }
    }
    kv.kvSet(ME, { key: "secret/k", value: "mine", ttlSeconds: 30 }, "mcp");
    expect(() => kv.kvGet({ id: sneaky }, "k")).toThrow(/contains a slash/);
  });

  it("refuses keys that redaction would change, and keeps ordinary ones", () => {
    for (const k of ["pr/1234", "repo-a/build-98765", "sha/3f9c2ab", "shared/bitbucket-push/repo.app/pull-requests", "deploy/2026-10-29"]) {
      expect(() => kv.resolveKey(ME.id, k), k).not.toThrow();
    }
    expect(() => kv.resolveKey(ME.id, "card/4111111111111111")).toThrow(/looks like it holds a secret or personal data/);
    expect(() => kv.resolvePrefix(ME.id, "card/4111111111111111")).toThrow(/looks like it holds a secret or personal data/);
  });

  it("caps a key at 200 characters after the namespace", () => {
    expect(kv.resolveKey(ME.id, "a".repeat(200)).key).toHaveLength(`u/${ME.id}/`.length + 200);
    expect(() => kv.resolveKey(ME.id, "a".repeat(201))).toThrow(/200 characters/);
  });

  it("reads shared namespaces from the setting, and none turns them off", async () => {
    process.env.BAB_KV_SHARED_NAMESPACES = "shared/build-push/, deploys";
    (await import("../lib/config"))._resetConfigForTests();
    expect(kv.resolveKey(ME.id, "shared/build-push/x").bucket).toBe("shared/build-push");
    expect(kv.resolveKey(ME.id, "shared/deploys/x").bucket).toBe("shared/deploys");
    expect(() => kv.resolveKey(ME.id, "shared/bitbucket-push/x")).toThrow(/Shared namespaces: shared\/build-push\/, shared\/deploys\//);
    process.env.BAB_KV_SHARED_NAMESPACES = "none";
    (await import("../lib/config"))._resetConfigForTests();
    expect(() => kv.resolveKey(ME.id, "shared/build-push/x")).toThrow(/no shared namespaces/);
  });

  it("resolves list prefixes the same way", () => {
    expect(kv.resolvePrefix(ME.id, "").prefix).toBe(`u/${ME.id}/`);
    expect(kv.resolvePrefix(ME.id, undefined).prefix).toBe(`u/${ME.id}/`);
    expect(kv.resolvePrefix(ME.id, "u/").prefix).toBe(`u/${ME.id}/`);
    expect(kv.resolvePrefix(ME.id, "build/").prefix).toBe(`u/${ME.id}/build/`);
    expect(kv.resolvePrefix(ME.id, "build").prefix).toBe(`u/${ME.id}/build`);
    expect(kv.resolvePrefix(ME.id, "shared/bitbucket-push/").prefix).toBe("shared/bitbucket-push/");
    expect(kv.resolvePrefix(ME.id, "shared/bitbucket-push").prefix).toBe("shared/bitbucket-push/");
    expect(() => kv.resolvePrefix(ME.id, "u/other.two@example.com/")).toThrow(/belong to one person/);
    expect(() => kv.resolvePrefix(ME.id, "shared/")).toThrow(/Name a shared namespace/);
    expect(() => kv.resolvePrefix(ME.id, "shared/other/")).toThrow(/not a shared namespace/);
    expect(() => kv.resolvePrefix(ME.id, "../")).toThrow();
    expect(() => kv.resolvePrefix(ME.id, "a//")).toThrow();
  });
});

describe("get, set, ttl", () => {
  it("sets and gets JSON values with the TTL left", () => {
    expect(kv.kvSet(ME, { key: "a", value: { n: 1, list: [1, "two"] }, ttlSeconds: 60 }, "mcp")).toEqual({ key: `u/${ME.id}/a`, set: true, ttlSeconds: 60 });
    vi.advanceTimersByTime(10_500);
    expect(kv.kvGet(ME, "a")).toEqual({ key: `u/${ME.id}/a`, found: true, kind: "value", value: { list: [1, "two"], n: 1 }, ttlSeconds: 50 });
    expect(kv.kvGet(ME, "missing")).toEqual({ key: `u/${ME.id}/missing`, found: false });
  });

  it("expires a key at its TTL, lazily and by the sweep", () => {
    kv.kvSet(ME, { key: "a", value: "x", ttlSeconds: 2 }, "mcp");
    kv.kvSet(ME, { key: "b", value: "y", ttlSeconds: 2 }, "mcp");
    vi.advanceTimersByTime(1999);
    expect(kv.kvGet(ME, "a").found).toBe(true);
    vi.advanceTimersByTime(1);
    expect(kv.kvGet(ME, "a").found).toBe(false);
    expect(kv.sweepExpired()).toBe(1);
    expect(kv.kvUsage(ME.id)).toMatchObject({ keys: 0, bytes: 0 });
  });

  it("runs the sweep on its own timer", () => {
    kv.kvSet(ME, { key: "a", value: "x", ttlSeconds: 1 }, "mcp");
    expect(kv.kvUsage(ME.id).keys).toBe(1);
    vi.advanceTimersByTime(kv.KV_SWEEP_INTERVAL_MS);
    expect(kv.kvUsage(ME.id).keys).toBe(0);
  });

  it("requires a TTL from 1 second to the maximum", () => {
    for (const ttl of [undefined, "", 0, -1, 1.5, 86_401, "abc", null]) {
      expect(() => kv.kvSet(ME, { key: "a", value: 1, ttlSeconds: ttl }, "mcp"), String(ttl)).toThrow(/ttlSeconds/);
    }
    expect(kv.kvSet(ME, { key: "a", value: 1, ttlSeconds: "1" }, "mcp").set).toBe(true);
    expect(kv.kvSet(ME, { key: "a", value: 1, ttlSeconds: 86_400 }, "mcp").set).toBe(true);
  });

  it("follows BAB_KV_MAX_TTL_SECONDS", async () => {
    process.env.BAB_KV_MAX_TTL_SECONDS = "10";
    (await import("../lib/config"))._resetConfigForTests();
    expect(() => kv.kvSet(ME, { key: "a", value: 1, ttlSeconds: 11 }, "mcp")).toThrow(/1 to 10/);
  });

  it("ifAbsent sets only once, even when many callers race", () => {
    const results = Array.from({ length: 25 }, (_, i) => kv.kvSet(i % 2 ? ME : ME, { key: "leader", value: `caller-${i}`, ttlSeconds: 30, ifAbsent: true }, "mcp"));
    expect(results.filter((r) => r.set)).toHaveLength(1);
    expect(results.slice(1).every((r) => r.reason === "exists")).toBe(true);
    expect(kv.kvGet(ME, "leader").value).toBe("caller-0");
  });

  it("ifExists sets only an existing key, and both flags at once are refused", () => {
    expect(kv.kvSet(ME, { key: "a", value: 1, ttlSeconds: 30, ifExists: true }, "mcp")).toMatchObject({ set: false, reason: "missing" });
    kv.kvSet(ME, { key: "a", value: 1, ttlSeconds: 30 }, "mcp");
    expect(kv.kvSet(ME, { key: "a", value: 2, ttlSeconds: 30, ifExists: "true" }, "mcp").set).toBe(true);
    expect(kv.kvGet(ME, "a").value).toBe(2);
    expect(() => kv.kvSet(ME, { key: "a", value: 2, ttlSeconds: 30, ifExists: true, ifAbsent: true }, "mcp")).toThrow(/cannot both/);
    expect(() => kv.kvSet(ME, { key: "a", value: 2, ttlSeconds: 30, ifExists: "maybe" }, "mcp")).toThrow(/true or false/);
  });

  it("treats an expired key as absent for ifAbsent", () => {
    kv.kvSet(ME, { key: "a", value: 1, ttlSeconds: 1, ifAbsent: true }, "mcp");
    vi.advanceTimersByTime(1000);
    expect(kv.kvSet(ME, { key: "a", value: 2, ttlSeconds: 1, ifAbsent: true }, "mcp").set).toBe(true);
  });

  it("keeps each person's u/ space apart", () => {
    kv.kvSet(ME, { key: "a", value: "mine", ttlSeconds: 30 }, "mcp");
    expect(kv.kvGet(THEM, "a").found).toBe(false);
    expect(() => kv.kvGet(THEM, `u/${ME.id}/a`)).toThrow(/belong to one person/);
    expect(() => kv.kvList(THEM, `u/${ME.id}/`)).toThrow(/belong to one person/);
    expect(() => kv.kvDelete(THEM, { key: `u/${ME.id}/a` }, "mcp")).toThrow(/belong to one person/);
    expect(kv.kvList(THEM, "").keys).toEqual([]);
  });

  it("shares keys in an allowed shared namespace between people", () => {
    kv.kvSet(ME, { key: "shared/bitbucket-push/note", value: "from me", ttlSeconds: 30 }, "mcp");
    expect(kv.kvGet(THEM, "shared/bitbucket-push/note").value).toBe("from me");
  });
});

describe("values", () => {
  it("refuses a value over the size limit", () => {
    expect(() => kv.kvSet(ME, { key: "a", value: "x".repeat(64 * 1024), ttlSeconds: 30 }, "mcp")).toThrow(/limit is 65536 bytes/);
    expect(kv.kvSet(ME, { key: "a", value: "x".repeat(64 * 1024 - 2), ttlSeconds: 30 }, "mcp").set).toBe(true);
  });

  it("refuses values that look like secrets or personal data, and names the kind only", () => {
    const secret = ["pass", "word: ", "s3cr3t-", "value-1234"].join("");
    let message = "";
    try {
      kv.kvSet(ME, { key: "a", value: secret, ttlSeconds: 30 }, "mcp");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/never keeps confidential data/);
    expect(message).not.toContain("s3cr3t");
    expect(() => kv.kvSet(ME, { key: "a", value: { note: secret }, ttlSeconds: 30 }, "mcp")).toThrow(/confidential/);
    expect(() => kv.kvSet(ME, { key: "a", value: "mail someone@outside-corp.net", ttlSeconds: 30 }, "mcp")).toThrow(/confidential/);
    expect(() => kv.kvCas(ME, { key: "a", expected: 1, value: secret, ttlSeconds: 30 }, "mcp")).toThrow(/confidential/);
    expect(kv.kvGet(ME, "a").found).toBe(false);
  });

  it("refuses values that are not JSON", () => {
    expect(() => kv.kvSet(ME, { key: "a", value: undefined, ttlSeconds: 30 }, "mcp")).toThrow(/value is required/);
    expect(() => kv.kvSet(ME, { key: "a", value: Number.NaN, ttlSeconds: 30 }, "mcp")).toThrow(/finite/);
    expect(() => kv.kvSet(ME, { key: "a", value: () => 1, ttlSeconds: 30 }, "mcp")).toThrow(/must be JSON/);
    expect(kv.kvSet(ME, { key: "a", value: null, ttlSeconds: 30 }, "mcp").set).toBe(true);
    expect(kv.kvGet(ME, "a").value).toBeNull();
  });
});

describe("cas", () => {
  it("swaps only when the value still matches, comparing JSON whatever the key order", () => {
    kv.kvSet(ME, { key: "state", value: { phase: "build", n: 1 }, ttlSeconds: 30 }, "mcp");
    expect(kv.kvCas(ME, { key: "state", expected: { n: 1, phase: "build" }, value: { phase: "test", n: 2 }, ttlSeconds: 60 }, "mcp")).toMatchObject({ swapped: true, ttlSeconds: 60 });
    const miss = kv.kvCas(ME, { key: "state", expected: { n: 1, phase: "build" }, value: "late", ttlSeconds: 60 }, "mcp");
    expect(miss).toMatchObject({ swapped: false, found: true, current: { phase: "test", n: 2 } });
    expect(kv.kvGet(ME, "state").value).toEqual({ phase: "test", n: 2 });
  });

  it("reports a missing key, and needs expected", () => {
    expect(kv.kvCas(ME, { key: "none", expected: 1, value: 2, ttlSeconds: 30 }, "mcp")).toEqual({ key: `u/${ME.id}/none`, swapped: false, found: false });
    expect(() => kv.kvCas(ME, { key: "none", expected: undefined, value: 2, ttlSeconds: 30 }, "mcp")).toThrow(/expected is required/);
  });

  it("lets exactly one of many racing writers win", () => {
    kv.kvSet(ME, { key: "v", value: 0, ttlSeconds: 30 }, "mcp");
    const wins = Array.from({ length: 20 }, (_, i) => kv.kvCas(ME, { key: "v", expected: 0, value: i + 1, ttlSeconds: 30 }, "mcp")).filter((r) => r.swapped);
    expect(wins).toHaveLength(1);
    expect(kv.kvGet(ME, "v").value).toBe(1);
  });
});

describe("incr", () => {
  it("creates with the TTL, adds without changing it, and counts every caller", () => {
    expect(kv.kvIncr(ME, { key: "c", ttlSeconds: 60 }, "mcp")).toMatchObject({ value: 1, created: true, ttlSeconds: 60 });
    vi.advanceTimersByTime(30_000);
    expect(kv.kvIncr(ME, { key: "c", by: 5, ttlSeconds: 600 }, "mcp")).toMatchObject({ value: 6, created: false, ttlSeconds: 30 });
    for (let i = 0; i < 100; i += 1) kv.kvIncr(ME, { key: "c" }, "mcp");
    expect(kv.kvGet(ME, "c").value).toBe(106);
    expect(kv.kvIncr(ME, { key: "c", by: "-6" }, "mcp").value).toBe(100);
  });

  it("needs a TTL to create, a whole number to add, and a number to add to", () => {
    expect(() => kv.kvIncr(ME, { key: "c" }, "mcp")).toThrow(/needed when incr creates/);
    expect(() => kv.kvIncr(ME, { key: "c", by: 1.5, ttlSeconds: 10 }, "mcp")).toThrow(/whole number/);
    kv.kvSet(ME, { key: "s", value: "text", ttlSeconds: 10 }, "mcp");
    expect(() => kv.kvIncr(ME, { key: "s" }, "mcp")).toThrow(/does not hold a whole number/);
    kv.kvSet(ME, { key: "big", value: Number.MAX_SAFE_INTEGER, ttlSeconds: 10 }, "mcp");
    expect(() => kv.kvIncr(ME, { key: "big" }, "mcp")).toThrow(/safe whole numbers/);
  });
});

describe("delete and list", () => {
  it("deletes, optionally only when the value matches", () => {
    kv.kvSet(ME, { key: "a", value: "one", ttlSeconds: 30 }, "mcp");
    expect(kv.kvDelete(ME, { key: "a", expected: "two" }, "mcp")).toMatchObject({ deleted: false, reason: "mismatch" });
    expect(kv.kvDelete(ME, { key: "a", expected: "one" }, "mcp").deleted).toBe(true);
    expect(kv.kvDelete(ME, { key: "a" }, "mcp")).toMatchObject({ deleted: false, reason: "missing" });
  });

  it("lists keys under a prefix with their TTL, never their values, sorted", () => {
    kv.kvSet(ME, { key: "build/b", value: "v", ttlSeconds: 30 }, "mcp");
    kv.kvSet(ME, { key: "build/a", value: "v", ttlSeconds: 20 }, "mcp");
    kv.kvSet(ME, { key: "other", value: "v", ttlSeconds: 30 }, "mcp");
    kv.kvSet(ME, { key: "gone", value: "v", ttlSeconds: 1 }, "mcp");
    kv.kvLock(ME, { key: "build/lock", ttlSeconds: 30 }, "mcp");
    vi.advanceTimersByTime(1000);
    const l = kv.kvList(ME, "build/");
    expect(l.keys.map((k) => k.key)).toEqual([`u/${ME.id}/build/a`, `u/${ME.id}/build/b`, `u/${ME.id}/build/lock`]);
    expect(l.keys[0]).toEqual({ key: `u/${ME.id}/build/a`, found: true, kind: "value", ttlSeconds: 19 });
    expect(l.keys[2]).toMatchObject({ kind: "lock", holder: ME.id });
    expect(JSON.stringify(l)).not.toContain("token");
    expect(kv.kvList(ME, "").keys).toHaveLength(4);
    expect(l.truncated).toBe(false);
  });
});

describe("throttle", () => {
  it("spaces many concurrent callers exactly one interval apart", () => {
    const calls = Array.from({ length: 50 }, (_, i) => kv.kvThrottle(i % 2 ? ME : THEM, { key: "shared/bitbucket-push/global", minIntervalSeconds: 10 }, "mcp"));
    expect(calls.map((c) => c.waitSeconds)).toEqual(Array.from({ length: 50 }, (_, i) => i * 10));
    expect(new Set(calls.map((c) => c.slotAt)).size).toBe(50);
    expect(calls[0].slotAt).toBe(new Date(T0).toISOString());
  });

  it("books from now once the pace has passed, and keeps fractional intervals", () => {
    expect(kv.kvThrottle(ME, { key: "t", minIntervalSeconds: 2.5 }, "mcp").waitSeconds).toBe(0);
    expect(kv.kvThrottle(ME, { key: "t", minIntervalSeconds: 2.5 }, "mcp").waitSeconds).toBe(2.5);
    vi.advanceTimersByTime(1000);
    expect(kv.kvThrottle(ME, { key: "t", minIntervalSeconds: 2.5 }, "mcp").waitSeconds).toBe(4);
    vi.advanceTimersByTime(60_000);
    expect(kv.kvThrottle(ME, { key: "t", minIntervalSeconds: 2.5 }, "mcp").waitSeconds).toBe(0);
  });

  it("refuses bad intervals and booking more than an hour ahead", () => {
    for (const v of [undefined, 0, 0.05, 3601, "x"]) expect(() => kv.kvThrottle(ME, { key: "t", minIntervalSeconds: v }, "mcp"), String(v)).toThrow(/minIntervalSeconds/);
    for (let i = 0; i < 4; i += 1) kv.kvThrottle(ME, { key: "t", minIntervalSeconds: 1200 }, "mcp");
    expect(() => kv.kvThrottle(ME, { key: "t", minIntervalSeconds: 1200 }, "mcp")).toThrow(/more than 3600 seconds ahead/);
  });

  it("does not run on a value key, and its key cannot be set over", () => {
    kv.kvSet(ME, { key: "v", value: 1, ttlSeconds: 30 }, "mcp");
    expect(() => kv.kvThrottle(ME, { key: "v", minIntervalSeconds: 1 }, "mcp")).toThrow(/holds a value/);
    kv.kvThrottle(THEM, { key: "shared/bitbucket-push/t", minIntervalSeconds: 60 }, "mcp");
    expect(() => kv.kvSet(ME, { key: "shared/bitbucket-push/t", value: 1, ttlSeconds: 30 }, "mcp")).toThrow(/holds a throttle/);
    expect(() => kv.kvDelete(ME, { key: "shared/bitbucket-push/t" }, "mcp")).toThrow(/holds a throttle/);
    expect(kv.kvGet(ME, "shared/bitbucket-push/t")).toMatchObject({ kind: "throttle", slotAt: new Date(T0).toISOString() });
  });
});

describe("lock", () => {
  it("gives the lock to one caller and tells the others who holds it", () => {
    const first = kv.kvLock(ME, { key: "shared/bitbucket-push/repo-a", ttlSeconds: 60 }, "mcp");
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    vi.advanceTimersByTime(15_000);
    expect(kv.kvLock(THEM, { key: "shared/bitbucket-push/repo-a", ttlSeconds: 60 }, "mcp")).toEqual({ key: "shared/bitbucket-push/repo-a", acquired: false, holder: ME.id, ttlSeconds: 45 });
    expect(kv.kvLock(ME, { key: "shared/bitbucket-push/repo-a", ttlSeconds: 60 }, "mcp").acquired).toBe(false);
    const got = kv.kvGet(THEM, "shared/bitbucket-push/repo-a");
    expect(got).toMatchObject({ kind: "lock", holder: ME.id });
    expect(JSON.stringify(got)).not.toContain(first.token);
  });

  it("is exclusive under many racing callers", () => {
    const tries = Array.from({ length: 30 }, (_, i) => kv.kvLock(i % 2 ? ME : THEM, { key: "shared/bitbucket-push/l", ttlSeconds: 10 }, "mcp"));
    expect(tries.filter((t) => t.acquired)).toHaveLength(1);
  });

  it("releases and renews only with the right token", () => {
    const lock = kv.kvLock(ME, { key: "shared/bitbucket-push/l", ttlSeconds: 10 }, "mcp");
    if (!lock.acquired) throw new Error("not acquired");
    expect(kv.kvUnlock(THEM, { key: "shared/bitbucket-push/l", token: "wrong" }, "mcp")).toMatchObject({ released: false, reason: "token_mismatch" });
    expect(kv.kvRenew(THEM, { key: "shared/bitbucket-push/l", token: lock.token.slice(0, -1) + (lock.token.endsWith("x") ? "y" : "x"), ttlSeconds: 60 }, "mcp")).toMatchObject({ renewed: false, reason: "token_mismatch" });
    expect(() => kv.kvUnlock(THEM, { key: "shared/bitbucket-push/l", token: "" }, "mcp")).toThrow(/token is required/);
    expect(() => kv.kvDelete(THEM, { key: "shared/bitbucket-push/l" }, "mcp")).toThrow(/holds a lock/);
    expect(() => kv.kvSet(THEM, { key: "shared/bitbucket-push/l", value: 1, ttlSeconds: 10 }, "mcp")).toThrow(/holds a lock/);
    expect(() => kv.kvCas(THEM, { key: "shared/bitbucket-push/l", expected: 1, value: 1, ttlSeconds: 10 }, "mcp")).toThrow(/holds a lock/);
    expect(() => kv.kvIncr(THEM, { key: "shared/bitbucket-push/l" }, "mcp")).toThrow(/holds a lock/);
    expect(() => kv.kvThrottle(THEM, { key: "shared/bitbucket-push/l", minIntervalSeconds: 1 }, "mcp")).toThrow(/holds a lock/);

    vi.advanceTimersByTime(9_000);
    expect(kv.kvRenew(ME, { key: "shared/bitbucket-push/l", token: lock.token, ttlSeconds: 30 }, "mcp")).toMatchObject({ renewed: true, ttlSeconds: 30 });
    vi.advanceTimersByTime(20_000);
    expect(kv.kvLock(THEM, { key: "shared/bitbucket-push/l", ttlSeconds: 10 }, "mcp").acquired).toBe(false);
    expect(kv.kvUnlock(ME, { key: "shared/bitbucket-push/l", token: lock.token }, "mcp").released).toBe(true);
    expect(kv.kvUnlock(ME, { key: "shared/bitbucket-push/l", token: lock.token }, "mcp")).toMatchObject({ released: false, reason: "not_held" });
    expect(kv.kvLock(THEM, { key: "shared/bitbucket-push/l", ttlSeconds: 10 }, "mcp").acquired).toBe(true);
  });

  it("expires at its TTL so a crashed holder never blocks for ever", () => {
    const lock = kv.kvLock(ME, { key: "l", ttlSeconds: 5 }, "mcp");
    vi.advanceTimersByTime(5000);
    expect(kv.kvLock(ME, { key: "l", ttlSeconds: 5 }, "mcp").acquired).toBe(true);
    if (lock.acquired) expect(kv.kvRenew(ME, { key: "l", token: lock.token, ttlSeconds: 5 }, "mcp")).toMatchObject({ renewed: false, reason: "token_mismatch" });
  });

  it("lets the owner delete a lock in their own space, but not with expected", () => {
    kv.kvLock(ME, { key: "l", ttlSeconds: 5 }, "mcp");
    expect(() => kv.kvDelete(ME, { key: "l", expected: 1 }, "mcp")).toThrow(/holds a lock/);
    expect(kv.kvDelete(ME, { key: "l" }, "mcp").deleted).toBe(true);
  });
});

describe("limits", () => {
  it("caps the keys per person and per shared namespace", async () => {
    process.env.BAB_KV_MAX_KEYS_PER_USER = "3";
    (await import("../lib/config"))._resetConfigForTests();
    for (const k of ["a", "b", "c"]) kv.kvSet(ME, { key: k, value: 1, ttlSeconds: 30 }, "mcp");
    expect(kv.kvSet(ME, { key: "a", value: 2, ttlSeconds: 30 }, "mcp").set).toBe(true);
    let status = 0;
    try {
      kv.kvSet(ME, { key: "d", value: 1, ttlSeconds: 30 }, "mcp");
    } catch (e) {
      status = (e as { status: number }).status;
      expect((e as Error).message).toMatch(/You already hold 3 keys, the limit is 3/);
    }
    expect(status).toBe(507);
    expect(kv.kvSet(THEM, { key: "d", value: 1, ttlSeconds: 30 }, "mcp").set).toBe(true);
    for (const k of ["a", "b", "c"]) kv.kvLock(THEM, { key: `shared/bitbucket-push/${k}`, ttlSeconds: 30 }, "mcp");
    expect(() => kv.kvThrottle(ME, { key: "shared/bitbucket-push/d", minIntervalSeconds: 1 }, "mcp")).toThrow(/namespace shared\/bitbucket-push\/ already holds 3 keys/);
    kv.kvDelete(ME, { key: "a" }, "mcp");
    expect(kv.kvSet(ME, { key: "d", value: 1, ttlSeconds: 30 }, "mcp").set).toBe(true);
  });

  it("caps the bytes per person and in all", async () => {
    process.env.BAB_KV_MAX_VALUE_BYTES = "1000";
    process.env.BAB_KV_MAX_BYTES_PER_USER = "3000";
    process.env.BAB_KV_MAX_TOTAL_BYTES = "4000";
    (await import("../lib/config"))._resetConfigForTests();
    const v = "x".repeat(900);
    kv.kvSet(ME, { key: "a", value: v, ttlSeconds: 30 }, "mcp");
    kv.kvSet(ME, { key: "b", value: v, ttlSeconds: 30 }, "mcp");
    kv.kvSet(ME, { key: "c", value: v, ttlSeconds: 30 }, "mcp");
    expect(() => kv.kvSet(ME, { key: "d", value: v, ttlSeconds: 30 }, "mcp")).toThrow(/limit is 3000/);
    kv.kvSet(THEM, { key: "a", value: v, ttlSeconds: 30 }, "mcp");
    expect(() => kv.kvSet(THEM, { key: "b", value: v, ttlSeconds: 30 }, "mcp")).toThrow(/store is full/);
    expect(() => kv.kvSet(ME, { key: "a", value: "x".repeat(1000), ttlSeconds: 30 }, "mcp")).toThrow(/limit is 1000 bytes/);
    // Overwriting with a smaller value always fits.
    expect(kv.kvSet(ME, { key: "a", value: "small", ttlSeconds: 30 }, "mcp").set).toBe(true);
  });
});

describe("audit", () => {
  it("records writes with key, operation and result, never the value or a token", async () => {
    kv.kvSet(ME, { key: "a", value: "the-value-text", ttlSeconds: 30 }, "mcp");
    kv.kvSet(ME, { key: "a", value: "the-value-text", ttlSeconds: 30, ifAbsent: true }, "mcp");
    kv.kvGet(ME, "a");
    kv.kvList(ME, "");
    const lock = kv.kvLock(ME, { key: "l", ttlSeconds: 30 }, "mcp");
    kv.kvThrottle(ME, { key: "t", minIntervalSeconds: 1 }, "mcp");
    kv.kvIncr(ME, { key: "c", ttlSeconds: 30 }, "mcp");
    kv.kvCas(ME, { key: "a", expected: "nope", value: "other-text", ttlSeconds: 30 }, "mcp");
    kv.kvDelete(ME, { key: "a" }, "mcp");
    if (lock.acquired) kv.kvUnlock(ME, { key: "l", token: lock.token }, "mcp");
    const rows = await auditRows();
    expect(rows.map((r) => `${r.action}:${JSON.parse(r.details).result}`)).toEqual([
      "kv_set:set", "kv_set:exists", "kv_lock:acquired", "kv_throttle:now", "kv_incr:created", "kv_cas:mismatch", "kv_delete:deleted", "kv_unlock:released",
    ]);
    expect(rows.every((r) => r.actor_id === ME.id && r.entity === "kv")).toBe(true);
    expect(rows[0].entity_id).toBe(`u/${ME.id}/a`);
    const all = JSON.stringify(rows);
    expect(all).not.toContain("the-value-text");
    expect(all).not.toContain("other-text");
    if (lock.acquired) expect(all).not.toContain(lock.token);
  });
});

describe("switches", () => {
  it("refuses every call when switched off or when more than one replica is configured", async () => {
    const actor = { id: ME.id, source: "device" as const };
    process.env.BAB_KV = "0";
    (await import("../lib/config"))._resetConfigForTests();
    expect(() => kv.runKv(actor, { action: "get", key: "a" }, "mcp")).toThrow(/switched off/);
    delete process.env.BAB_KV;
    process.env.BAB_REPLICAS = "2";
    (await import("../lib/config"))._resetConfigForTests();
    try {
      kv.runKv(actor, { action: "get", key: "a" }, "mcp");
      throw new Error("no throw");
    } catch (e) {
      expect((e as { status: number }).status).toBe(503);
      expect((e as Error).message).toMatch(/BAB_REPLICAS is 2/);
    }
  });

  it("needs an action, with no default", () => {
    const actor = { id: ME.id, source: "device" as const };
    expect(() => kv.runKv(actor, {}, "mcp")).toThrow(/required, has no default/);
    expect(() => kv.runKv(actor, { action: "flushall" }, "mcp")).toThrow(/action must be one of/);
  });

  it("runs every action through runKv", () => {
    const a = { id: ME.id, source: "device" as const };
    expect(kv.runKv(a, { action: "set", key: "k", value: 1, ttlSeconds: 30 }, "mcp")).toMatchObject({ set: true });
    expect(kv.runKv(a, { action: "get", key: "k" }, "mcp")).toMatchObject({ value: 1 });
    expect(kv.runKv(a, { action: "cas", key: "k", expected: 1, value: 2, ttlSeconds: 30 }, "mcp")).toMatchObject({ swapped: true });
    expect(kv.runKv(a, { action: "incr", key: "k", by: 3 }, "mcp")).toMatchObject({ value: 5 });
    expect(kv.runKv(a, { action: "list", prefix: "" }, "mcp")).toMatchObject({ usage: { keys: 1, maxKeys: 1000 } });
    expect(kv.runKv(a, { action: "delete", key: "k", expected: 5 }, "mcp")).toMatchObject({ deleted: true });
    expect(kv.runKv(a, { action: "throttle", key: "t", minIntervalSeconds: 1 }, "mcp")).toMatchObject({ waitSeconds: 0 });
    const lock = kv.runKv(a, { action: "lock", key: "l", ttlSeconds: 30 }, "mcp") as { token: string };
    expect(kv.runKv(a, { action: "renew", key: "l", token: lock.token, ttlSeconds: 30 }, "mcp")).toMatchObject({ renewed: true });
    expect(kv.runKv(a, { action: "unlock", key: "l", token: lock.token }, "mcp")).toMatchObject({ released: true });
  });
});
