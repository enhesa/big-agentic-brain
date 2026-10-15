import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * A Claude Code mod polls bab_inbox (the list, no threadId) every 15 seconds per open session, which
 * would be thousands of audit rows a day per person that say nothing. An inbox LIST call (the MCP
 * tool and GET /api/inbox) is audited at most once per identity per 5 minutes. Opening a thread and
 * every write stay audited every time.
 */

let dataDir: string;
const ME = "alice.example@example.com";
const OTHER = "marie.curie@example.com";
let current: Record<string, string> = {};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-audit-poll-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  current = { "x-bab-actor-email": ME, "x-bab-actor-name": "Alice Example" };
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(current) }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

async function mcpCall(name: string, args: Record<string, unknown> = {}) {
  const { POST } = await import("../app/mcp/route");
  const res = await POST(
    new Request("https://bab.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", host: "bab.example.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  return res.json();
}

async function restList() {
  const { GET } = await import("../app/api/inbox/route");
  return GET();
}

async function rows(pathLike: string, actor = ME) {
  const { getDb } = await import("../lib/db");
  return getDb()
    .prepare("SELECT at, details FROM audit_log WHERE actor_id = ? AND entity = 'request' AND path LIKE ?")
    .all(actor, pathLike) as { at: string; details: string | null }[];
}

/** Moves every audit row of this path N minutes into the past, as if that long had gone by. */
async function age(pathLike: string, minutes: number) {
  const { getDb } = await import("../lib/db");
  getDb().prepare("UPDATE audit_log SET at = datetime(at, ?) WHERE path LIKE ?").run(`-${minutes} minutes`, pathLike);
}

describe("bab_inbox list calls (MCP)", () => {
  it("audits the first, then not again within 5 minutes", async () => {
    for (let i = 0; i < 20; i++) expect((await mcpCall("bab_inbox")).result.isError).toBeFalsy();
    expect(await rows("%tools/call:bab_inbox%")).toHaveLength(1);
  });

  it("audits again once 5 minutes have passed, and then holds for another 5", async () => {
    await mcpCall("bab_inbox");
    await age("%tools/call:bab_inbox%", 6);
    await mcpCall("bab_inbox");
    await mcpCall("bab_inbox");
    expect(await rows("%tools/call:bab_inbox%")).toHaveLength(2);
  });

  it("is still audited just inside the window's far edge only once: 4 minutes ago suppresses", async () => {
    await mcpCall("bab_inbox");
    await age("%tools/call:bab_inbox%", 4);
    await mcpCall("bab_inbox");
    expect(await rows("%tools/call:bab_inbox%")).toHaveLength(1);
  });

  it("is per identity: someone else's list call is audited for them", async () => {
    await mcpCall("bab_inbox");
    current = { "x-bab-actor-email": OTHER, "x-bab-actor-name": "Marie Curie" };
    await mcpCall("bab_inbox");
    expect(await rows("%tools/call:bab_inbox%", ME)).toHaveLength(1);
    expect(await rows("%tools/call:bab_inbox%", OTHER)).toHaveLength(1);
  });

  it("opening a thread is audited every time, even straight after a list", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: OTHER, email: OTHER, name: "Marie Curie", roles: [] });
    upsertUser({ id: ME, email: ME, name: "Alice Example", roles: [] });
    const { send } = await import("../lib/messages");
    const { thread } = send({ fromId: OTHER, to: ME, subject: "Hi", body: "Hello" }, "mcp");
    await mcpCall("bab_inbox");
    await mcpCall("bab_inbox", { threadId: thread.id });
    await mcpCall("bab_inbox", { threadId: thread.id });
    await mcpCall("bab_inbox", { threadId: thread.id });
    // 1 list + 3 opens. The list row is flagged so an open never suppresses a later list, or the reverse.
    expect(await rows("%tools/call:bab_inbox%")).toHaveLength(4);
  });

  it("an open does not count as the list: a list after an open is still audited", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: OTHER, email: OTHER, name: "Marie Curie", roles: [] });
    upsertUser({ id: ME, email: ME, name: "Alice Example", roles: [] });
    const { send } = await import("../lib/messages");
    const { thread } = send({ fromId: OTHER, to: ME, subject: "Hi", body: "Hello" }, "mcp");
    await mcpCall("bab_inbox", { threadId: thread.id });
    await mcpCall("bab_inbox");
    expect(await rows("%tools/call:bab_inbox%")).toHaveLength(2);
  });

  it("includeRead and limit still count as a list; a blank threadId is a list", async () => {
    await mcpCall("bab_inbox", { includeRead: true, limit: 5 });
    await mcpCall("bab_inbox", { threadId: "   " });
    await mcpCall("bab_inbox", { threadId: "" });
    expect(await rows("%tools/call:bab_inbox%")).toHaveLength(1);
  });

  it("every other tool, writes first among them, is audited every time", async () => {
    for (let i = 0; i < 3; i++) await mcpCall("bab_search", { query: `kafka ${i}` });
    for (let i = 0; i < 3; i++) await mcpCall("bab_remind", { action: "create", title: `R${i}`, dueAt: "2030-01-01" });
    expect(await rows("%tools/call:bab_search%")).toHaveLength(3);
    expect(await rows("%tools/call:bab_remind%")).toHaveLength(3);
  });

  it("the suppressed call is still served normally", async () => {
    await mcpCall("bab_inbox");
    const out = await mcpCall("bab_inbox");
    expect(JSON.parse(out.result.content[0].text)).toMatchObject({ threads: [] });
  });

  it("an unidentified caller's tool calls are still audited (they are not inbox polls)", async () => {
    current = {};
    await mcpCall("bab_inbox");
    await mcpCall("bab_inbox");
    expect(await rows("%tools/call:bab_inbox%", "anonymous")).toHaveLength(2);
  });

  it("the audited row says it is a coalesced list poll, next to the identity source", async () => {
    await mcpCall("bab_inbox");
    const [row] = await rows("%tools/call:bab_inbox%");
    expect(JSON.parse(row.details!)).toEqual({ source: "declared", coalesce: 1 });
  });
});

describe("GET /api/inbox (the list)", () => {
  it("is audited once per 5 minutes per identity", async () => {
    for (let i = 0; i < 10; i++) expect((await restList()).status).toBe(200);
    expect(await rows("/api/inbox")).toHaveLength(1);
    await age("/api/inbox", 6);
    await restList();
    expect(await rows("/api/inbox")).toHaveLength(2);
  });

  it("opening a thread over REST is audited every time", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: OTHER, email: OTHER, name: "Marie Curie", roles: [] });
    upsertUser({ id: ME, email: ME, name: "Alice Example", roles: [] });
    const { send } = await import("../lib/messages");
    const { thread } = send({ fromId: OTHER, to: ME, subject: "Hi", body: "Hello" }, "mcp");
    const { GET } = await import("../app/api/inbox/[threadId]/route");
    for (let i = 0; i < 3; i++) {
      await GET(new Request(`http://x/api/inbox/${thread.id}`) as never, { params: Promise.resolve({ threadId: thread.id }) });
    }
    expect(await rows("/api/inbox/%")).toHaveLength(3);
  });

  it("the REST list and the MCP list are separate paths, each coalesced on its own", async () => {
    await restList();
    await mcpCall("bab_inbox");
    await restList();
    await mcpCall("bab_inbox");
    expect(await rows("/api/inbox")).toHaveLength(1);
    expect(await rows("%tools/call:bab_inbox%")).toHaveLength(1);
  });
});

describe("auditRequest coalesce option", () => {
  it("skips only when the same identity, path and coalesce flag were audited inside the window", async () => {
    const { auditRequest } = await import("../lib/request-audit");
    const actor = { id: ME, name: "Alice", email: ME };
    const input = { actor, method: "POST", path: "/x", via: "mcp" as const, coalesce: { minutes: 5 } };
    await auditRequest(input);
    await auditRequest(input);
    // The same path without the option is a different kind of row and is always written.
    await auditRequest({ actor, method: "POST", path: "/x", via: "mcp" });
    await auditRequest({ actor, method: "POST", path: "/x", via: "mcp" });
    expect(await rows("/x")).toHaveLength(3);
  });

  it("never coalesces an anonymous caller", async () => {
    const { auditRequest } = await import("../lib/request-audit");
    for (let i = 0; i < 3; i++) await auditRequest({ actor: null, method: "GET", path: "/y", via: "ui", coalesce: { minutes: 5 } });
    expect(await rows("/y", "anonymous")).toHaveLength(3);
  });
});
