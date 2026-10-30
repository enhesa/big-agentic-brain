import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The Command Center REST routes, the MCP tool and POST /api/me: the same lib behind all of them,
 * the bound-identity rule, the body cap, idempotent actions and the 409 that carries the record.
 */

let dataDir: string;
const OWNER = "owner.one@example.com";
const OTHER = "other.two@example.com";
let headers: Record<string, string> = {};
const secret = (c: string) => c.repeat(64);

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-cc-api-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";
  vi.resetModules();
  headers = {};
  vi.doMock("next/headers", () => ({ headers: async () => new Headers(headers) }));
  (await import("../lib/command-center"))._resetCommandCenterForTests();
  (await import("../lib/rate-limit")).resetForTests();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
  upsertUser({ id: OTHER, email: OTHER, name: "Other Two", roles: [] });
  const d = await import("../lib/devices");
  d.bindDevice(d.hashSecret(secret("a"))!, OWNER, "Test device", null);
  d.bindDevice(d.hashSecret(secret("b"))!, OTHER, "Test device", null);
  (await import("../lib/command-center")).ccSetSwitch(OWNER, true);
});

afterEach(async () => {
  (await import("../lib/command-center"))._resetCommandCenterForTests();
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_PUBLIC_ORIGIN;
  delete process.env.BAB_API_TOKENS;
  (await import("../lib/config"))._resetConfigForTests();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

const asDevice = (c = "a") => ({ "x-bab-device": secret(c) });
const declared = (email: string) => ({ "x-bab-actor-email": email, "x-bab-actor-name": "Some One" });
const RECORD = { v: 1, title: "Billing export", tasks: [{ id: "t1", text: "Build", status: "pending" }], questions: [{ id: "q1", text: "Which months?" }] };

function req(url: string, method: string, body?: unknown, extra: Record<string, string> = {}) {
  return new Request("https://bab.example.com" + url, {
    method,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...extra },
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const list = async () => (await import("../app/api/command-center/route")).GET(req("/api/command-center", "GET"));
const put = async (id: string, body: unknown, extra?: Record<string, string>) => (await import("../app/api/command-center/[id]/route")).PUT(req(`/api/command-center/${id}`, "PUT", body, extra), ctx(id));
const getOne = async (id: string) => (await import("../app/api/command-center/[id]/route")).GET(req(`/api/command-center/${id}`, "GET"), ctx(id));
const action = async (id: string, body: unknown, extra?: Record<string, string>) =>
  (await import("../app/api/command-center/[id]/actions/route")).POST(req(`/api/command-center/${id}/actions`, "POST", body, extra), ctx(id));

describe("/api/command-center", () => {
  it("401s without an identity and 403s a declared one", async () => {
    expect((await list()).status).toBe(401);
    headers = declared(OWNER);
    const res = await list();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Command Center needs an identity BAB remembers or checks/);
    expect((await put("x", RECORD)).status).toBe(403);
  });

  it("serves a bound device: put, get, list, actions", async () => {
    headers = asDevice();
    const first = await put("billing", RECORD);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ id: "billing", seq: 1 });
    expect((await (await put("billing", RECORD)).json()).seq).toBe(2);
    const one = await (await getOne("billing")).json();
    expect(one).toMatchObject({ id: "billing", seq: 2, title: "Billing export", progress: 0 });
    const all = await (await list()).json();
    expect(all.initiatives).toHaveLength(1);
    expect(all.dataHealth).toEqual({ staleQuestions: 0, silentInitiatives: 0, recurringWithoutHealth: 0, overdueRecurring: 0 });
    expect(await (await action("billing", { action: "clear_question", questionId: "q1" })).json()).toEqual({ cleared: true });
    expect(await (await action("billing", { action: "comment", text: "woken" })).json()).toEqual({ seq: 4 });
    expect((await getOne("missing")).status).toBe(404);
    expect(await (await action("billing", { action: "remove" })).json()).toEqual({ removed: true });
  });

  it("serves a token bound to the person", async () => {
    process.env.BAB_API_TOKENS = "owner-t0ken-for-tests=" + OWNER;
    (await import("../lib/config"))._resetConfigForTests();
    headers = { authorization: "Bearer owner-t0ken-for-tests" };
    expect((await put("billing", RECORD, headers)).status).toBe(200);
  });

  it("is 403 with the exact sentence for a person who is off, and stores nothing", async () => {
    headers = asDevice("b");
    const res = await put("billing", RECORD);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Command Center is off for Other Two. Ask them to open https://bab.example.com/command-center and switch it on, then publish again. Nothing was stored.",
    );
    const { ccSetSwitch, ccView } = await import("../lib/command-center");
    ccSetSwitch(OTHER, true);
    expect(ccView(OTHER).records).toEqual([]);
  });

  it("refuses a body over 256 KB with 413", async () => {
    headers = asDevice();
    const big = JSON.stringify({ ...RECORD, title: "x".repeat(300 * 1024) });
    expect((await put("billing", big, { "content-length": String(big.length) })).status).toBe(413);
    expect((await put("billing", big)).status).toBe(413);
  });

  it("answers 409 with the current record on an expectSeq mismatch", async () => {
    headers = asDevice();
    await put("billing", RECORD);
    const res = await put("billing", { ...RECORD, expectSeq: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).current).toMatchObject({ id: "billing", seq: 1 });
  });

  it("refuses a mismatched id, a body action on PUT, and a bad action", async () => {
    headers = asDevice();
    expect((await put("billing", { ...RECORD, id: "other" })).status).toBe(400);
    expect((await put("billing", { ...RECORD, action: "remove" })).status).toBe(400);
    expect((await put("billing", "[1]")).status).toBe(400);
    expect((await action("billing", { action: "publish" })).status).toBe(400);
    expect((await action("billing", { action: "remove", id: "other" })).status).toBe(400);
  });

  it("replays an action under the same Idempotency-Key", async () => {
    headers = asDevice();
    await put("billing", RECORD);
    const key = { "idempotency-key": "k-1" };
    const a = await action("billing", { action: "comment", text: "once" }, key);
    const b = await action("billing", { action: "comment", text: "once" }, key);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await b.json()).toEqual(await a.json());
    const { ccGet } = await import("../lib/command-center");
    expect(ccGet(OWNER, "billing").comments).toHaveLength(1);
  });
});

describe("bab_command_center", () => {
  it("is in the full list, not the lean one, and runs the same lib", async () => {
    const { findTool, LEAN_TOOL_NAMES } = await import("../lib/mcp");
    expect(LEAN_TOOL_NAMES).not.toContain("bab_command_center");
    const tool = findTool("bab_command_center")!;
    expect(tool.description).toMatch(/^Use only when the command-center skill is loaded/);
    expect(tool.description).not.toContain("<origin>");
    expect(tool.inputSchema.required).toEqual(["action"]);
    const actor = { id: OWNER, email: OWNER, name: "Owner One", roles: [], source: "device" as const, deviceId: "d" };
    const out = JSON.parse(await tool.run(actor, { action: "publish", id: "billing", ...RECORD }, { origin: "https://bab.example.com" }));
    expect(out).toMatchObject({ id: "billing", seq: 1 });
    expect(JSON.parse(await tool.run(actor, { action: "list" })).initiatives).toHaveLength(1);
  });
});

describe("POST /api/me", () => {
  it("ignores a commandCenter field from an agent", async () => {
    headers = asDevice("b");
    const { POST } = await import("../app/api/me/route");
    const res = await POST(req("/api/me", "POST", { name: "Other Two", commandCenter: true }) as never);
    expect(res.status).toBe(200);
    const { ccSwitch } = await import("../lib/command-center");
    expect(ccSwitch(OTHER).enabledAt).toBeNull();
  });
});
