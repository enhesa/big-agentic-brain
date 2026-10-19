import { describe, expect, it } from "vitest";
import { bootstrapCi, median, paired, quantile, signFlipP, wilson } from "../evals/lib/stats.mjs";
import { memoryMetrics, resultIds, retrievalScores } from "../evals/lib/metrics.mjs";
import { costUsd, redact } from "../evals/lib/providers.mjs";

describe("evals stats", () => {
  it("wilson interval matches the closed form", () => {
    const [p, lo, hi] = wilson(36, 36);
    expect(p).toBe(1);
    expect(lo).toBeCloseTo(0.9036, 3);
    expect(hi).toBe(1);
    expect(wilson(0, 0).every(Number.isNaN)).toBe(true);
  });

  it("quantiles interpolate", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
  });

  it("sign-flip test is exact for small n", () => {
    expect(signFlipP(Array(12).fill(1))).toBeCloseTo(2 / 4096, 10);
    expect(signFlipP([0, 0, 0])).toBe(1);
    expect(signFlipP([1, -1])).toBe(1);
  });

  it("bootstrap is deterministic and brackets a constant", () => {
    const a = bootstrapCi((idx: number[]) => idx.length, 5, { reps: 200 });
    expect(a).toEqual([5, 5]);
  });

  it("paired comparison averages trials within task", () => {
    const r = paired({ t1: { A: [1, 3], X: [4] }, t2: { A: [2], X: [2] }, t3: { A: [], X: [9] } });
    expect(r.nTasks).toBe(2);
    expect(r.aMean).toBe(2);
    expect(r.xMean).toBe(3);
    expect(r.ratio).toBe(1.5);
  });
});

describe("evals metrics", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const search = (ids: string[]) => ({ args: {}, text: JSON.stringify({ results: ids.map((id) => ({ id, title: "x" })) }) });

  it("reads result ids in rank order, even from truncated output", () => {
    const text = search([A, B]).text;
    expect(resultIds(text)).toEqual([A, B]);
    expect(resultIds(text.slice(0, text.indexOf(B) + 40))).toEqual([A, B]);
    expect(resultIds("not json")).toEqual([]);
  });

  it("computes hit, rank and reaction for a run", () => {
    const run = { searches: [search([]), search([A, B])], reacts: [{ learningId: B, action: "helpful" }] };
    expect(memoryMetrics(run, new Set([B]))).toEqual({ queried: true, hit: true, hitRank: 2, reacted: true, zeroResultSearches: 1 });
    expect(memoryMetrics({ searches: [], reacts: [] }, new Set([B]))).toMatchObject({ queried: false, hit: false, hitRank: null });
  });

  it("scores recall@k and reciprocal rank", () => {
    expect(retrievalScores(2)).toEqual({ rr: 0.5, "recall@1": 0, "recall@3": 1, "recall@5": 1 });
    expect(retrievalScores(null)).toEqual({ rr: 0, "recall@1": 0, "recall@3": 0, "recall@5": 0 });
  });
});

describe("evals providers", () => {
  it("prices usage per million tokens", () => {
    const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
    expect(costUsd(usage, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 })).toBeCloseTo(12.1, 6);
    expect(costUsd(usage, null)).toBe(0);
  });

  it("redacts key values from logged text", () => {
    process.env.EVALS_TEST_API_KEY = "sk-test-0123456789abcdef";
    expect(redact("error for sk-test-0123456789abcdef here")).toBe("error for [REDACTED] here");
    delete process.env.EVALS_TEST_API_KEY;
  });
});
