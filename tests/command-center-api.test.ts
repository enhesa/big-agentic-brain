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

  it("serves a bound device: put, get, list, remove", async () => {
    headers = asDevice();
    const first = await put("billing", RECORD);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ id: "billing", seq: 1 });
    expect(await (await put("billing", RECORD)).json()).toMatchObject({ seq: 1, unchanged: true });
    expect((await (await put("billing", { ...RECORD, title: "Billing export 2" })).json()).seq).toBe(2);
    const one = await (await getOne("billing")).json();
    expect(one).toMatchObject({ id: "billing", seq: 2, title: "Billing export 2", progress: 0 });
    const all = await (await list()).json();
    expect(all.initiatives).toHaveLength(1);
    expect(all.dataHealth).toEqual({ staleQuestions: 0, silentInitiatives: 0, recurringWithoutHealth: 0, overdueRecurring: 0 });
    const worked = await (await put("billing", { ...RECORD, title: "Billing export 2", worked: "Checked the numbers", size: "small" })).json();
    expect(worked).toMatchObject({ seq: 2, unchanged: true });
    expect(worked.logged).toMatch(/^[0-9a-f]{32}$/);
    for (const old of ["clear_question", "comment", "health"]) {
      const res = await action("billing", { action: old });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/is gone/);
    }
    expect((await getOne("missing")).status).toBe(404);
    expect(await (await action("billing", { action: "remove" })).json()).toEqual({ removed: true });
  });

  it("serves a token bound to the person", async () => {
    process.env.BAB_API_TOKENS = "owner-t0ken-for-tests=" + OWNER;
    (await import("../lib/config"))._resetConfigForTests();
    headers = { authorization: "Bearer owner-t0ken-for-tests" };
    expect((await put("billing", RECORD, headers)).status).toBe(200);
  });

  it("needs no opt-in: another person's first PUT creates their Command Center", async () => {
    headers = asDevice("b");
    expect((await put("billing", RECORD)).status).toBe(200);
    const { ccView } = await import("../lib/command-center");
    expect(ccView(OTHER).records.map((r) => r.id)).toEqual(["billing"]);
    expect(ccView(OWNER).records).toEqual([]);
  });

  it("serves delete_all, export, grant_export and revoke_export on POST /api/command-center, own data only", async () => {
    process.env.BAB_COMMAND_CENTER_EXPORT_APPS = "reports=" + "r".repeat(40);
    (await import("../lib/config"))._resetConfigForTests();
    try {
      headers = asDevice("b");
      expect((await put("theirs", RECORD)).status).toBe(200);
      headers = asDevice();
      expect((await put("billing", { ...RECORD, worked: "did it" })).status).toBe(200);
      const { POST } = await import("../app/api/command-center/route");
      const post = async (body: unknown) => {
        const res = await POST(req("/api/command-center", "POST", body) as never);
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      };
      // An export is never stored under an Idempotency-Key: a repeat with the same key is fresh.
      const keyed = async () => (await (await POST(req("/api/command-center", "POST", { action: "export" }, { "idempotency-key": "same-key" })) as never as Response).json()) as { entries: { text: string }[] };
      expect((await keyed()).entries.some((e) => e.text === "later")).toBe(false);
      expect((await put("billing", { ...RECORD, worked: "later" })).status).toBe(200);
      expect((await keyed()).entries.some((e) => e.text === "later")).toBe(true);
      const exported = await post({ action: "export" });
      expect(exported.status).toBe(200);
      expect(exported.json.person).toBe(OWNER);
      expect((exported.json.entries as { text: string }[]).some((e) => e.text === "did it")).toBe(true);
      expect(exported.json.exportApps).toEqual([{ app: "reports", grant: null }]);
      expect((await post({ action: "grant_export", id: "reports", level: "entries" })).json).toMatchObject({ app: "reports", level: "entries" });
      expect((await post({ action: "grant_export", id: "nope" })).status).toBe(404);
      expect((await post({ action: "grant_export", id: "reports", level: "all" })).status).toBe(400);
      expect((await post({ action: "revoke_export", id: "reports" })).json).toEqual({ revoked: true });
      expect((await post({ action: "publish", id: "x" })).status).toBe(400);
      expect((await post({ action: "delete_all", confirm: true })).json).toMatchObject({ deleted: 1 });
      const { ccView } = await import("../lib/command-center");
      expect(ccView(OWNER).records).toEqual([]);
      expect(ccView(OTHER).records.map((r) => r.id)).toEqual(["theirs"]);
    } finally {
      delete process.env.BAB_COMMAND_CENTER_EXPORT_APPS;
      (await import("../lib/config"))._resetConfigForTests();
    }
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
    const res = await put("billing", { ...RECORD, title: "Someone else's change", expectSeq: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).current).toMatchObject({ id: "billing", seq: 1 });
  });

  it("answers a retried PUT with the same record and a stale expectSeq as unchanged, not 409", async () => {
    headers = asDevice();
    expect((await put("billing", { ...RECORD, expectSeq: 0 })).status).toBe(200);
    const retry = await put("billing", { ...RECORD, expectSeq: 0 });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ id: "billing", seq: 1, unchanged: true });
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
    const a = await action("billing", { action: "remove" }, key);
    const b = await action("billing", { action: "remove" }, key);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    const first = await a.json();
    expect(await b.json()).toEqual(first);
    expect(first).toEqual({ removed: true });
  });
});

describe("bab_command_center", () => {
  it("is in the full list, not the lean one, and runs the same lib", async () => {
    const { findTool, LEAN_TOOL_NAMES } = await import("../lib/mcp");
    expect(LEAN_TOOL_NAMES).not.toContain("bab_command_center");
    const tool = findTool("bab_command_center")!;
    expect(tool.description).toMatch(/^Needs the command-center skill/);
    expect((tool.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum).toEqual(["publish", "list", "remove", "backfill_link", "delete_all", "export", "grant_export", "revoke_export"]);
    expect(tool.description).not.toContain("<origin>");
    expect(tool.inputSchema.required).toEqual(["action"]);
    const actor = { id: OWNER, email: OWNER, name: "Owner One", roles: [], source: "device" as const, deviceId: "d" };
    const out = JSON.parse(await tool.run(actor, { action: "publish", id: "billing", ...RECORD }, { origin: "https://bab.example.com" }));
    expect(out).toMatchObject({ id: "billing", seq: 1 });
    expect(JSON.parse(await tool.run(actor, { action: "list" })).initiatives).toHaveLength(1);
  });

  const mcpActor = { id: OWNER, email: OWNER, name: "Owner One", roles: [], source: "device" as const, deviceId: "d" };
  async function mcp(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { findTool } = await import("../lib/mcp");
    return JSON.parse(await findTool("bab_command_center")!.run(mcpActor, args, { origin: "https://bab.example.com" }));
  }
  async function mcpRefusal(args: Record<string, unknown>): Promise<{ status: number; message: string }> {
    try {
      await mcp(args);
    } catch (err) {
      const e = err as { status?: number; message: string };
      return { status: e.status ?? 0, message: e.message };
    }
    throw new Error("expected a refusal");
  }

  it("delete_all over MCP takes confirm inside record and refuses without it", async () => {
    expect((await mcpRefusal({ action: "delete_all" })).message).toMatch(/confirm: true/);
    expect(await mcp({ action: "delete_all", record: { confirm: true } })).toMatchObject({ deleted: 0 });
  });

  it("declares record as an object and merges it under the top-level action and id", async () => {
    const { findTool } = await import("../lib/mcp");
    const props = findTool("bab_command_center")!.inputSchema.properties as Record<string, { type: string }>;
    expect(props.record.type).toBe("object");
    expect(await mcp({ action: "publish", id: "billing", record: { ...RECORD, id: "ignored" } })).toMatchObject({ id: "billing", seq: 1 });
    const res = await mcp({ action: "publish", id: "billing", record: { ...RECORD, worked: "from record", action: "remove" } });
    expect(res).toMatchObject({ seq: 1, unchanged: true });
    const { ccLogOf } = await import("../lib/command-center");
    expect(ccLogOf(OWNER).filter((e) => e.kind === "worked").map((e) => e.text)).toEqual(["from record"]);
  });

  it("reads a string-typed v, expectSeq and JSON text fields on the MCP path", async () => {
    const out = await mcp({
      action: "publish",
      id: "billing",
      v: "1",
      expectSeq: "0",
      tasks: JSON.stringify(RECORD.tasks),
      questions: JSON.stringify([{ id: "q1", text: "Which months?", options: '["Last 3","All"]' }]),
      links: '[{"label":"PR","url":"https://git.example.com/acme/x/pull/1"}]',
      title: "Billing export",
    });
    expect(out).toMatchObject({ id: "billing", seq: 1 });
    const { ccGet } = await import("../lib/command-center");
    const rec = ccGet(OWNER, "billing");
    expect(rec.tasks).toHaveLength(1);
    expect(rec.questions[0].options).toEqual(["Last 3", "All"]);
    expect(rec.links).toHaveLength(1);
    expect(await mcp({ action: "publish", id: "billing", record: JSON.stringify({ ...RECORD, title: "Billing export 2", v: "1" }) })).toMatchObject({ seq: 2 });
    expect(ccGet(OWNER, "billing").title).toBe("Billing export 2");
  });

  it("answers 400 naming the fix for JSON text that does not parse, and for a record that is not an object", async () => {
    const bad = await mcpRefusal({ action: "publish", id: "billing", ...RECORD, tasks: "[{oops" });
    expect(bad.status).toBe(400);
    expect(bad.message).toMatch(/^tasks came as text that is not a JSON array or object/);
    expect((await mcpRefusal({ action: "publish", id: "billing", ...RECORD, links: "plain words" })).status).toBe(400);
    for (const record of [[RECORD], 7, "[1]"]) {
      const r = await mcpRefusal({ action: "publish", id: "billing", record });
      expect(r.status).toBe(400);
      expect(r.message).toMatch(/record must be a JSON object/);
    }
  });

  it("answers an MCP 409 with the current record in its text; REST keeps it as a field", async () => {
    await mcp({ action: "publish", id: "billing", record: RECORD });
    const r = await mcpRefusal({ action: "publish", id: "billing", record: { ...RECORD, title: "Someone else's change", expectSeq: 0 } });
    expect(r.status).toBe(409);
    const [sentence, current] = r.message.split("\ncurrent: ");
    expect(sentence.length).toBeGreaterThan(10);
    expect(JSON.parse(current)).toMatchObject({ id: "billing", seq: 1, title: "Billing export", tasks: [{ id: "t1", text: "Build" }] });
    headers = asDevice();
    const res = await put("billing", { ...RECORD, title: "Someone else's change", expectSeq: 0 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).not.toContain("current:");
    expect(body.current).toMatchObject({ id: "billing", seq: 1 });
  });

  it("keeps REST strict: a string v or JSON text tasks is refused there", async () => {
    headers = asDevice();
    const v = await put("billing", { ...RECORD, v: "1" });
    expect(v.status).toBe(400);
    expect((await v.json()).error).toMatch(/v must be 1/);
    expect((await put("billing", { ...RECORD, tasks: JSON.stringify(RECORD.tasks) })).status).toBe(400);
    expect((await mcp({ action: "publish", id: "billing", ...RECORD, v: "1" })).seq).toBe(1);
    const wrapped = await put("billing", { record: RECORD });
    expect(wrapped.status).toBe(400);
    expect((await wrapped.json()).error).toMatch(/unknown field 'record'/);
    expect((await action("billing", { action: "comment", record: { text: "x" } })).status).toBe(400);
  });

  it("ignores action and id inside record: only the top-level ones count", async () => {
    await mcp({ action: "publish", id: "billing", record: RECORD });
    expect(await mcp({ action: "publish", id: "billing", record: { ...RECORD, action: "remove", id: "x" } })).toMatchObject({ id: "billing", seq: 1, unchanged: true });
    const { ccGet } = await import("../lib/command-center");
    expect(ccGet(OWNER, "billing").seq).toBe(1);
    expect(ccGet(OWNER, "billing").title).toBe("Billing export");
    const noTopId = await mcpRefusal({ action: "publish", record: { ...RECORD, id: "billing-2" } });
    expect(noTopId.status).toBe(400);
    expect((await mcp({ action: "list" })).initiatives).toHaveLength(1);
    const noTopAction = await mcpRefusal({ id: "billing", record: { action: "remove" } });
    expect(noTopAction.status).toBe(400);
    expect(noTopAction.message).toMatch(/^action must be one of/);
    expect(ccGet(OWNER, "billing").id).toBe("billing");
  });

  it("answers list with an id with the full record, the same as REST GET; without an id the list", async () => {
    await mcp({ action: "publish", id: "billing", record: RECORD });
    await mcp({ action: "publish", id: "billing", record: { ...RECORD, area: "money" } });
    const one = await mcp({ action: "list", id: "billing" });
    expect(one).toMatchObject({ id: "billing", seq: 2, title: "Billing export", area: "money", tasks: [{ id: "t1", text: "Build" }], questions: [{ id: "q1" }] });
    expect(one).not.toHaveProperty("comments");
    expect(one).not.toHaveProperty("initiatives");
    headers = asDevice();
    expect(one).toEqual(await (await getOne("billing")).json());
    expect((await mcp({ action: "list" })).initiatives).toHaveLength(1);
  });

  it("answers list with an unknown id, or another person's id, with a 404", async () => {
    const missing = await mcpRefusal({ action: "list", id: "missing" });
    expect(missing.status).toBe(404);
    expect(missing.message).toMatch(/No initiative 'missing' in your Command Center/);
    const { findTool } = await import("../lib/mcp");
    const otherActor = { id: OTHER, email: OTHER, name: "Other Two", roles: [], source: "device" as const, deviceId: "d2" };
    await findTool("bab_command_center")!.run(otherActor, { action: "publish", id: "theirs", record: RECORD }, { origin: "https://bab.example.com" });
    const theirs = await mcpRefusal({ action: "list", id: "theirs" });
    expect(theirs.status).toBe(404);
    expect(theirs.message).not.toContain("Billing export");
    expect((await mcpRefusal({ action: "list", id: "billing", text: "x" })).message).toMatch(/unknown field 'text' for list; allowed: id/);
  });

  it("takes health as a field of the record, and refuses the old health action", async () => {
    const rec = { v: 1, title: "Upkeep", kind: "recurring" };
    await mcp({ action: "publish", id: "upkeep", record: rec });
    expect(await mcp({ action: "publish", id: "upkeep", record: { ...rec, health: { level: "amber", reason: "slow", checkedAt: "2026-01-31T09:30:00Z" } } })).toMatchObject({ seq: 2 });
    expect((await mcpRefusal({ action: "health", id: "upkeep", record: { level: "green" } })).message).toMatch(/health is gone as an action/);
    const { ccGet } = await import("../lib/command-center");
    expect(ccGet(OWNER, "upkeep").health).toMatchObject({ level: "amber", reason: "slow" });
  });

  it("refuses an unknown field inside record and names it", async () => {
    const pub = await mcpRefusal({ action: "publish", id: "billing", record: { ...RECORD, owner: OTHER } });
    expect(pub.status).toBe(400);
    expect(pub.message).toMatch(/unknown field 'owner'/);
    await mcp({ action: "publish", id: "billing", record: RECORD });
    const com = await mcpRefusal({ action: "remove", id: "billing", record: { mood: "glad" } });
    expect(com.status).toBe(400);
    expect(com.message).toMatch(/unknown field 'mood' for remove/);
    expect((await mcpRefusal({ action: "publish", id: "billing", record: { ...RECORD, comments: [] } })).message).toMatch(/comments is gone/);
  });

  it("refuses a record over 32 KB sent in record with 413 and stores nothing", async () => {
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, text: "x".repeat(120), status: "pending" }));
    const links = Array.from({ length: 20 }, (_, i) => ({ label: "z".repeat(60), url: "https://example.com/" + "p".repeat(470) + i }));
    const questions = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, text: "w".repeat(500), options: ["o".repeat(60), "o".repeat(60), "o".repeat(60), "o".repeat(60)] }));
    for (let round = 0; round < 5; round++) {
      await mcp({ action: "publish", id: "billing", record: { v: 1, title: "Big", questions: Array.from({ length: 5 }, (_, i) => ({ id: `old${round}-${i}`, text: "v".repeat(500) })) } });
    }
    const r = await mcpRefusal({ action: "publish", id: "billing", record: { v: 1, title: "Big", tasks, links, questions } });
    expect(r.status).toBe(413);
    expect(r.message).toMatch(/at most 32 KB per initiative/);
    expect(((await mcp({ action: "list", id: "billing" })).tasks as unknown[]).length).toBe(0);
  });

  it("answers the gates before reading MCP args: off on the server, identity, rate", async () => {
    const offActor = { id: OTHER, email: OTHER, name: "Other Two", roles: [], source: "device" as const, deviceId: "d2" };
    const { findTool } = await import("../lib/mcp");
    const tool = findTool("bab_command_center")!;
    const refuse = async (actor: typeof mcpActor, args: Record<string, unknown>) => {
      try {
        await tool.run(actor, args, { origin: "https://bab.example.com" });
      } catch (err) {
        const e = err as { status?: number; message: string };
        return { status: e.status ?? 0, message: e.message };
      }
      throw new Error("expected a refusal");
    };
    const badText = { action: "publish", id: "billing", record: "[{oops" };
    // Off on the server wins over bad JSON text.
    process.env.BAB_COMMAND_CENTER = "0";
    (await import("../lib/config"))._resetConfigForTests();
    try {
      expect((await refuse(offActor, badText)).status).toBe(404);
      expect((await refuse(mcpActor, badText)).status).toBe(404);
      expect((await refuse(mcpActor, { action: "publish", id: "billing", record: RECORD })).status).toBe(404);
    } finally {
      delete process.env.BAB_COMMAND_CENTER;
      (await import("../lib/config"))._resetConfigForTests();
    }
    // A declared identity is refused before the args are read.
    const declaredActor = { id: OWNER, email: OWNER, name: "Owner One", roles: [], source: "header" as const };
    const anon = await refuse(declaredActor as unknown as typeof mcpActor, badText);
    expect(anon.status).toBe(403);
    expect(anon.message).toMatch(/needs an identity BAB remembers/);
    // Rate before the args: once the burst is spent, bad JSON text gets 429.
    for (let i = 0; i < 20; i++) await mcp({ action: "list" });
    expect((await refuse(mcpActor, badText)).status).toBe(429);
  });

  it("bounds how deep record can nest with a clear 400", async () => {
    let nested: Record<string, unknown> = { ...RECORD };
    for (let i = 0; i < 10; i++) nested = { record: nested };
    const r = await mcpRefusal({ action: "publish", id: "billing", record: nested });
    expect(r.status).toBe(400);
    expect(r.message).toMatch(/record is nested too deep/);
  });

  it("reads JSON text null as clearing health on the MCP path", async () => {
    const rec = { v: 1, title: "Upkeep", kind: "recurring", health: { level: "green", reason: "ok", checkedAt: "2026-01-31T09:30:00Z" } };
    await mcp({ action: "publish", id: "upkeep", record: rec });
    await mcp({ action: "publish", id: "upkeep", ...rec, health: "null" });
    const { ccGet } = await import("../lib/command-center");
    expect(ccGet(OWNER, "upkeep").health).toBeNull();
    expect((await mcpRefusal({ action: "publish", id: "upkeep", ...rec, links: "null" })).status).toBe(400);
  });
});

describe("POST /api/me", () => {
  it("ignores a commandCenter field from an agent", async () => {
    headers = asDevice("b");
    const { POST } = await import("../app/api/me/route");
    const res = await POST(req("/api/me", "POST", { name: "Other Two", commandCenter: true }) as never);
    expect(res.status).toBe(200);
    const { getDb } = await import("../lib/db");
    expect((getDb().prepare("SELECT command_center_enabled_at AS e FROM users WHERE id = ?").get(OTHER) as { e: string | null }).e).toBeNull();
  });
});
