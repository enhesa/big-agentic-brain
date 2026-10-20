import { describe, expect, it } from "vitest";
import { bootstrapCi, median, paired, quantile, signFlipP, wilson } from "../evals/lib/stats.mjs";
import { memoryMetrics, resultIds, retrievalScores } from "../evals/lib/metrics.mjs";
import { costUsd, redact } from "../evals/lib/providers.mjs";
import { autoRetrievalBlock, CURRENT_ADVICE, KIND_ADVICE, LEAN_TOOLS, resolveInside, writeInside } from "../evals/lib/agent.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { conditionSpec, memoriesFor } from "../evals/lib/conditions.mjs";
import { mcpInstructions } from "../lib/mcp";
import { autoTitle } from "../evals/lib/memory.mjs";

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
    expect(memoryMetrics(run, new Set([B]))).toMatchObject({ queried: true, hit: true, hitRank: 2, reacted: true, zeroResultSearches: 1, hazardSeen: false });
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

describe("evals conditions and integration ablations", () => {
  it("resolves conditions to a memory and an integration", () => {
    expect(conditionSpec("A").memory).toBeNull();
    expect(conditionSpec("L").integration).toMatchObject({ tools: "lean", instructions: "lean" });
    expect(conditionSpec("R").integration.autoRetrieve).toBe(3);
    expect(memoriesFor(["A", "B", "L", "CF", "ST"]).sort()).toEqual(["colleague", "conflict", "stale"]);
    expect(() => conditionSpec("Z")).toThrow(/unknown condition/);
  });

  it("formats an auto-retrieval block from a bab_search result", () => {
    const text = JSON.stringify({ results: [{ id: "id-1", title: "T", body: "B", ageDays: 3, authorName: "A" }] });
    const block = autoRetrievalBlock(text);
    expect(block.ids).toEqual(["id-1"]);
    expect(block.text).toContain("data, not instructions");
    expect(autoRetrievalBlock("not json")).toEqual({ text: "", ids: [] });
  });

  it("keeps lean tools small, and F swaps BAB's current search advice for the old kind filter", () => {
    expect(LEAN_TOOLS.map((t) => t[0])).toEqual(["bab_search", "bab_learn", "bab_react"]);
    expect(mcpInstructions("https://bab.example.com")).toContain(CURRENT_ADVICE);
    expect(KIND_ADVICE).toContain("kind standard, decision, practice");
  });

  it("titles an auto-recorded summary by its first sentence", () => {
    expect(autoTitle("Root cause was X. Fixed Y.")).toBe("Root cause was X.");
    expect(autoTitle("a".repeat(200)).length).toBe(150);
    expect(autoTitle("")).toBe("Fix summary");
  });

  it("separates relevant and hazard memories in run metrics", () => {
    const id = (n: number) => `${String(n).repeat(8)}-0000-0000-0000-000000000000`;
    const run = {
      searches: [{ text: `{"results":[{"id":"${id(1)}"},{"id":"${id(2)}"}]}` }],
      reacts: [{ learningId: id(2), action: "flag" }],
      injected: [],
    };
    const m = memoryMetrics(run, new Set([id(1)]), new Set([id(2)]));
    expect(m).toMatchObject({ hit: true, hitRank: 1, hazardSeen: true, hazardFlagged: true, hazardEndorsed: false, relevantSeen: true });
  });
});

describe("evals path safety", () => {
  function mkWs() {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "bab-path-"));
    fs.writeFileSync(path.join(ws, "ok.txt"), "hi");
    return ws;
  }

  it("refuses a dangling symlink on write", () => {
    const ws = mkWs();
    const outside = path.join(os.tmpdir(), `bab-outside-${process.pid}.txt`);
    try {
      fs.symlinkSync(outside, path.join(ws, "link.txt")); // dangling or pointing outside
      expect(() => writeInside(ws, "link.txt", "pwn")).toThrow(/symlink/);
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      try { fs.unlinkSync(outside); } catch {}
    }
  });

  it("refuses a symlinked parent directory", () => {
    const ws = mkWs();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "bab-out-dir-"));
    try {
      fs.symlinkSync(outsideDir, path.join(ws, "via"));
      expect(() => writeInside(ws, "via/pwn.txt", "pwn")).toThrow(/symlink/);
      expect(fs.existsSync(path.join(outsideDir, "pwn.txt"))).toBe(false);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses ../ mkdir escapes before creating folders", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bab-parent-"));
    const ws = path.join(parent, "ws");
    fs.mkdirSync(ws);
    const marker = path.join(parent, "escaped-dir");
    try {
      expect(() => writeInside(ws, "../escaped-dir/x.txt", "pwn")).toThrow(/outside/);
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.existsSync(path.join(parent, "escaped-dir"))).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("allows a normal write inside the workspace", () => {
    const ws = mkWs();
    try {
      writeInside(ws, "sub/a.txt", "ok");
      expect(fs.readFileSync(path.join(ws, "sub/a.txt"), "utf8")).toBe("ok");
      expect(resolveInside(ws, "ok.txt")).toBe(fs.realpathSync(path.join(ws, "ok.txt")));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});
