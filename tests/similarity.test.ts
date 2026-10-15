import { describe, it, expect } from "vitest";
import {
  normalizeTokens,
  jaccard,
  similarityScore,
  DUPLICATE_THRESHOLD,
  SIMILAR_THRESHOLD,
} from "../lib/similarity";

describe("normalizeTokens", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeTokens("Use RunTest.sh, not `dotnet` test!")).toEqual(["runtest", "dotnet", "test"]);
  });

  it("drops stopwords and tokens under 3 chars", () => {
    const tokens = normalizeTokens("the API is on and a go to it");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("and");
    expect(tokens).not.toContain("is");
    expect(tokens).not.toContain("on");
    expect(tokens).not.toContain("go");
    expect(tokens).not.toContain("to");
    expect(tokens).not.toContain("it");
    expect(tokens).not.toContain("a");
    expect(tokens).toContain("api");
  });

  it("keeps digit tokens of length >= 3", () => {
    const tokens = normalizeTokens("connect on port 8443 please");
    expect(tokens).toContain("8443");
  });

  it("returns an empty array for empty input", () => {
    expect(normalizeTokens("")).toEqual([]);
  });
});

describe("jaccard", () => {
  it("is 1 for identical sets", () => {
    expect(jaccard(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
  });

  it("is 0 for disjoint sets", () => {
    expect(jaccard(["a", "b"], ["c", "d"])).toBe(0);
  });

  it("is 0 for two empty sets", () => {
    expect(jaccard([], [])).toBe(0);
  });

  it("handles partial overlap", () => {
    // intersection {b,c} = 2, union {a,b,c,d} = 4
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5);
  });

  it("de-duplicates repeated tokens", () => {
    expect(jaccard(["a", "a", "b"], ["a", "b", "b"])).toBe(1);
  });
});

describe("similarityScore", () => {
  it("scores identical title/body/tags at 1", () => {
    const l = { title: "Use runTest.sh for tests", body: "It wires up loggers and coverage", tags: ["ci", "testing"] };
    expect(similarityScore(l, l)).toBeCloseTo(1);
  });

  it("scores completely unrelated learnings near 0", () => {
    const a = { title: "Coffee machine on floor 3 is broken", body: "Use floor 2 instead until fixed", tags: ["facilities"] };
    const b = { title: "Kubernetes context defaults to dev", body: "Always check kubectl config before running anything", tags: ["engineering", "kubernetes"] };
    expect(similarityScore(a, b)).toBeLessThan(SIMILAR_THRESHOLD);
  });

  it("weighs title higher than body", () => {
    const draft = { title: "Use runTest.sh not dotnet test", body: "Different body content entirely here", tags: [] };
    const sameTitle = { title: "Use runTest.sh not dotnet test", body: "Something else unrelated altogether", tags: [] };
    const sameBody = { title: "Completely different heading here", body: "Different body content entirely here", tags: [] };
    expect(similarityScore(sameTitle, draft)).toBeGreaterThan(similarityScore(sameBody, draft));
  });

  it("stays within 0..1", () => {
    const a = { title: "a".repeat(500), body: "b".repeat(2000), tags: Array(20).fill("x") };
    const b = { title: "a".repeat(500), body: "b".repeat(2000), tags: Array(20).fill("x") };
    const score = similarityScore(a, b);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("only considers the first 400 chars of the body", () => {
    const sharedOpening = "shared opening words repeated here today about the matter ";
    const a = { title: "Same title words", body: sharedOpening.repeat(10), tags: [] };
    const b = {
      title: "Same title words",
      body: sharedOpening.repeat(10) + " completely unrelated trailing content that never matches anything",
      tags: [],
    };
    // both bodies are identical in their first 400 chars, so the extra tail on b must not change the score
    expect(similarityScore(a, b)).toBe(similarityScore(a, { ...a, body: a.body }));
  });

  it("exports the documented thresholds", () => {
    expect(DUPLICATE_THRESHOLD).toBe(0.55);
    expect(SIMILAR_THRESHOLD).toBe(0.35);
  });

  it("scores identical title + different body at or above DUPLICATE_THRESHOLD", () => {
    const a = {
      title: "Use runTest.sh instead of dotnet test",
      body: "It wires up loggers and starts dependency containers for integration tests.",
      tags: ["engineering", "ci"],
    };
    const b = {
      title: "Use runTest.sh instead of dotnet test",
      body: "Totally different explanation about why CI pipelines fail on Windows agents sometimes.",
      tags: ["engineering", "ci"],
    };
    expect(similarityScore(a, b)).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it("scores same body + different title below DUPLICATE_THRESHOLD", () => {
    const body = "It wires up loggers and starts dependency containers for integration tests.";
    const a = { title: "Use runTest.sh instead of dotnet test", body, tags: ["engineering"] };
    const b = { title: "Kafka consumer offset reset guidance", body, tags: ["engineering"] };
    expect(similarityScore(a, b)).toBeLessThan(DUPLICATE_THRESHOLD);
  });
});
