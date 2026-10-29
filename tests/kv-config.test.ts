import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config, _resetConfigForTests, logEffectiveConfig } from "../lib/config";

function clear() {
  for (const k of Object.keys(process.env)) if (k.startsWith("BAB_KV") || k === "BAB_REPLICAS") delete process.env[k];
  _resetConfigForTests();
}

beforeEach(clear);
afterEach(clear);

function withEnv(env: Record<string, string>) {
  Object.assign(process.env, env);
  _resetConfigForTests();
  return () => config();
}

describe("key-value settings", () => {
  it("has the documented defaults", () => {
    expect(config().kv).toEqual({
      enabled: true,
      sharedNamespaces: ["bitbucket-push"],
      maxValueBytes: 65536,
      maxKeysPerUser: 1000,
      maxBytesPerUser: 4194304,
      maxTotalBytes: 20971520,
      maxTtlSeconds: 86400,
      allowDeclared: false,
    });
    expect(config().replicas).toBe(1);
  });

  it("refuses to start on bad values", () => {
    expect(withEnv({ BAB_KV_SHARED_NAMESPACES: "Build" })).toThrow(/BAB_KV_SHARED_NAMESPACES holds a name/);
    clear();
    expect(withEnv({ BAB_KV_SHARED_NAMESPACES: "a/b" })).toThrow(/BAB_KV_SHARED_NAMESPACES holds a name/);
    clear();
    expect(withEnv({ BAB_KV_SHARED_NAMESPACES: "a..b" })).toThrow(/BAB_KV_SHARED_NAMESPACES holds a name/);
    clear();
    expect(withEnv({ BAB_KV_SHARED_NAMESPACES: " , " })).toThrow(/at least one name, or none/);
    clear();
    expect(withEnv({ BAB_KV_MAX_VALUE_BYTES: "300000" })).toThrow(/at most 262144/);
    clear();
    expect(withEnv({ BAB_KV_MAX_VALUE_BYTES: "5000", BAB_KV_MAX_BYTES_PER_USER: "4000" })).toThrow(/must not exceed BAB_KV_MAX_BYTES_PER_USER/);
    clear();
    expect(withEnv({ BAB_KV_MAX_BYTES_PER_USER: "30000000" })).toThrow(/must not exceed BAB_KV_MAX_TOTAL_BYTES/);
    clear();
    expect(withEnv({ BAB_KV_MAX_TOTAL_BYTES: "300000000", BAB_KV_MAX_BYTES_PER_USER: "4194304" })).toThrow(/at most 268435456/);
    clear();
    expect(withEnv({ BAB_KV_MAX_TTL_SECONDS: "604801" })).toThrow(/at most 604800/);
    clear();
    expect(withEnv({ BAB_KV_MAX_KEYS_PER_USER: "0" })).toThrow(/positive integer/);
    clear();
    expect(withEnv({ BAB_REPLICAS: "0" })).toThrow(/positive integer/);
    clear();
    expect(withEnv({ BAB_KV: "maybe" })).toThrow(/boolean/);
  });

  it("takes names with or without shared/, drops duplicates, and none means none", () => {
    expect(withEnv({ BAB_KV_SHARED_NAMESPACES: "shared/a/, b,a" })().kv.sharedNamespaces).toEqual(["a", "b"]);
    clear();
    expect(withEnv({ BAB_KV_SHARED_NAMESPACES: "none" })().kv.sharedNamespaces).toEqual([]);
  });

  it("logs the store's settings and warns about declared identities and replicas", () => {
    withEnv({ BAB_KV_ALLOW_DECLARED: "1", BAB_REPLICAS: "2" });
    const lines: string[] = [];
    logEffectiveConfig((l) => lines.push(l));
    expect(lines.find((l) => l.startsWith("[config] kv:"))).toContain("shared=bitbucket-push");
    expect(lines.some((l) => l.includes("BAB_KV_ALLOW_DECLARED is on"))).toBe(true);
    expect(lines.some((l) => l.includes("BAB_REPLICAS is 2"))).toBe(true);
  });
});
