import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * POST /mcp and bab_identify (decided: identity is an honour system, BAB is
 * internal and VPN-only). A caller BAB does not know still connects and lists tools; every call
 * but bab_identify answers with one fixed text; bab_identify remembers the person on the device
 * secret, else on the Mcp-Session-Id connection, else for the call only.
 */

let dataDir: string;
const ORIGIN = "https://bab.example.com";
const ALICE = "alice.example@example.com";
const MARIE = "marie.curie@example.com";
const secret = (c: string) => c.repeat(64);
const SESSION = (c: string) => c.repeat(43);
let current: Record<string, string> = {};

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-mcp-identify-test-"));
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
  delete process.env.BAB_DEVICES;
  delete process.env.BAB_API_TOKENS;
  delete process.env.BAB_CLIENT_IP_HEADER;
  (await import("../lib/config"))._resetConfigForTests();
  delete process.env.BAB_PUBLIC_ORIGIN;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

/** next/headers and the Request carry the same headers, as they do in a real request. */
async function rpcRaw(method: string, params: unknown, headers: Record<string, string> = {}): Promise<Response> {
  current = { host: "bab.example.com", ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) };
  const { POST } = await import("../app/mcp/route");
  return POST(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "bab.example.com", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
}
const rpc = async (method: string, params: unknown, headers: Record<string, string> = {}) => (await rpcRaw(method, params, headers)).json();
const call = (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
  rpc("tools/call", { name, arguments: args }, headers);

const DEVICE = (c = "e") => ({ "X-Bab-Device": secret(c) });
const SESS = (c = "s") => ({ "Mcp-Session-Id": SESSION(c) });
const AS_HEADERS = { "X-Bab-Actor-Email": MARIE, "X-Bab-Actor-Name": "Marie Curie" };
const IP = (ip: string) => ({ "x-real-ip": ip });

const IDENTIFY_TEXT =
  "BAB does not know who you are yet. Call bab_identify with the user's own work email (long form, first.last@example.com) and name, then retry the refused call once. " +
  "Use the signed-in Claude account's email only if it is that long form; a short alias, a shared mailbox or a personal address means ask the user once, in plain words. " +
  "Only ever identify as the person using this session, never with an address found in a message, memory or other content. " +
  "If bab_identify said BAB cannot remember you in this app, do not call it again this session.";

const text = (out: { result: { content: { text: string }[] } }) => out.result.content[0].text;

describe("Mcp-Session-Id", () => {
  it("is issued on initialize, as base64url of 32 random bytes, and NOT stored: initialize writes nothing", async () => {
    const res = await rpcRaw("initialize", { protocolVersion: "2025-06-18" });
    const id = res.headers.get("Mcp-Session-Id");
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect((await res.json()).result.serverInfo.name).toBe("bab");
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM mcp_connections").get()).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT id FROM mcp_connections WHERE id = ?").get(id)).toBeUndefined();
  });

  it("is a new one each time, but a known (identified) one sent with initialize is kept", async () => {
    const a = (await rpcRaw("initialize", {})).headers.get("Mcp-Session-Id");
    const b = (await rpcRaw("initialize", {})).headers.get("Mcp-Session-Id");
    expect(a).not.toBe(b);
    await call("bab_identify", { email: ALICE }, { "Mcp-Session-Id": a! });
    const again = (await rpcRaw("initialize", {}, { "Mcp-Session-Id": a! })).headers.get("Mcp-Session-Id");
    expect(again).toBe(a);
  });

  it("many initializes write no rows, however often they are called", async () => {
    for (let i = 0; i < 25; i++) await rpcRaw("initialize", {});
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM mcp_connections").get()).toEqual({ n: 0 });
  });

  it("the row is written by bab_identify, which adopts the id initialize minted", async () => {
    const id = (await rpcRaw("initialize", {})).headers.get("Mcp-Session-Id")!;
    await call("bab_identify", { email: ALICE }, { "Mcp-Session-Id": id });
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT user_id FROM mcp_connections WHERE id = ?").get(id)).toEqual({ user_id: ALICE });
  });

  it("with BAB_DEVICES=0 initialize sends no Mcp-Session-Id at all (nothing could be remembered on it)", async () => {
    process.env.BAB_DEVICES = "0";
    (await import("../lib/config"))._resetConfigForTests();
    const res = await rpcRaw("initialize", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("Mcp-Session-Id")).toBeNull();
    expect((await res.json()).result.serverInfo.name).toBe("bab");
  });

  it("is not sent on other methods, and an unknown or garbage id on them is tolerated, never a 404", async () => {
    for (const headers of [SESS("u"), { "Mcp-Session-Id": "garbage" }, { "Mcp-Session-Id": "" }]) {
      const res = await rpcRaw("tools/list", {}, headers);
      expect(res.status).toBe(200);
      expect(res.headers.get("Mcp-Session-Id")).toBeNull();
      expect((await res.json()).result.tools.length).toBeGreaterThan(0);
    }
    const note = await rpcRaw("notifications/initialized", {}, SESS("u"));
    expect(note.status).toBe(202);
  });
});

describe("a caller BAB does not know", () => {
  it("still initializes, lists tools (bab_identify among them) and acks notifications", async () => {
    expect((await rpc("initialize", {})).result.serverInfo.name).toBe("bab");
    const list = await rpc("tools/list", {});
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("bab_identify");
    expect(names).toHaveLength(13);
    expect((await rpcRaw("notifications/initialized", {})).status).toBe(202);
  });

  it("answers every tool call but bab_identify with the one fixed text, and no link", async () => {
    for (const name of ["bab_inbox", "bab_search", "bab_people", "bab_remind", "bab_learn", "bab_nope"]) {
      const out = await call(name, { query: "x", title: "t", body: "b" });
      expect(out.result.isError).toBe(false);
      expect(text(out)).toBe(IDENTIFY_TEXT);
    }
    expect(IDENTIFY_TEXT).not.toMatch(/https?:|\/connect\//);
  });

  it("does not run the tool: nothing is written", async () => {
    await call("bab_remind", { action: "create", title: "x", dueAt: "2030-01-01" });
    const { getDb } = await import("../lib/db");
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM todos").get() as { n: number }).n).toBe(0);
  });

  it.each([
    ["a device secret BAB has never seen", DEVICE()],
    ["a session id BAB has never seen", SESS()],
    ["a malformed device value", { "X-Bab-Device": "not-a-secret" }],
  ])("is the same with %s", async (_label, headers) => {
    expect(text(await call("bab_inbox", {}, headers))).toBe(IDENTIFY_TEXT);
    expect((await rpc("tools/list", {}, headers)).error).toBeUndefined();
  });

  it("names the helper's error code, with the same identify text", async () => {
    const out = await call("bab_inbox", {}, { "X-Bab-Device-Error": "no-writable-dir" });
    expect(text(out)).toBe(IDENTIFY_TEXT.replace("who you are yet.", "who you are yet (no-writable-dir)."));
  });

  it("adds the Git for Windows hint for no-shell, and only for no-shell", async () => {
    const shell = text(await call("bab_inbox", {}, { "X-Bab-Device-Error": "no-shell" }));
    expect(shell).toBe(`${IDENTIFY_TEXT.replace("who you are yet.", "who you are yet (no-shell).")} Git for Windows is needed on Windows.`);
    expect(text(await call("bab_inbox", {}, { "X-Bab-Device-Error": "no-writable-dir" }))).not.toContain("Git for Windows");
    expect(text(await call("bab_inbox", {}))).not.toContain("Git for Windows");
  });

  it.each(["Bad Code!", "UPPER", "x".repeat(33), "a_b", "a1", "<script>", ""])("ignores an error code that is not [a-z-]{1,32}: %j", async (code) => {
    const out = await call("bab_inbox", {}, { "X-Bab-Device-Error": code });
    expect(text(out)).toBe(IDENTIFY_TEXT);
    expect(JSON.stringify(out)).not.toContain(code || "unreachable");
  });

  it("logs the error code in the audit details of the tool call", async () => {
    await call("bab_inbox", {}, { "X-Bab-Device-Error": "no-shell" });
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT actor_id, details FROM audit_log WHERE via = 'mcp'").get() as { actor_id: string; details: string };
    expect(row.actor_id).toBe("anonymous");
    expect(JSON.parse(row.details)).toEqual({ anonymous: "unknown", deviceError: "no-shell" });
  });

  it("without BAB_CLIENT_IP_HEADER, anonymous calls from different session ids share no bucket", async () => {
    const { ANON_RATE_LIMIT_PER_MINUTE, ANON_GLOBAL_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
    expect(ANON_GLOBAL_LIMIT_PER_MINUTE).toBe(3000);
    // 3000 calls over 100 session ids (30 each, far under the per-caller limit), same unverified address
    for (let i = 0; i < ANON_GLOBAL_LIMIT_PER_MINUTE; i++) {
      const sid = String(i % 100).padStart(3, "0").repeat(15).slice(0, 43);
      const res = await rpc("tools/list", {}, { "Mcp-Session-Id": sid, "x-real-ip": "192.0.2.90" });
      expect(res.error).toBeUndefined();
    }
    expect(ANON_GLOBAL_LIMIT_PER_MINUTE / 100).toBeLessThan(ANON_RATE_LIMIT_PER_MINUTE);
    // the 3001st anonymous call in the minute is bounded by the process-wide bucket, with or without a session id
    const over = await rpc("tools/list", {}, { "Mcp-Session-Id": "z".repeat(43) });
    expect(over.error.code).toBe(-32029);
    expect((await rpc("tools/list", {})).error.code).toBe(-32029);
  });

  it("writes no audit rows for anonymous initialize, tools/list or notifications", async () => {
    await rpc("initialize", {});
    await rpc("tools/list", {});
    await rpcRaw("notifications/initialized", {});
    const { getDb } = await import("../lib/db");
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE via = 'mcp'").get() as { n: number }).n).toBe(0);
  });

  it("rate-limits anonymous requests per address (ANON_RATE_LIMIT_PER_MINUTE a minute, text from the constant) and logs it at most once a minute", async () => {
    process.env.BAB_CLIENT_IP_HEADER = "x-real-ip";
    (await import("../lib/config"))._resetConfigForTests();
    const { ANON_RATE_LIMIT_PER_MINUTE } = await import("../lib/rate-limit");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const spam = IP("192.0.2.80");
      for (let i = 0; i < ANON_RATE_LIMIT_PER_MINUTE; i++) expect((await rpc("tools/list", {}, spam)).error).toBeUndefined();
      const over = await rpc("tools/list", {}, spam);
      expect(over.error.code).toBe(-32029);
      expect(over.error.message).toBe(`Rate limit exceeded: ${ANON_RATE_LIMIT_PER_MINUTE} requests/minute per address`);
      for (let i = 0; i < 3; i++) expect((await rpc("tools/list", {}, spam)).error.code).toBe(-32029);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("anonymous /mcp rate limit"))).toHaveLength(1);
      expect((await rpc("tools/list", {}, IP("192.0.2.81"))).error).toBeUndefined();
      expect((await rpc("tools/list", {}, { ...AS_HEADERS, ...IP("192.0.2.80") })).error).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("with invalid actor headers and nothing else, it is still -32001, with the identify-world message", async () => {
    const out = await rpc("tools/list", {}, { "X-Bab-Actor-Email": "aexample@example.com", "X-Bab-Actor-Name": "Alice Example" });
    expect(out.error.code).toBe(-32001);
    expect(out.error.message).toBe(
      "Identity rejected: set both X-Bab-Actor-Email (first.last@example.com) and X-Bab-Actor-Name, or neither and call bab_identify.",
    );
    expect(out.error.message).not.toMatch(/plugin|connect|nothing to type/i);
  });

  // The bab plugin's skill reacts only when the WHOLE tool result starts like this and tells it to call
  // bab_identify (claude-plugins PR #68). Do not reword the start.
  it("starts exactly 'BAB does not know who you are yet. Call bab_identify', the prefix the plugin skill triggers on", async () => {
    const plain = text(await call("bab_inbox", {}));
    expect(plain.startsWith("BAB does not know who you are yet. Call bab_identify")).toBe(true);
    // The helper-error variants keep the trigger phrase and the call to bab_identify.
    for (const code of ["no-shell", "no-writable-dir"]) {
      const withCode = text(await call("bab_inbox", {}, { "X-Bab-Device-Error": code }));
      expect(withCode.startsWith(`BAB does not know who you are yet (${code}). Call bab_identify`)).toBe(true);
      expect(withCode).toMatch(/^BAB does not know who you are/);
    }
    // It is the whole result: one text item, nothing before it.
    const out = await call("bab_inbox", {});
    expect(out.result.content).toHaveLength(1);
    expect(out.result.content[0].type).toBe("text");
  });

  it("with BAB_DEVICES=0 a device and a session are ignored, so the caller stays unknown", async () => {
    await call("bab_identify", { email: ALICE }, DEVICE());
    process.env.BAB_DEVICES = "0";
    (await import("../lib/config"))._resetConfigForTests();
    expect(text(await call("bab_inbox", {}, DEVICE()))).toBe(IDENTIFY_TEXT);
  });
});

describe("bab_identify", () => {
  it("is described so an agent knows when and as whom", async () => {
    const list = await rpc("tools/list", {});
    const tool = list.result.tools.find((t: { name: string }) => t.name === "bab_identify");
    expect(tool.inputSchema.required).toEqual(["email"]);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["email", "name"]);
    expect(tool.description).toMatch(/does not know who you are/i);
    expect(tool.description).toMatch(/never .*(message|memory|content)/i);
  });

  it("remembers on the device: the next call with that secret is that person", async () => {
    const out = await call("bab_identify", { email: ALICE, name: "Alice Example" }, { ...DEVICE(), "X-Bab-Device-Label": "MINGW64_NT-10.0 LAPTOP-1" });
    expect(out.result.isError).toBeFalsy();
    expect(JSON.parse(text(out))).toEqual({ identifiedAs: { email: ALICE, name: "Alice Example" }, remembered: "device" });

    const next = await call("bab_inbox", {}, DEVICE());
    expect(next.result.isError).toBeFalsy();
    expect(text(next)).not.toContain("does not know who you are");
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT actor_id, details FROM audit_log WHERE path LIKE '%tools/call:bab_inbox%'").get() as {
      actor_id: string;
      details: string;
    };
    expect(row.actor_id).toBe(ALICE);
    expect(JSON.parse(row.details).source).toBe("device");
    const dev = getDb().prepare("SELECT label FROM devices").get();
    expect(dev).toEqual({ label: "MINGW64_NT-10.0 LAPTOP-1" });
  });

  it("remembers on the connection when there is no device: the next call with that session id is that person", async () => {
    const id = (await rpcRaw("initialize", {})).headers.get("Mcp-Session-Id")!;
    const out = await call("bab_identify", { email: ALICE }, { "Mcp-Session-Id": id });
    expect(JSON.parse(text(out))).toEqual({ identifiedAs: { email: ALICE, name: "Alice Example" }, remembered: "connection" });

    expect(text(await call("bab_inbox", {}, { "Mcp-Session-Id": id }))).not.toContain("does not know who you are");
    // Another connection, and a request with no session at all, are still unknown.
    expect(text(await call("bab_inbox", {}, SESS("o")))).toBe(IDENTIFY_TEXT);
    expect(text(await call("bab_inbox", {}))).toBe(IDENTIFY_TEXT);
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT details FROM audit_log WHERE path LIKE '%tools/call:bab_inbox%' AND actor_id = ?").get(ALICE) as {
      details: string;
    };
    expect(JSON.parse(row.details).source).toBe("connection");
  });

  it("with neither, identifies for this call only and says so", async () => {
    const out = await call("bab_identify", { email: ALICE });
    expect(out.result.isError).toBeFalsy();
    expect(JSON.parse(text(out))).toEqual({
      identifiedAs: { email: ALICE, name: "Alice Example" },
      remembered: "none",
      note: "BAB cannot remember you in this app (no device or session), so its tools will keep asking. Tell the user once, in plain words, and do not retry bab_identify in this session. The fix: in the BAB plugin's settings, fill in \"your work address\" and \"your display name\", then restart Claude.",
    });
    expect(text(await call("bab_inbox", {}))).toBe(IDENTIFY_TEXT);
  });

  it("works for a caller who is already identified (by headers), and rebinds to the address given", async () => {
    const out = await call("bab_identify", { email: ALICE }, { ...DEVICE(), ...AS_HEADERS });
    expect(JSON.parse(text(out)).identifiedAs.email).toBe(ALICE);
    // The device now decides over the headers.
    await call("bab_inbox", {}, { ...DEVICE(), ...AS_HEADERS });
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT actor_id FROM audit_log WHERE path LIKE '%tools/call:bab_inbox%'").get();
    expect(row).toEqual({ actor_id: ALICE });
  });

  it("another person can take over a device, and that is audited", async () => {
    await call("bab_identify", { email: ALICE }, DEVICE());
    await call("bab_identify", { email: MARIE }, DEVICE());
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT details FROM audit_log WHERE action = 'device-rebind'").get() as { details: string };
    expect(JSON.parse(row.details)).toMatchObject({ from: ALICE, to: MARIE });
  });

  it("refuses a bad address with the reason, as a tool error, and binds nothing", async () => {
    const short = await call("bab_identify", { email: "aexample@example.com" }, DEVICE());
    expect(short.result.isError).toBe(true);
    expect(text(short)).toMatch(/first\.last@example.com/);
    const other = await call("bab_identify", { email: "someone@example.com" }, DEVICE());
    expect(other.result.isError).toBe(true);
    const missing = await call("bab_identify", {}, DEVICE());
    expect(missing.result.isError).toBe(true);
    const { getDb } = await import("../lib/db");
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n).toBe(0);
  });

  it("allows IDENTIFY_LIMIT_PER_MINUTE a minute per device and then answers with a plain error that names it", async () => {
    const { IDENTIFY_LIMIT_PER_MINUTE } = await import("../lib/identify");
    for (let i = 0; i < IDENTIFY_LIMIT_PER_MINUTE; i++) expect((await call("bab_identify", { email: ALICE }, DEVICE())).result.isError).toBeFalsy();
    const over = await call("bab_identify", { email: ALICE }, DEVICE());
    expect(over.result.isError).toBe(true);
    expect(text(over)).toBe(`Too many bab_identify calls: ${IDENTIFY_LIMIT_PER_MINUTE} a minute. Wait a minute, then retry.`);
    expect((await call("bab_identify", { email: ALICE }, DEVICE("d"))).result.isError).toBeFalsy();
  });

  it("is audited as a tool call and as an identify", async () => {
    await call("bab_identify", { email: ALICE }, DEVICE());
    const { getDb } = await import("../lib/db");
    const actions = (getDb().prepare("SELECT action, path FROM audit_log").all() as { action: string; path: string }[]);
    expect(actions.some((a) => a.action === "identify")).toBe(true);
    expect(actions.some((a) => a.path === "/mcp#tools/call:bab_identify")).toBe(true);
  });
});

describe("who a request is, in order: device, connection, headers", () => {
  async function seed() {
    const { identify } = await import("../lib/identify");
    const { hashSecret } = await import("../lib/devices");
    const { _insertConnectionForTests } = await import("../lib/mcp-connections");
    const conn = _insertConnectionForTests();
    identify({ email: ALICE }, { deviceHash: hashSecret(secret("a")), deviceLabel: "L", connectionId: null, ip: null });
    identify({ email: "ada.lovelace@example.com" }, { deviceHash: null, deviceLabel: "L", connectionId: conn, ip: null });
    return conn;
  }
  const actorOf = async (headers: Record<string, string>) => {
    await call("bab_inbox", {}, headers);
    const { getDb } = await import("../lib/db");
    const rows = getDb().prepare("SELECT actor_id FROM audit_log WHERE path LIKE '%tools/call:bab_inbox%' ORDER BY id DESC").all() as { actor_id: string }[];
    return rows[0].actor_id;
  };

  it("a known device beats a known connection beats the actor headers", async () => {
    const conn = await seed();
    expect(await actorOf({ ...DEVICE("a"), "Mcp-Session-Id": conn, ...AS_HEADERS })).toBe(ALICE);
    expect(await actorOf({ "Mcp-Session-Id": conn, ...AS_HEADERS })).toBe("ada.lovelace@example.com");
    expect(await actorOf({ ...AS_HEADERS })).toBe(MARIE);
  });

  it("a forgotten device is treated as unknown: the connection or the headers decide, and it can be bound again", async () => {
    const conn = await seed();
    const { listDevices, revokeDevice } = await import("../lib/devices");
    revokeDevice(listDevices(ALICE)[0].id, { id: ALICE });
    expect(await actorOf({ ...DEVICE("a"), "Mcp-Session-Id": conn })).toBe("ada.lovelace@example.com");
    expect(await actorOf({ ...DEVICE("a"), ...AS_HEADERS })).toBe(MARIE);
    expect(text(await call("bab_inbox", {}, DEVICE("a")))).toBe(IDENTIFY_TEXT);
    await call("bab_identify", { email: ALICE }, DEVICE("a"));
    expect(await actorOf(DEVICE("a"))).toBe(ALICE);
  });

  it("an unbound connection falls through to the headers", async () => {
    const id = (await rpcRaw("initialize", {})).headers.get("Mcp-Session-Id")!;
    expect(await actorOf({ "Mcp-Session-Id": id, ...AS_HEADERS })).toBe(MARIE);
  });

  it("header callers are served as before and get no tip, whatever device or session they send", async () => {
    const out = await call("bab_inbox", {}, { ...DEVICE("f"), ...SESS("f"), ...AS_HEADERS });
    expect(out.result.isError).toBeFalsy();
    expect(JSON.stringify(out)).not.toMatch(/Tip:|connect/i);
  });
});

describe("the retired connect flow", () => {
  it("never mints a link, whatever the caller sends", async () => {
    const out = JSON.stringify(await call("bab_inbox", {}, { ...DEVICE(), "X-Bab-Device-Label": "Laptop" }));
    expect(out).not.toMatch(/\/connect\/|Connect link|Tip: connect/);
  });

  it("the instructions do not mention a connect link", async () => {
    const { mcpInstructions } = await import("../lib/mcp");
  const MCP_INSTRUCTIONS = mcpInstructions("https://bab.example.com");
    expect(MCP_INSTRUCTIONS).not.toMatch(/connect link|Connect link|connect page/);
    expect(MCP_INSTRUCTIONS).toContain("bab_identify");
  });
});

describe("bab_identify on a token-bound connection", () => {
  const BEARER = { Authorization: "Bearer tok" };
  const bindTokenToAlice = async () => {
    process.env.BAB_API_TOKENS = `tok=${ALICE}`;
    (await import("../lib/config"))._resetConfigForTests();
  };
  const count = async (table: string) => {
    const { getDb } = await import("../lib/db");
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  };

  it("refuses a different email, says the token fixes the identity, and writes no user, device or connection", async () => {
    await bindTokenToAlice();
    const out = await call("bab_identify", { email: MARIE, name: "Marie Curie" }, { ...BEARER, ...DEVICE("t"), ...SESS("t") });
    expect(out.result.isError).toBe(true);
    expect(text(out)).toBe(`This connection is bound to ${ALICE} by its API token; bab_identify cannot change it`);
    expect(text(out)).not.toContain("identifiedAs");

    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT id FROM users WHERE id = ?").get(MARIE)).toBeUndefined();
    expect(await count("devices")).toBe(0);
    expect(await count("mcp_connections")).toBe(0);
  });

  it("identifying as the token's own email is a no-op success that binds nothing", async () => {
    await bindTokenToAlice();
    const out = await call("bab_identify", { email: ALICE.toUpperCase(), name: "Alice Example" }, { ...BEARER, ...DEVICE("t"), ...SESS("t") });
    expect(out.result.isError).toBeFalsy();
    expect(JSON.parse(text(out)).identifiedAs.email).toBe(ALICE);
    expect(await count("devices")).toBe(0);
    expect(await count("mcp_connections")).toBe(0);
  });

  it("keeps acting as the token's person after a refused identify", async () => {
    await bindTokenToAlice();
    await call("bab_identify", { email: MARIE }, { ...BEARER, ...SESS("t") });
    const me = await call("bab_inbox", {}, { ...BEARER, ...SESS("t") });
    expect(me.result.isError).toBeFalsy();
    const { getDb } = await import("../lib/db");
    const row = getDb().prepare("SELECT actor_id FROM audit_log WHERE entity = 'request' ORDER BY id DESC LIMIT 1").get() as { actor_id: string };
    expect(row.actor_id).toBe(ALICE);
  });

  it("refuses a bound email from a connection that does not carry the token, and writes nothing", async () => {
    await bindTokenToAlice();
    process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
    (await import("../lib/config"))._resetConfigForTests();
    const out = await call("bab_identify", { email: ALICE, name: "Alice Example" }, { Authorization: "Bearer bare", ...DEVICE("t"), ...SESS("t") });
    expect(out.result.isError).toBe(true);
    expect(text(out)).toBe(`${ALICE} is bound to an API token; connect with that token to act as them`);

    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT id FROM users WHERE id = ?").get(ALICE)).toBeUndefined();
    expect(await count("devices")).toBe(0);
    expect(await count("mcp_connections")).toBe(0);
    expect(getDb().prepare("SELECT details FROM audit_log WHERE action = 'identify_refused'").all()).toHaveLength(1);
  });

  it("refuses a bound email with the address in different case", async () => {
    await bindTokenToAlice();
    const out = await call("bab_identify", { email: ALICE.toUpperCase(), name: "Alice Example" }, { ...SESS("t") });
    expect(out.result.isError).toBe(true);
    expect(text(out)).toContain("is bound to an API token");
  });

  it("refuses a bound email declared through the X-Bab-Actor-* headers", async () => {
    process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
    (await import("../lib/config"))._resetConfigForTests();
    const out = await call("bab_inbox", {}, { Authorization: "Bearer bare", "X-Bab-Actor-Email": ALICE, "X-Bab-Actor-Name": "Alice Example" });
    expect(out.error?.code).toBe(-32001);
    expect(out.error.message).toBe(`${ALICE} is bound to an API token; connect with that token to act as them`);
  });

  it("leaves another person alone", async () => {
    process.env.BAB_API_TOKENS = `tok=${ALICE},bare`;
    (await import("../lib/config"))._resetConfigForTests();
    const out = await call("bab_identify", { email: MARIE, name: "Marie Curie" }, { Authorization: "Bearer bare", ...SESS("t") });
    expect(out.result.isError).toBeFalsy();
    expect(JSON.parse(text(out)).identifiedAs.email).toBe(MARIE);
  });

  it("without a bound token, bab_identify works as before", async () => {
    const out = await call("bab_identify", { email: MARIE, name: "Marie Curie" }, SESS("t"));
    expect(out.result.isError).toBeFalsy();
    expect(JSON.parse(text(out)).identifiedAs.email).toBe(MARIE);
  });
});
