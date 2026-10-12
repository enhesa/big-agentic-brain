import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-readyz-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    // already gone
  }
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("GET /readyz", () => {
  it("returns 200 { ok: true } when the database answers and the data dir is writable", async () => {
    const { GET } = await import("../app/readyz/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "returns 503 when DATA_DIR is not writable, without leaking paths",
    async () => {
      const { getDb } = await import("../lib/db");
      getDb();
      chmodSync(dataDir, 0o500);
      const { GET } = await import("../app/readyz/route");
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(typeof body.error).toBe("string");
      expect(body.error).not.toContain(dataDir);
    },
  );
});

describe("GET /readyz when getDb throws", () => {
  it("returns 503 with only { ok: false, error } and no path segments", async () => {
    vi.resetModules();
    vi.doMock("../lib/db", () => ({
      getDb: () => {
        throw new Error("boom at /data/bab.db");
      },
      resolveDataDir: () => "/data",
    }));
    const { GET } = await import("../app/readyz/route");
    const res = await GET();
    vi.doUnmock("../lib/db");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["error", "ok"]);
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error).not.toContain("/");
  });
});
