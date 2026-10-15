import { describe, it, expect } from "vitest";
import {
  APPLIES_TO_LABELS,
  STACK_LABELS,
  PLATFORM_LABELS,
  canonicalLabel,
  parseAppliesTo,
  parseAppliesToFilter,
  parseStack,
  appliesToFields,
  mergeAppliesTo,
  matchesStack,
  readAppliesTo,
  stackRankSql,
  appliesToFilterSql,
} from "../lib/applies-to";

/** The vocabulary and its parsers (lib/applies-to.ts): pure, no database. */

describe("vocabulary", () => {
  it("has the agreed stack and platform labels", () => {
    expect([...STACK_LABELS]).toEqual([
      "dotnet", "node", "typescript", "python", "angular", "react", "java", "go", "sql", "postgres",
      "sqlite", "elasticsearch", "kafka", "docker", "helm", "terraform",
    ]);
    expect([...PLATFORM_LABELS]).toEqual(["aks", "forge", "azure", "aws", "windows", "linux", "macos"]);
    expect(APPLIES_TO_LABELS).toHaveLength(23);
  });
});

describe("alias normalisation", () => {
  it.each([
    ["c#", "dotnet"], ["C#", "dotnet"], ["csharp", "dotnet"], [".NET", "dotnet"], ["  dotnet ", "dotnet"],
    ["nodejs", "node"], ["Node.js", "node"], ["js", "node"], ["ts", "typescript"],
    ["k8s", "aks"], ["Kubernetes", "aks"], ["PostgreSQL", "postgres"], ["golang", "go"],
    ["Mac OS", "macos"], ["elastic", "elasticsearch"], ["aks", "aks"],
  ])("%s -> %s", (raw, label) => {
    expect(canonicalLabel(raw)).toBe(label);
  });

  it("returns null for what it does not know", () => {
    expect(canonicalLabel("rust")).toBeNull();
    expect(canonicalLabel("")).toBeNull();
  });
});

describe("parseAppliesTo (writes)", () => {
  it("absent is undefined, null and an empty list are everywhere", () => {
    expect(parseAppliesTo(undefined)).toBeUndefined();
    expect(parseAppliesTo(null)).toEqual([]);
    expect(parseAppliesTo([])).toEqual([]);
    expect(parseAppliesTo("  ")).toEqual([]);
  });

  it("normalises aliases, de-duplicates and keeps order; accepts a comma string", () => {
    expect(parseAppliesTo(["C#", "dotnet", "k8s"])).toEqual(["dotnet", "aks"]);
    expect(parseAppliesTo("nodejs, ts")).toEqual(["node", "typescript"]);
  });

  it("refuses an unknown label, listing the valid ones and pointing at bab_feedback", () => {
    let message = "";
    try {
      parseAppliesTo(["dotnet", "rust"]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('"rust"');
    for (const label of APPLIES_TO_LABELS) expect(message).toContain(label);
    expect(message).toContain("bab_feedback");
  });

  it("refuses non-text items and non-lists", () => {
    expect(() => parseAppliesTo([1])).toThrow(/appliesTo/);
    expect(() => parseAppliesTo({})).toThrow(/appliesTo/);
  });

  it('refuses "everywhere" as a label: that is an empty list', () => {
    expect(() => parseAppliesTo(["everywhere"])).toThrow(/Unknown/);
  });
});

describe("parseAppliesToFilter", () => {
  it("is strict, accepts everywhere, and treats blank as no filter", () => {
    expect(parseAppliesToFilter(undefined)).toBeUndefined();
    expect(parseAppliesToFilter("")).toBeUndefined();
    expect(parseAppliesToFilter("c#,everywhere")).toEqual(["dotnet", "everywhere"]);
    expect(() => parseAppliesToFilter("rust")).toThrow(/Unknown/);
  });
});

describe("parseStack (lenient)", () => {
  it("normalises aliases and drops values it does not know", () => {
    expect(parseStack(["c#", "rust", "k8s"])).toEqual(["dotnet", "aks"]);
    expect(parseStack("python,rust")).toEqual(["python"]);
  });
  it("is undefined when nothing usable was given", () => {
    expect(parseStack(undefined)).toBeUndefined();
    expect(parseStack(["rust"])).toBeUndefined();
    expect(parseStack({})).toBeUndefined();
  });
});

describe("matching and the mismatch flag", () => {
  it("everywhere or a shared label matches", () => {
    expect(matchesStack([], ["python"])).toBe(true);
    expect(matchesStack(["dotnet", "aks"], ["aks"])).toBe(true);
    expect(matchesStack(["dotnet"], ["python"])).toBe(false);
  });

  it("flags a mismatch with the hint, and nothing without a stack", () => {
    const row = { applies_to: '["dotnet"]' };
    expect(appliesToFields(row, ["python"])).toEqual({
      appliesTo: ["dotnet"],
      stackMismatch: true,
      stackHint: "for dotnet, not your stack: weigh, don't follow",
    });
    expect(appliesToFields(row, ["dotnet"])).toEqual({ appliesTo: ["dotnet"] });
    expect(appliesToFields(row)).toEqual({ appliesTo: ["dotnet"] });
    expect(appliesToFields({ applies_to: "[]" }, ["python"])).toEqual({ appliesTo: [] });
    expect(appliesToFields({ applies_to: '["dotnet","aks"]' }, ["python"]).stackHint).toBe(
      "for dotnet, aks, not your stack: weigh, don't follow",
    );
  });

  it("reads a stored value defensively", () => {
    expect(readAppliesTo(null)).toEqual([]);
    expect(readAppliesTo("not json")).toEqual([]);
    expect(readAppliesTo('{"a":1}')).toEqual([]);
    expect(readAppliesTo('["dotnet",3]')).toEqual(["dotnet"]);
  });
});

describe("mergeAppliesTo", () => {
  it("is the union, and everywhere when any one of them is everywhere", () => {
    expect(mergeAppliesTo([["dotnet"], ["node", "dotnet"]])).toEqual(["dotnet", "node"]);
    expect(mergeAppliesTo([["dotnet"], []])).toEqual([]);
    expect(mergeAppliesTo([])).toEqual([]);
  });
});

describe("SQL fragments", () => {
  it("only ever inlines vocabulary labels", () => {
    expect(stackRankSql(undefined)).toBe("");
    expect(stackRankSql([])).toBe("");
    expect(stackRankSql(["dotnet"], "learnings.")).toContain(`learnings.applies_to LIKE '%"dotnet"%'`);
    expect(appliesToFilterSql(["everywhere", "aks"])).toBe(`(applies_to = '[]' OR applies_to LIKE '%"aks"%')`);
    expect(() => stackRankSql(["x' OR 1=1 --"])).toThrow();
    expect(() => appliesToFilterSql(["x' OR 1=1 --"])).toThrow();
  });
});
