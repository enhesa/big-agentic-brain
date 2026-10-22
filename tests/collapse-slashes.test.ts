import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const { collapseSlashes } = createRequire(import.meta.url)("../collapse-slashes.cjs") as {
  collapseSlashes: (u: string) => string;
};

describe("collapseSlashes", () => {
  it("collapses runs of slashes in the path", () => {
    expect(collapseSlashes("//api/hook")).toBe("/api/hook");
    expect(collapseSlashes("///api//hook")).toBe("/api/hook");
    expect(collapseSlashes("//mcp")).toBe("/mcp");
  });
  it("leaves clean paths, the query and the fragment alone", () => {
    expect(collapseSlashes("/api/hook")).toBe("/api/hook");
    expect(collapseSlashes("/")).toBe("/");
    expect(collapseSlashes("//api/x?next=//a//b")).toBe("/api/x?next=//a//b");
  });
  it("never produces a protocol-relative target", () => {
    expect(collapseSlashes("//evil.example.com")).toBe("/evil.example.com");
    expect(collapseSlashes("//evil.example.com//")).toBe("/evil.example.com/");
  });
  it("ignores targets that are not origin-form", () => {
    expect(collapseSlashes("*")).toBe("*");
    expect(collapseSlashes("http://h//x")).toBe("http://h//x");
  });
});

describe("gate sees the collapsed path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("//api/hook is public and //api/learnings is gated, as without the slash", async () => {
    vi.resetModules();
    vi.stubEnv("BAB_API_TOKENS", "secret-one");
    const { gate } = await import("../lib/gate");
    const r = (p: string) => new Request("http://bab.test" + p, { method: "POST" });
    expect(gate(r("//api/hook"))).toBeNull();
    expect(gate(r("//api/learnings"))?.status).toBe(401);
    expect(gate(r("//mcp"))?.status).toBe(401);
  });
});
