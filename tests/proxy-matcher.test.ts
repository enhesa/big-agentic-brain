import { describe, it, expect } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "../proxy";

// Next's own matcher logic, not a copy of the pattern: POST /api/files must stay outside the proxy
// (so Next never buffers an upload) and every other API path inside it.
describe("proxy matcher", () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it("skips /api/files and upload links, and nothing else under /api", () => {
    expect(matches("/api/files")).toBe(false);
    expect(matches("/api/files/up/abc")).toBe(false);
    for (const p of ["/api", "/api/files/abc", "/api/files/abc/content", "/api/files/dl/x", "/api/files/upload", "/api/files/upx", "/api/learnings", "/api/filesx", "/api/kv", "/mcp"]) {
      expect(matches(p), p).toBe(true);
    }
  });
});
