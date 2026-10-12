import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * Setting a memory's "applies to" labels in place (bab_react label, POST /api/learnings/:id/labels):
 * set, change, clear, validation, archived and deleted refused, the audit row, no vote and no
 * standing change, and both surfaces.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-set-labels-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

const AUTHOR = "ada.m@example.com";
const OTHER = "bob.k@example.com";

async function seed(opts: { appliesTo?: string[] } = {}) {
  const { upsertUser } = await import("../lib/users");
  for (const id of [AUTHOR, OTHER]) upsertUser({ id, email: id, name: id, roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId: AUTHOR, title: "Flags in dotnet", body: "use IsEnabledForAsync for flags", ...opts });
}

async function auditRows(id: string) {
  const { getDb } = await import("../lib/db");
  return getDb()
    .prepare("SELECT actor_id, via, details FROM audit_log WHERE action = 'labels_set' AND entity_id = ? ORDER BY rowid")
    .all(id) as Array<{ actor_id: string; via: string; details: string }>;
}

describe("setLabels", () => {
  it("sets labels on a memory that has none, normalising aliases", async () => {
    const l = await seed();
    const { setLabels, getById } = await import("../lib/learnings");
    const out = setLabels(l.id, OTHER, ["C#", "k8s"], "mcp");
    expect(out.changed).toBe(true);
    expect(JSON.parse(out.learning.applies_to)).toEqual(["dotnet", "aks"]);
    expect(JSON.parse(getById(l.id)!.applies_to)).toEqual(["dotnet", "aks"]);
  });

  it("changes existing labels, on a memory of any kind, by anyone", async () => {
    await seed();
    const { create, setLabels } = await import("../lib/learnings");
    for (const kind of ["learning", "practice", "standard", "decision"] as const) {
      const l = create({
        authorId: AUTHOR,
        title: `A ${kind} about something distinct ${kind}`,
        body: `body words for the ${kind} one`,
        kind,
        appliesTo: ["node"],
        confirmNotDuplicate: true,
      });
      const out = setLabels(l.id, OTHER, ["python"], "mcp");
      expect(out.changed).toBe(true);
      expect(JSON.parse(out.learning.applies_to)).toEqual(["python"]);
    }
  });

  it("clears the labels with [] (holds anywhere)", async () => {
    const l = await seed({ appliesTo: ["dotnet"] });
    const { setLabels } = await import("../lib/learnings");
    const out = setLabels(l.id, AUTHOR, [], "mcp");
    expect(out.changed).toBe(true);
    expect(out.learning.applies_to).toBe("[]");
  });

  it("the same set again (in any order) is changed:false and writes no audit row", async () => {
    const l = await seed({ appliesTo: ["dotnet", "aks"] });
    const { setLabels } = await import("../lib/learnings");
    expect(setLabels(l.id, OTHER, ["aks", "dotnet"], "mcp").changed).toBe(false);
    expect(await auditRows(l.id)).toHaveLength(0);
    expect(setLabels(l.id, OTHER, [], "mcp").changed).toBe(true);
    expect(setLabels(l.id, OTHER, [], "mcp").changed).toBe(false);
  });

  it("refuses an unknown label, with the valid ones, and changes nothing", async () => {
    const l = await seed({ appliesTo: ["dotnet"] });
    const { setLabels, getById } = await import("../lib/learnings");
    expect(() => setLabels(l.id, OTHER, ["rust"], "mcp")).toThrow(/Valid: stack:/);
    expect(JSON.parse(getById(l.id)!.applies_to)).toEqual(["dotnet"]);
    expect(await auditRows(l.id)).toHaveLength(0);
  });

  it("requires appliesTo: a missing or null value is refused, never read as everywhere", async () => {
    const l = await seed({ appliesTo: ["dotnet"] });
    const { setLabels, getById } = await import("../lib/learnings");
    expect(() => setLabels(l.id, OTHER, undefined, "mcp")).toThrow(/appliesTo is required/);
    expect(() => setLabels(l.id, OTHER, null, "mcp")).toThrow(/appliesTo is required/);
    expect(JSON.parse(getById(l.id)!.applies_to)).toEqual(["dotnet"]);
  });

  it("refuses an archived memory and a deleted one, with the status in the message", async () => {
    const l = await seed({ appliesTo: ["dotnet"] });
    const { setLabels, retire, deleteOwn, create, getById } = await import("../lib/learnings");
    retire(l.id, AUTHOR, "mcp", null);
    expect(() => setLabels(l.id, OTHER, ["node"], "mcp")).toThrow(/Memory is archived/);
    expect(JSON.parse(getById(l.id)!.applies_to)).toEqual(["dotnet"]);

    const d = create({ authorId: AUTHOR, title: "Another memory", body: "different words entirely here" });
    deleteOwn(d.id, AUTHOR, "mcp");
    expect(() => setLabels(d.id, OTHER, ["node"], "mcp")).toThrow(/Memory is deleted/);
  });

  it("is a not-found for an unknown id", async () => {
    await seed();
    const { setLabels } = await import("../lib/learnings");
    expect(() => setLabels("nope", OTHER, ["node"], "mcp")).toThrow(/not found/i);
  });

  it("writes a labels_set audit row with from, to and by, and no vote and no standing change", async () => {
    const l = await seed({ appliesTo: ["node"] });
    const { setLabels, voteCounts, getById } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const votesBefore = getDb().prepare("SELECT COUNT(*) AS n FROM votes").get();
    setLabels(l.id, OTHER, ["python"], "mcp");
    setLabels(l.id, AUTHOR, [], "mcp");
    const rows = await auditRows(l.id);
    expect(rows.map((r) => [r.actor_id, r.via, JSON.parse(r.details)])).toEqual([
      [OTHER, "mcp", { from: ["node"], to: ["python"], by: "other" }],
      [AUTHOR, "mcp", { from: ["python"], to: [], by: "author" }],
    ]);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM votes").get()).toEqual(votesBefore);
    expect(voteCounts(l.id)).toEqual({ helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 0 });
    expect(getById(l.id)!.status).toBe("active");
  });
});

describe("POST /api/learnings/[id]/labels", () => {
  function mockIdentity(email: string | null) {
    vi.doMock("next/headers", () => ({
      headers: async () =>
        email ? new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": "Bob" }) : new Headers(),
    }));
  }
  const req = (body: unknown) =>
    new Request("http://x/labels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("returns 401 without identity", async () => {
    mockIdentity(null);
    const { POST } = await import("../app/api/learnings/[id]/labels/route");
    const res = await POST(req({ appliesTo: ["node"] }) as never, { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(401);
  });

  it("sets the labels in place and answers { learning (with appliesTo), changed }", async () => {
    const l = await seed();
    mockIdentity(OTHER);
    const { POST } = await import("../app/api/learnings/[id]/labels/route");
    const res = await POST(req({ appliesTo: ["c#", "k8s"] }) as never, { params: Promise.resolve({ id: l.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(true);
    expect(body.learning.id).toBe(l.id);
    expect(body.learning.appliesTo).toEqual(["dotnet", "aks"]);
    const again = await POST(req({ appliesTo: ["dotnet", "aks"] }) as never, { params: Promise.resolve({ id: l.id }) });
    expect((await again.json()).changed).toBe(false);
    expect(await auditRows(l.id)).toHaveLength(1);
  });

  it("400s on an unknown label or a missing appliesTo, 404s on an unknown id, 409s on an archived memory", async () => {
    const l = await seed({ appliesTo: ["dotnet"] });
    mockIdentity(OTHER);
    const { POST } = await import("../app/api/learnings/[id]/labels/route");
    const ctx = () => ({ params: Promise.resolve({ id: l.id }) });
    const bad = await POST(req({ appliesTo: ["rust"] }) as never, ctx());
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Valid: stack:/);
    expect((await POST(req({}) as never, ctx())).status).toBe(400);
    expect((await POST(req({ appliesTo: ["node"] }) as never, { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
    const { retire } = await import("../lib/learnings");
    retire(l.id, AUTHOR, "mcp", null);
    const archived = await POST(req({ appliesTo: ["node"] }) as never, ctx());
    expect(archived.status).toBe(409);
    expect((await archived.json()).error).toMatch(/archived/);
  });
});

describe("bab_react label over MCP", () => {
  async function rpc(name: string, args: Record<string, unknown>) {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": OTHER, "x-bab-actor-name": "Bob" }),
    }));
    const { POST } = await import("../app/mcp/route");
    const res = await POST(
      new Request("https://bab.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Bab-Actor-Email": OTHER, "X-Bab-Actor-Name": "Bob" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    return (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };
  }

  it("sets, changes and clears labels, and answers { learning, changed, url }", async () => {
    const l = await seed();
    const set = await rpc("bab_react", { learningId: l.id, action: "label", appliesTo: ["nodejs", "docker"] });
    expect(set.isError).toBeFalsy();
    const out = JSON.parse(set.content[0].text);
    expect(out.changed).toBe(true);
    expect(out.learning.appliesTo).toEqual(["node", "docker"]);
    expect(out.url).toContain(`/memory/${l.id}`);

    const changed = JSON.parse((await rpc("bab_react", { learningId: l.id, action: "label", appliesTo: ["python"] })).content[0].text);
    expect(changed.learning.appliesTo).toEqual(["python"]);
    const cleared = JSON.parse((await rpc("bab_react", { learningId: l.id, action: "label", appliesTo: [] })).content[0].text);
    expect(cleared.learning.appliesTo).toEqual([]);
    expect(await auditRows(l.id)).toHaveLength(3);
  });

  it("errors on an unknown label, a missing appliesTo and an archived memory", async () => {
    const l = await seed({ appliesTo: ["dotnet"] });
    const bad = await rpc("bab_react", { learningId: l.id, action: "label", appliesTo: ["rust"] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/Valid: stack:/);
    const missing = await rpc("bab_react", { learningId: l.id, action: "label" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/appliesTo is required/);
    const { retire } = await import("../lib/learnings");
    retire(l.id, AUTHOR, "mcp", null);
    const archived = await rpc("bab_react", { learningId: l.id, action: "label", appliesTo: ["node"] });
    expect(archived.isError).toBe(true);
    expect(archived.content[0].text).toMatch(/archived/);
  });

  it("the tool text says when to label, the schema lists the action and appliesTo, and the instructions stay within 1980", async () => {
    const { findTool, mcpInstructions } = await import("../lib/mcp");
    const react = findTool("bab_react")!;
    expect(react.description).toContain("label: set appliesTo when a memory's stack or platform labels are missing or wrong");
    const props = (react.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.action.enum).toContain("label");
    expect(props.appliesTo).toBeTruthy();
    expect(mcpInstructions("https://bab.example.com").length).toBeLessThanOrEqual(1980);
  });
});

describe("the API index", () => {
  it("lists the labels route", async () => {
    const { GET } = await import("../app/api/route");
    const body = await (await GET()).json();
    expect(body.endpoints["POST /api/learnings/:id/labels"]).toContain("appliesTo");
  });
});
