import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-idempotency-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("normalizeIdempotencyKey", () => {
  it("trims and accepts a reasonable key", async () => {
    const { normalizeIdempotencyKey } = await import("../lib/idempotency");
    expect(normalizeIdempotencyKey("  abc-123  ")).toBe("abc-123");
  });

  it("rejects missing, empty, or over-120-char keys", async () => {
    const { normalizeIdempotencyKey } = await import("../lib/idempotency");
    expect(normalizeIdempotencyKey(null)).toBeNull();
    expect(normalizeIdempotencyKey("")).toBeNull();
    expect(normalizeIdempotencyKey("   ")).toBeNull();
    expect(normalizeIdempotencyKey("x".repeat(121))).toBeNull();
  });
});

describe("getStoredResponse / storeResponse", () => {
  it("round-trips a stored response for the same actor+key", async () => {
    const { storeResponse, getStoredResponse } = await import("../lib/idempotency");
    storeResponse("actor-1", "key-1", 201, { ok: true });
    expect(getStoredResponse("actor-1", "key-1")).toEqual({ status: 201, body: { ok: true } });
  });

  it("is scoped per actor: another actor with the same key gets nothing", async () => {
    const { storeResponse, getStoredResponse } = await import("../lib/idempotency");
    storeResponse("actor-1", "shared-key", 201, { from: "actor-1" });
    expect(getStoredResponse("actor-2", "shared-key")).toBeUndefined();
  });
});

describe("withIdempotency", () => {
  it("runs the handler once and replays its response on a repeat key", async () => {
    const { withIdempotency } = await import("../lib/idempotency");
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { status: 201, body: { calls } };
    };

    const req1 = new Request("http://x", { headers: { "Idempotency-Key": "k1" } });
    const res1 = await withIdempotency(req1, "actor-1", fn);
    expect(await res1.json()).toEqual({ calls: 1 });

    const req2 = new Request("http://x", { headers: { "Idempotency-Key": "k1" } });
    const res2 = await withIdempotency(req2, "actor-1", fn);
    expect(await res2.json()).toEqual({ calls: 1 });
    expect(res2.headers.get("Idempotent-Replayed")).toBe("true");
    expect(calls).toBe(1);
  });

  it("runs the handler once when two requests with the same key are in flight together", async () => {
    const { withIdempotency } = await import("../lib/idempotency");
    let calls = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fn = async () => {
      calls += 1;
      await gate; // the first call is slow; the retry arrives before it finishes
      return { status: 201, body: { calls } };
    };
    const mk = () => new Request("http://x", { headers: { "Idempotency-Key": "race" } });

    const p1 = withIdempotency(mk(), "actor-1", fn);
    const p2 = withIdempotency(mk(), "actor-1", fn);
    releaseFirst();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(calls).toBe(1);
    expect(await r1.json()).toEqual({ calls: 1 });
    expect(await r2.json()).toEqual({ calls: 1 });
    expect(r2.headers.get("Idempotent-Replayed")).toBe("true");

    // The chain is released afterwards: a fresh key still runs.
    const r3 = await withIdempotency(
      new Request("http://x", { headers: { "Idempotency-Key": "other" } }),
      "actor-1",
      fn,
    );
    expect(r3.status).toBe(201);
    expect(calls).toBe(2);
  });

  it("runs the handler every time when no Idempotency-Key is sent", async () => {
    const { withIdempotency } = await import("../lib/idempotency");
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { status: 200, body: { calls } };
    };

    await withIdempotency(new Request("http://x"), "actor-1", fn);
    await withIdempotency(new Request("http://x"), "actor-1", fn);
    expect(calls).toBe(2);
  });
});
