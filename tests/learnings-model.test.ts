import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * Which model wrote a memory (migration v37). Optional and self-declared (honour system), so
 * these tests pin the shape (normalised, validated, null when absent), where it travels (create,
 * search hits, GET by id, the model filter on REST and MCP) and that it stays out of standing.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-learnings-model-test-"));
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

const ACTOR = { "X-Bab-Actor-Email": "ada.m@example.com", "X-Bab-Actor-Name": "Ada M" };

function mockIdentity() {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": ACTOR["X-Bab-Actor-Email"], "x-bab-actor-name": ACTOR["X-Bab-Actor-Name"] }),
  }));
}

async function seedUser() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "ada.m@example.com", email: "ada.m@example.com", name: "Ada M", roles: [] });
}

async function rpcCall(name: string, args: Record<string, unknown>) {
  mockIdentity();
  const { POST } = await import("../app/mcp/route");
  const res = await POST(
    new Request("https://bab.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...ACTOR },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  return (await res.json()).result as { isError?: boolean; content: Array<{ text: string }> };
}

describe("migration v37", () => {
  it("adds learnings.model, NULL for older rows, and boots again if the column already exists", async () => {
    await seedUser();
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.prepare(
      "INSERT INTO learnings (id, author_id, title, body, tags, status) VALUES ('old', 'ada.m@example.com', 't', 'b', '[]', 'active')",
    ).run();
    expect(db.prepare("SELECT model FROM learnings WHERE id = 'old'").get()).toEqual({ model: null });
    expect(db.prepare("SELECT version FROM migrations WHERE version = 37").get()).toBeTruthy();

    // A process that died between the ALTER and the migrations row must boot again.
    db.prepare("DELETE FROM migrations WHERE version >= 37").run();
    _resetDbForTests();
    const { getDb: again } = await import("../lib/db");
    expect(again().prepare("SELECT 1 FROM migrations WHERE version = 37").get()).toBeTruthy();
  });

  it("is covered by CURRENT_VERSION", () => {
    const src = readFileSync(path.join(process.cwd(), "lib", "db.ts"), "utf8");
    expect(Number(/const CURRENT_VERSION = (\d+);/.exec(src)?.[1])).toBeGreaterThanOrEqual(37);
  });
});

describe("normalizeModel", () => {
  it("lowercases and trims, and maps absent or blank to null", async () => {
    const { normalizeModel } = await import("../lib/learnings");
    expect(normalizeModel("  Claude-Opus-5-5 ")).toBe("claude-opus-5-5");
    expect(normalizeModel("gpt-4.1")).toBe("gpt-4.1");
    expect(normalizeModel(undefined)).toBeNull();
    expect(normalizeModel(null)).toBeNull();
    expect(normalizeModel("   ")).toBeNull();
  });

  it("refuses anything that is not a short model id", async () => {
    const { normalizeModel } = await import("../lib/learnings");
    for (const bad of ["claude opus", "claude_opus", "claude-opus-5-5[1m]", "a@b.com", "<script>", "x".repeat(65), 5, {}]) {
      expect(() => normalizeModel(bad), String(bad)).toThrow();
    }
    expect(normalizeModel("a".repeat(64))).toBe("a".repeat(64));
  });
});

describe("create and read", () => {
  it("stores the normalised model, null when absent, and does not copy it onto a correction", async () => {
    await seedUser();
    const { create, getById } = await import("../lib/learnings");
    const withModel = create({ authorId: "ada.m@example.com", title: "Alpha gotcha", body: "alpha body text one", model: "Claude-Opus-5-5" });
    const without = create({ authorId: "ada.m@example.com", title: "Zulu gotcha", body: "zulu body text two" });
    expect(getById(withModel.id)!.model).toBe("claude-opus-5-5");
    expect(getById(without.id)!.model).toBeNull();
    const fix = create({ authorId: "ada.m@example.com", title: "Alpha gotcha fixed", body: "alpha corrected body", supersedesId: withModel.id });
    expect(getById(fix.id)!.model).toBeNull();
  });

  it("a bad model is a ValidationError and nothing is written", async () => {
    await seedUser();
    const { create, list } = await import("../lib/learnings");
    expect(() => create({ authorId: "ada.m@example.com", title: "T", body: "B", model: "not a model" })).toThrow(/model/);
    expect(list({ status: "all" })).toHaveLength(0);
  });

  it("search hits carry model and the model filter finds exactly that model's memories", async () => {
    await seedUser();
    const { create, search, searchTotal, parseModelFilter } = await import("../lib/learnings");
    const a = create({ authorId: "ada.m@example.com", title: "Kafka batch size", body: "keep messages small", model: "claude-opus-5-5" });
    create({ authorId: "ada.m@example.com", title: "Kafka retention days", body: "seven days is the default", model: "claude-sonnet-5-5" });
    create({ authorId: "ada.m@example.com", title: "Kafka partition count", body: "match the consumer count" });

    const filters = { model: parseModelFilter(" Claude-Opus-5-5 ") };
    const hits = search("kafka", filters);
    expect(hits.map((h) => h.id)).toEqual([a.id]);
    expect(hits[0].model).toBe("claude-opus-5-5");
    expect(searchTotal("kafka", filters)).toBe(1);
    // The empty-query listing path filters too, and no filter returns all three.
    expect(search("", filters).map((h) => h.id)).toEqual([a.id]);
    expect(search("kafka")).toHaveLength(3);
    expect(parseModelFilter("")).toBeUndefined();
    expect(() => parseModelFilter("no good")).toThrow();
  });

  it("does not change standing or the standing reason", async () => {
    await seedUser();
    const { create, search } = await import("../lib/learnings");
    const a = create({ authorId: "ada.m@example.com", title: "Model gotcha one", body: "first body about models", model: "claude-opus-5-5" });
    const b = create({ authorId: "ada.m@example.com", title: "Plain gotcha two", body: "second body about pizza" });
    const byId = new Map(search("").map((h) => [h.id, h]));
    expect(byId.get(a.id)).toMatchObject({ standing: "weak", standingReason: "no reactions yet" });
    expect(byId.get(b.id)).toMatchObject({ standing: "weak", standingReason: "no reactions yet" });
    expect(byId.get(a.id)!.confidence).toBe(byId.get(b.id)!.confidence);
  });
});

describe("REST", () => {
  it("POST accepts model, GET /:id returns it, a bad id is a 400", async () => {
    mockIdentity();
    const { POST } = await import("../app/api/learnings/route");
    const post = (body: unknown) =>
      POST(
        new Request("http://x/api/learnings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }) as never,
      );
    const ok = await post({ title: "REST model", body: "created over rest", model: "Claude-Opus-5-5" });
    expect(ok.status).toBe(201);
    const { learning } = await ok.json();
    expect(learning.model).toBe("claude-opus-5-5");

    const bad = await post({ title: "REST bad model", body: "created over rest again", model: "claude opus 5 5" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/model/);

    const { GET } = await import("../app/api/learnings/[id]/route");
    const got = await GET(new Request(`http://x/api/learnings/${learning.id}`) as never, {
      params: Promise.resolve({ id: learning.id }),
    });
    expect((await got.json()).learning.model).toBe("claude-opus-5-5");
  });

  it("GET /api/learnings?model= filters, and a malformed model is a 400, not unfiltered", async () => {
    await seedUser();
    const { create } = await import("../lib/learnings");
    create({ authorId: "ada.m@example.com", title: "Opus fact", body: "written by opus", model: "claude-opus-5-5" });
    create({ authorId: "ada.m@example.com", title: "Other fact", body: "written by someone else", model: "gpt-5" });
    mockIdentity();
    const { GET } = await import("../app/api/learnings/route");
    const res = await GET(new Request("http://x/api/learnings?model=Claude-Opus-5-5") as never);
    const body = await res.json();
    expect(body.results.map((r: { title: string }) => r.title)).toEqual(["Opus fact"]);
    expect(body.results[0].model).toBe("claude-opus-5-5");

    const bad = await GET(new Request("http://x/api/learnings?model=not%20valid") as never);
    expect(bad.status).toBe(400);
  });
});

describe("MCP", () => {
  it("bab_learn stores model, bab_search returns it and filters by it", async () => {
    await seedUser();
    const learned = await rpcCall("bab_learn", { title: "MCP model fact", body: "written through the tool", model: "claude-opus-5-5" });
    expect(learned.isError).toBeFalsy();
    expect(JSON.parse(learned.content[0].text).learning.model).toBe("claude-opus-5-5");
    await rpcCall("bab_learn", { title: "MCP no model", body: "another one without any model id" });

    const found = JSON.parse((await rpcCall("bab_search", { query: "", model: "CLAUDE-OPUS-5-5" })).content[0].text);
    expect(found.results.map((r: { title: string }) => r.title)).toEqual(["MCP model fact"]);
    expect(found.total).toBe(1);
    expect(found.results[0].model).toBe("claude-opus-5-5");
  });

  it("bab_learn refuses a malformed model and bab_search refuses a malformed model filter", async () => {
    await seedUser();
    const bad = await rpcCall("bab_learn", { title: "Bad model", body: "should be refused", model: "claude opus" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/model/);
    const badFilter = await rpcCall("bab_search", { query: "", model: "claude opus" });
    expect(badFilter.isError).toBe(true);
  });

  it("the tool descriptions tell agents to pass their own model id, and the instructions stay short", async () => {
    mockIdentity();
    const { POST } = await import("../app/mcp/route");
    const res = await POST(
      new Request("https://bab.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...ACTOR },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    const tools = (await res.json()).result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }>;
    const learn = tools.find((t) => t.name === "bab_learn")!;
    expect(learn.description).toContain("pass your own model id from your system prompt");
    expect(learn.description).toContain("claude-opus-5-5");
    expect(learn.inputSchema.properties.model.description).toContain("Self-declared");
    expect(tools.find((t) => t.name === "bab_search")!.inputSchema.properties.model).toBeTruthy();
    const { mcpInstructions } = await import("../lib/mcp");
    expect(mcpInstructions("https://bab.example.com").length).toBeLessThanOrEqual(1980);
  });
});

describe("the memory page", () => {
  async function render(id: string): Promise<string> {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { default: DetailPage } = await import("../app/memory/[id]/page");
    const { renderToReadableStream } = await import("react-dom/server.edge");
    return new Response(await renderToReadableStream((await DetailPage({ params: Promise.resolve({ id }) })) as never)).text();
  }

  it("shows Written with when a model is declared, and nothing when it is not", async () => {
    await seedUser();
    const { create } = await import("../lib/learnings");
    const a = create({ authorId: "ada.m@example.com", title: "Gradle wrapper version", body: "pin the wrapper in every build file", model: "claude-opus-5-5" });
    const b = create({ authorId: "ada.m@example.com", title: "Harvest festival menu", body: "soup and bread for forty guests" });
    expect(await render(a.id)).toMatch(/Written with<\/span><span[^>]*>claude-opus-5-5/);
    expect(await render(b.id)).not.toContain("Written with");
  });

  it("shows the measured effort to find it when the plugin measured one, and nothing when not", async () => {
    await seedUser();
    const { create } = await import("../lib/learnings");
    const { recordDiscoveryCost } = await import("../lib/effort-cost");
    const a = create({ authorId: "ada.m@example.com", title: "Gradle cache key", body: "hash the lock file, not the build file" });
    const b = create({ authorId: "ada.m@example.com", title: "Garden hose length", body: "thirty metres reaches the back fence" });
    recordDiscoveryCost(a.id, { activeMs: 25 * 60_000, tokens: 123_456, usd: null });
    expect(await render(a.id)).toMatch(/Agent effort to find<\/span><span[^>]*>25 min, 123,456 tokens/);
    expect(await render(b.id)).not.toContain("Agent effort to find");
  });
});

describe("the specs", () => {
  it("say the model is self-declared and does not feed standing or confidence", () => {
    const spec = readFileSync(path.join(process.cwd(), "docs", "spec.md"), "utf8").replace(/\s+/g, " ");
    expect(spec).toContain("It does not feed standing, confidence or the search rank.");
    const skill = readFileSync(path.join(process.cwd(), "content", "instructions", "skill.md"), "utf8").replace(/\s+/g, " ");
    expect(skill).toContain("model (optional)");
    expect(skill).toContain("not part of standing or confidence");
  });
});
