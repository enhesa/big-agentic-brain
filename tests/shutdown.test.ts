import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-shutdown-"));
  process.env.DATA_DIR = dataDir;
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  const { _resetShutdownForTests } = await import("../lib/shutdown");
  _resetShutdownForTests();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  const { _resetShutdownForTests } = await import("../lib/shutdown");
  _resetShutdownForTests();
  delete process.env.DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("shutdown", () => {
  it("wakes registered waiters once, and runs a late registration immediately", async () => {
    const { beginShutdown, onShutdown, isShuttingDown } = await import("../lib/shutdown");
    let woke = 0;
    const off = onShutdown(() => woke++);
    const off2 = onShutdown(() => woke++);
    off2();
    expect(isShuttingDown()).toBe(false);
    beginShutdown();
    beginShutdown();
    expect(woke).toBe(1);
    expect(isShuttingDown()).toBe(true);
    onShutdown(() => woke++);
    expect(woke).toBe(2);
    off();
  });

  it("beginShutdown leaves the database open for in-flight requests", async () => {
    const { getDb } = await import("../lib/db");
    const { beginShutdown } = await import("../lib/shutdown");
    getDb();
    beginShutdown();
    expect(() => getDb().prepare("SELECT 1").get()).not.toThrow();
  });
});
