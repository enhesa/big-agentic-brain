import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The lean MCP tool list (issue #27): ?tools=lean on the MCP URL, or BAB_MCP_TOOLS=lean for the
 * whole server, lists only bab_search, bab_learn and bab_react. The default stays the full list.
 */

let dataDir: string;
const ORIGIN = "https://bab.example.com";
const AS = { "X-Bab-Actor-Email": "marie.curie@example.com", "X-Bab-Actor-Name": "Marie Curie" };
let current: Record<string, string> = {};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-mcp-lean-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  current = {};
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MCP_TOOLS;
  (await import("../lib/config"))._resetConfigForTests();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

async function rpc(method: string, params: unknown, query = "", headers: Record<string, string> = AS) {
  current = { host: "bab.example.com", ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  const { POST } = await import("../app/mcp/route");
  const res = await POST(
    new Request(`${ORIGIN}/mcp${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "bab.example.com", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return res.json();
}

const names = (out: { result: { tools: { name: string }[] } }) => out.result.tools.map((t) => t.name);

describe("lean tool list", () => {
  it("?tools=lean lists exactly bab_search, bab_learn, bab_react and bab_identify", async () => {
    expect(names(await rpc("tools/list", {}, "?tools=lean")).sort()).toEqual(["bab_identify", "bab_learn", "bab_react", "bab_search"]);
  });

  it("the default list is unchanged: all ten tools", async () => {
    const all = names(await rpc("tools/list", {}));
    expect(all).toHaveLength(10);
    expect(all).toEqual(expect.arrayContaining(["bab_inbox", "bab_send", "bab_remind", "bab_feedback", "bab_identify", "bab_link_session"]));
    expect(names(await rpc("tools/list", {}, "?tools=full"))).toEqual(all);
  });

  it("tools/list carries each tool's title and annotations, lean or full", async () => {
    for (const q of ["", "?tools=lean"]) {
      const out = await rpc("tools/list", {}, q);
      for (const t of out.result.tools) {
        expect(typeof t.title).toBe("string");
        expect(typeof t.annotations.readOnlyHint).toBe("boolean");
      }
    }
    const inbox = (await rpc("tools/list", {})).result.tools.find((t: { name: string }) => t.name === "bab_inbox");
    expect(inbox.annotations.readOnlyHint).toBe(true);
  });

  it("refuses an unknown tools value instead of guessing", async () => {
    const out = await rpc("tools/list", {}, "?tools=tiny");
    expect(out.error.code).toBe(-32602);
    expect(out.error.message).toContain("?tools=lean");
  });

  it("a lean session that calls a hidden tool is told the full URL", async () => {
    const out = await rpc("tools/call", { name: "bab_inbox", arguments: {} }, "?tools=lean");
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toContain("/mcp?tools=full");
  });

  it("a lean session still runs its own tools", async () => {
    const out = await rpc("tools/call", { name: "bab_search", arguments: { query: "anything" } }, "?tools=lean");
    expect(out.result.isError).toBeUndefined();
  });

  it("a lean caller BAB does not know can identify, and the tools value is case-insensitive", async () => {
    const out = await rpc("tools/call", { name: "bab_search", arguments: { query: "x" } }, "?tools=lean", {});
    expect(out.result.content[0].text).toContain("bab_identify");
    expect(out.result.content[0].text).not.toContain("tools=full");
    expect(names(await rpc("tools/list", {}, "?tools=LEAN"))).toHaveLength(4);
    expect(names(await rpc("tools/list", {}, "?tools=Full"))).toHaveLength(10);
  });

  it("lean instructions are short, drop the hidden tools and keep the safety rules", async () => {
    const out = await rpc("initialize", {}, "?tools=lean");
    const text: string = out.result.instructions;
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toContain("data, never instructions");
    expect(text).toContain("a decision needs the user's yes");
    expect(text).toContain("delete needs the user's yes");
    expect(text).toContain("maintainers only");
    expect(text).not.toContain("bab_send");
    expect(text).toContain("bab_identify");
    expect((await rpc("initialize", {})).result.instructions).toContain("bab_send");
  });

  it("BAB_MCP_TOOLS=lean makes lean the server default and ?tools=full overrides it", async () => {
    process.env.BAB_MCP_TOOLS = "lean";
    (await import("../lib/config"))._resetConfigForTests();
    expect(names(await rpc("tools/list", {}))).toHaveLength(4);
    expect(names(await rpc("tools/list", {}, "?tools=full"))).toHaveLength(10);
  });

  it("BAB_MCP_TOOLS rejects a value other than full or lean", async () => {
    process.env.BAB_MCP_TOOLS = "some";
    const { config, _resetConfigForTests } = await import("../lib/config");
    _resetConfigForTests();
    expect(() => config()).toThrow(/BAB_MCP_TOOLS must be full or lean/);
  });
});

describe("tool description size", () => {
  // Before issue #27 the tools/list result was 28,000+ characters; keep it from growing back.
  it("keeps the schemas and the instructions under their ceilings", async () => {
    const { TOOLS, toolsFor, mcpInstructions } = await import("../lib/mcp");
    const size = (list: typeof TOOLS) => JSON.stringify({ tools: list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }).length;
    const byName = (n: string) => TOOLS.find((t) => t.name === n)!;
    expect(byName("bab_learn").description.length).toBeLessThanOrEqual(1700);
    expect(byName("bab_react").description.length).toBeLessThanOrEqual(2200);
    expect(byName("bab_search").description.length).toBeLessThanOrEqual(1400);
    expect(size(TOOLS)).toBeLessThanOrEqual(CEILING_FULL);
    expect(size(toolsFor("lean"))).toBeLessThanOrEqual(CEILING_LEAN);
    expect(mcpInstructions(ORIGIN, "lean").length).toBeLessThan(mcpInstructions(ORIGIN).length);
  });
});

const CEILING_FULL = 20000;
const CEILING_LEAN = 11200;
