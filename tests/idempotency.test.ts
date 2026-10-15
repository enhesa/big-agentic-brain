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

  it("treats missing, empty, or over-120-char keys as no key (withIdempotency answers the long one with a 400)", async () => {
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

describe("withIdempotency: request fingerprint and key length", () => {
  const post = (body: unknown, key = "k1", path = "/api/things") =>
    new Request(`http://x${path}`, { method: "POST", headers: { "Idempotency-Key": key, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("422s a replayed key with a different body and does not run the handler", async () => {
    const { withIdempotency } = await import("../lib/idempotency");
    let calls = 0;
    const fn = async () => ({ status: 201, body: { calls: ++calls } });
    expect((await withIdempotency(post({ a: 1 }), "actor-1", fn)).status).toBe(201);

    const res = await withIdempotency(post({ a: 2 }), "actor-1", fn);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Idempotency-Key was already used with a different request" });
    expect(calls).toBe(1);
  });

  it("replays a repeat of the same body, and the handler can still read the body on the first call", async () => {
    const { withIdempotency } = await import("../lib/idempotency");
    const seen: unknown[] = [];
    const run = async (req: Request) =>
      withIdempotency(req, "actor-1", async () => {
        seen.push(await req.json());
        return { status: 201, body: { ok: true } };
      });
    const first = await run(post({ a: 1 }));
    expect(first.status).toBe(201);
    const second = await run(post({ a: 1 }));
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("replays when the JSON is the same but serialized differently (key order, whitespace)", async () => {
    const { withIdempotency } = await import("../lib/idempotency");
    let calls = 0;
    const fn = async () => ({ status: 201, body: { calls: ++calls } });
    const raw = (text: string) => new Request("http://x/api/things", { method: "POST", headers: { "Idempotency-Key": "k1", "content-type": "application/json" }, body: text });
    expect((await withIdempotency(raw('{"a":1,"b":{"c":2,"d":3}}'), "actor-1", fn)).status).toBe(201);
    const res = await withIdempotency(raw('{ "b": { "d": 3, "c": 2 }, "a": 1 }'), "actor-1", fn);
    expect(res.status).toBe(201);
    expect(res.headers.get("Idempotent-Replayed")).toBe("true");
    expect(calls).toBe(1);
  });

  it("422s the same key and body sent with a different query string", async () => {
    const { withIdempotency } = await import("../lib/idempotency");
    const fn = async () => ({ status: 201, body: { ok: true } });
    await withIdempotency(post({ a: 1 }, "k1", "/api/one?x=1"), "actor-1", fn);
    const res = await withIdempotency(post({ a: 1 }, "k1", "/api/one?x=2"), "actor-1", fn);
    expect(res.status).toBe(422);
  });

  it("422s the same key and body sent to a different path", async () => {
    const { withIdempotency } = await import("../lib/idempotency");
    const fn = async () => ({ status: 201, body: { ok: true } });
    await withIdempotency(post({ a: 1 }, "k1", "/api/one"), "actor-1", fn);
    const res = await withIdempotency(post({ a: 1 }, "k1", "/api/two"), "actor-1", fn);
    expect(res.status).toBe(422);
  });

  it("keeps working for a row stored before the fingerprint existed (replays it)", async () => {
    const { withIdempotency, storeResponse } = await import("../lib/idempotency");
    storeResponse("actor-1", "old", 201, { legacy: true });
    const res = await withIdempotency(post({ a: 1 }, "old"), "actor-1", async () => ({ status: 201, body: { fresh: true } }));
    expect(res.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await res.json()).toEqual({ legacy: true });
  });

  it("400s a key longer than 120 characters without running the handler; 120 is fine", async () => {
    const { withIdempotency } = await import("../lib/idempotency");
    let calls = 0;
    const fn = async () => ({ status: 201, body: { calls: ++calls } });
    const long = await withIdempotency(post({ a: 1 }, "k".repeat(121)), "actor-1", fn);
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: "Idempotency-Key is too long (max 120)" });
    expect(calls).toBe(0);
    expect((await withIdempotency(post({ a: 1 }, "k".repeat(120)), "actor-1", fn)).status).toBe(201);
  });
});
