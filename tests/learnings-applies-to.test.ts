import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * Applies-to labels on memories (migration v41): the column, the create path on every surface,
 * inheritance on a correction, the search ranking and mismatch flag, and the filter.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-learnings-applies-to-test-"));
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
const AUTHOR = "ada.m@example.com";

function mockIdentity() {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": ACTOR["X-Bab-Actor-Email"], "x-bab-actor-name": ACTOR["X-Bab-Actor-Name"] }),
  }));
}

async function seedUser() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: AUTHOR, email: AUTHOR, name: "Ada M", roles: [] });
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

describe("migration v41", () => {
  it("adds learnings.applies_to as '[]' for older rows, and boots again if the column already exists", async () => {
    await seedUser();
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const db = getDb();
    db.prepare(
      "INSERT INTO learnings (id, author_id, title, body, tags, status) VALUES ('old', 'ada.m@example.com', 't', 'b', '[]', 'active')",
    ).run();
    expect(db.prepare("SELECT applies_to FROM learnings WHERE id = 'old'").get()).toEqual({ applies_to: "[]" });
    expect(db.prepare("SELECT version FROM migrations WHERE version = 41").get()).toBeTruthy();

    db.prepare("DELETE FROM migrations WHERE version >= 41").run();
    _resetDbForTests();
    const { getDb: again } = await import("../lib/db");
    expect(again().prepare("SELECT 1 FROM migrations WHERE version = 41").get()).toBeTruthy();
  });
});

describe("create", () => {
  it("stores normalised labels, [] when absent, and refuses an unknown label without writing", async () => {
    await seedUser();
    const { create, getById, list } = await import("../lib/learnings");
    const a = create({ authorId: AUTHOR, title: "Flags in dotnet", body: "use IsEnabledAsync for flags", appliesTo: ["C#", "k8s"] });
    const b = create({ authorId: AUTHOR, title: "Plain fact", body: "holds everywhere on earth" });
    expect(JSON.parse(getById(a.id)!.applies_to)).toEqual(["dotnet", "aks"]);
    expect(getById(b.id)!.applies_to).toBe("[]");
    expect(() => create({ authorId: AUTHOR, title: "Bad", body: "bad label here", appliesTo: ["rust"] })).toThrow(/Valid: stack:/);
    expect(list({ status: "all" })).toHaveLength(2);
  });

  it("a correction inherits the labels unless given, and [] or null clears them", async () => {
    await seedUser();
    const { create, getById } = await import("../lib/learnings");
    const orig = create({ authorId: AUTHOR, title: "Dotnet flag rule", body: "original text about flags", appliesTo: ["dotnet"] });
    const inherit = create({ authorId: AUTHOR, title: "Dotnet flag rule v2", body: "corrected text about flags", supersedesId: orig.id });
    expect(JSON.parse(getById(inherit.id)!.applies_to)).toEqual(["dotnet"]);
    const given = create({ authorId: AUTHOR, title: "Dotnet flag rule v3", body: "third text about flags", supersedesId: inherit.id, appliesTo: ["node"] });
    expect(JSON.parse(getById(given.id)!.applies_to)).toEqual(["node"]);
    const cleared = create({ authorId: AUTHOR, title: "Dotnet flag rule v4", body: "fourth text about flags", supersedesId: given.id, appliesTo: [] });
    expect(getById(cleared.id)!.applies_to).toBe("[]");
    const nulled = create({ authorId: AUTHOR, title: "Dotnet flag rule v5", body: "fifth text about flags", supersedesId: cleared.id, appliesTo: null });
    expect(getById(nulled.id)!.applies_to).toBe("[]");
  });

  it("a consolidation carries the union, and everywhere when one of them was everywhere", async () => {
    await seedUser();
    const { createWithSupersedes, create, getById } = await import("../lib/learnings");
    const a = create({ authorId: AUTHOR, title: "Alpha dotnet", body: "alpha body words", appliesTo: ["dotnet"] });
    const b = create({ authorId: AUTHOR, title: "Beta node", body: "beta body words", appliesTo: ["node", "dotnet"] });
    const c = create({ authorId: AUTHOR, title: "Gamma anywhere", body: "gamma body words" });
    const merged = createWithSupersedes({ authorId: AUTHOR, title: "Alpha and beta", body: "merged words" }, [a.id, b.id]);
    expect(JSON.parse(getById(merged.id)!.applies_to)).toEqual(["dotnet", "node"]);
    const wide = createWithSupersedes({ authorId: AUTHOR, title: "Merged with anywhere", body: "wide merged words" }, [merged.id, c.id]);
    expect(getById(wide.id)!.applies_to).toBe("[]");
    const explicit = createWithSupersedes(
      { authorId: AUTHOR, title: "Explicit labels", body: "explicit words", appliesTo: ["python"] },
      [wide.id],
    );
    expect(JSON.parse(getById(explicit.id)!.applies_to)).toEqual(["python"]);
  });
});

describe("search", () => {
  async function seedMixed() {
    await seedUser();
    const { create } = await import("../lib/learnings");
    // Near-identical relevance on purpose (same words), so the stack decides the order.
    const dotnet = create({ authorId: AUTHOR, title: "Feature flag rule", body: "check feature flags first", appliesTo: ["dotnet"], confirmNotDuplicate: true });
    const everywhere = create({ authorId: AUTHOR, title: "Feature flag habit", body: "check feature flags early", confirmNotDuplicate: true });
    const node = create({ authorId: AUTHOR, title: "Feature flag trick", body: "check feature flags often", appliesTo: ["node", "aks"], confirmNotDuplicate: true });
    return { dotnet, everywhere, node };
  }

  it("every hit carries appliesTo, and without a stack nothing is flagged", async () => {
    const { dotnet, everywhere } = await seedMixed();
    const { search } = await import("../lib/learnings");
    const hits = search("feature flags");
    expect(hits).toHaveLength(3);
    const byId = new Map(hits.map((h) => [h.id, h]));
    expect(byId.get(dotnet.id)!.appliesTo).toEqual(["dotnet"]);
    expect(byId.get(everywhere.id)!.appliesTo).toEqual([]);
    for (const h of hits) expect(h.stackMismatch).toBeUndefined();
  });

  it("ranks hits that fit the stack first and flags the rest, keeping them", async () => {
    const { dotnet, everywhere, node } = await seedMixed();
    const { search, searchTotal } = await import("../lib/learnings");
    const hits = search("feature flags", { stack: ["python", "aks"] });
    // node+aks shares aks and everywhere fits; dotnet is the one that does not.
    expect(hits).toHaveLength(3);
    expect(hits[2].id).toBe(dotnet.id);
    expect(hits[2].stackMismatch).toBe(true);
    expect(hits[2].stackHint).toBe("for dotnet, not your stack: weigh, don't follow");
    expect(new Set(hits.slice(0, 2).map((h) => h.id))).toEqual(new Set([everywhere.id, node.id]));
    for (const h of hits.slice(0, 2)) expect(h.stackMismatch).toBeUndefined();
    expect(searchTotal("feature flags", { stack: ["python", "aks"] })).toBe(3);

    // The mismatch moves with the stack: for dotnet, the node one is the mismatch.
    const forDotnet = search("feature flags", { stack: ["dotnet"] });
    expect(forDotnet[2].id).toBe(node.id);
    expect(forDotnet[2].stackHint).toBe("for node, aks, not your stack: weigh, don't follow");
  });

  it("ranking holds across pages", async () => {
    const { everywhere } = await seedMixed();
    const { search } = await import("../lib/learnings");
    // python fits only the unlabelled memory: it leads page 1, the two mismatches follow.
    const page1 = search("feature flags", { stack: ["python"] }, 2, 0);
    const page2 = search("feature flags", { stack: ["python"] }, 2, 2);
    expect(page1[0].id).toBe(everywhere.id);
    expect(page1[0].stackMismatch).toBeUndefined();
    expect(page1[1].stackMismatch).toBe(true);
    expect(page2).toHaveLength(1);
    expect(page2[0].stackMismatch).toBe(true);
  });

  it("the empty-query listing ranks and flags too", async () => {
    const { dotnet } = await seedMixed();
    const { search } = await import("../lib/learnings");
    const hits = search("", { stack: ["node"] });
    expect(hits).toHaveLength(3);
    expect(hits[2].id).toBe(dotnet.id);
    expect(hits[2].stackMismatch).toBe(true);
  });

  it("the appliesTo filter keeps only labelled memories, and everywhere finds the unlabelled", async () => {
    const { dotnet, everywhere, node } = await seedMixed();
    const { search, searchTotal } = await import("../lib/learnings");
    expect(search("feature flags", { appliesTo: ["dotnet"] }).map((h) => h.id)).toEqual([dotnet.id]);
    expect(searchTotal("feature flags", { appliesTo: ["dotnet"] })).toBe(1);
    expect(search("feature flags", { appliesTo: ["aks"] }).map((h) => h.id)).toEqual([node.id]);
    expect(search("feature flags", { appliesTo: ["everywhere"] }).map((h) => h.id)).toEqual([everywhere.id]);
    expect(new Set(search("", { appliesTo: ["dotnet", "everywhere"] }).map((h) => h.id))).toEqual(new Set([dotnet.id, everywhere.id]));
    expect(searchTotal("feature flags", { appliesTo: ["dotnet", "node"] })).toBe(2);
  });
});

describe("REST", () => {
  it("POST takes appliesTo and returns it, a bad label is a 400, GET filters and ranks", async () => {
    mockIdentity();
    const { POST, GET } = await import("../app/api/learnings/route");
    const post = (body: unknown) =>
      POST(
        new Request("http://x/api/learnings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }) as never,
      );
    const ok = await post({ title: "REST dotnet rule", body: "flags in dotnet services", appliesTo: ["c#"] });
    expect(ok.status).toBe(201);
    const created = (await ok.json()).learning;
    expect(created.appliesTo).toEqual(["dotnet"]);

    const bad = await post({ title: "REST bad label", body: "flags in rust services", appliesTo: ["rust"] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/bab_feedback/);

    await post({ title: "REST anywhere rule", body: "flags in all services" });

    const filtered = await (await GET(new Request("http://x/api/learnings?appliesTo=dotnet") as never)).json();
    expect(filtered.results.map((r: { title: string }) => r.title)).toEqual(["REST dotnet rule"]);
    expect((await GET(new Request("http://x/api/learnings?appliesTo=rust") as never)).status).toBe(400);

    const ranked = await (await GET(new Request("http://x/api/learnings?stack=python&stack=rust") as never)).json();
    expect(ranked.results.map((r: { title: string }) => r.title)).toEqual(["REST anywhere rule", "REST dotnet rule"]);
    expect(ranked.results[1].stackMismatch).toBe(true);
    expect(ranked.results[0].appliesTo).toEqual([]);

    const { GET: GET_ID } = await import("../app/api/learnings/[id]/route");
    const got = await GET_ID(new Request(`http://x/api/learnings/${created.id}`) as never, {
      params: Promise.resolve({ id: created.id }),
    });
    expect((await got.json()).learning.appliesTo).toEqual(["dotnet"]);
  });
});

describe("MCP", () => {
  it("bab_learn stores appliesTo and a correction inherits it; bab_search ranks, flags and filters", async () => {
    await seedUser();
    const learned = await rpcCall("bab_learn", { title: "MCP dotnet flag rule", body: "use IsEnabledAsync for flags", appliesTo: ["C#"] });
    expect(learned.isError).toBeFalsy();
    const first = JSON.parse(learned.content[0].text).learning;
    expect(first.appliesTo).toEqual(["dotnet"]);

    const fixed = await rpcCall("bab_learn", { title: "MCP dotnet flag rule, fixed", body: "use IsEnabledAsync, not the legacy call", supersedes: first.id });
    expect(JSON.parse(fixed.content[0].text).learning.appliesTo).toEqual(["dotnet"]);

    await rpcCall("bab_learn", { title: "MCP flag habit", body: "use IsEnabledAsync wherever you can read flags" });

    const bad = await rpcCall("bab_learn", { title: "MCP bad", body: "unknown label here", appliesTo: ["rust"] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/Valid: stack:/);

    const searched = JSON.parse((await rpcCall("bab_search", { query: "IsEnabledAsync", stack: ["python"] })).content[0].text);
    expect(searched.results).toHaveLength(2);
    expect(searched.results[0].title).toBe("MCP flag habit");
    expect(searched.results[1]).toMatchObject({
      appliesTo: ["dotnet"],
      stackMismatch: true,
      stackHint: "for dotnet, not your stack: weigh, don't follow",
    });
    const only = JSON.parse((await rpcCall("bab_search", { query: "IsEnabledAsync", appliesTo: "dotnet" })).content[0].text);
    expect(only.results.map((r: { title: string }) => r.title)).toEqual(["MCP dotnet flag rule, fixed"]);
    expect(only.total).toBe(1);
    const badFilter = await rpcCall("bab_search", { query: "x", appliesTo: ["rust"] });
    expect(badFilter.isError).toBe(true);
  });

  it("the tool texts tell agents to fill appliesTo and how to read the repo, and the instructions stay within 1980, the cap on main", async () => {
    const { findTool, mcpInstructions } = await import("../lib/mcp");
    const learn = findTool("bab_learn")!;
    expect(learn.description).toContain("appliesTo");
    const prop = (learn.inputSchema as { properties: Record<string, { description: string }> }).properties.appliesTo.description;
    expect(prop).toContain("aliases");
    expect(prop).toContain("unknown is an error");
    const search = findTool("bab_search")!;
    expect((search.inputSchema as { properties: Record<string, unknown> }).properties.stack).toBeTruthy();
    expect(search.description).toContain("stack");
    expect(mcpInstructions("https://bab.example.com").length).toBeLessThanOrEqual(1980);
  });
});

describe("BAB_EXTRA_APPLIES_TO", () => {
  afterEach(() => {
    delete process.env.BAB_EXTRA_APPLIES_TO;
  });

  /** A row written before the label left the built-in list: raw SQL, as an older release stored it. */
  async function seedStored() {
    await seedUser();
    const { getDb } = await import("../lib/db");
    getDb()
      .prepare("INSERT INTO learnings (id, author_id, title, body, tags, status, applies_to) VALUES ('l-stored', ?, 'Deploy through the app platform', 'platform deploy words', '[]', 'active', ?)")
      .run(AUTHOR, '["forge","aks"]');
  }

  it("refuses an unlisted platform label on a write with the variable unset, and accepts it when listed", async () => {
    await seedUser();
    const { create } = await import("../lib/learnings");
    expect(() => create({ authorId: AUTHOR, title: "Extra label", body: "extra label words", appliesTo: ["forge"] })).toThrow(/Unknown appliesTo/);
    process.env.BAB_EXTRA_APPLIES_TO = "forge";
    const { _resetConfigForTests } = await import("../lib/config");
    _resetConfigForTests();
    const ok = create({ authorId: AUTHOR, title: "Extra label", body: "extra label words", appliesTo: ["Forge", "aks"] });
    expect(JSON.parse((await import("../lib/learnings")).getById(ok.id)!.applies_to)).toEqual(["forge", "aks"]);
  });

  it("a stored label that is not listed still reads, lists, searches and filters on its other labels", async () => {
    await seedStored();
    const { getById, search, list } = await import("../lib/learnings");
    expect(JSON.parse(getById("l-stored")!.applies_to)).toEqual(["forge", "aks"]);
    expect(list({ status: "active" }).map((l) => l.id)).toEqual(["l-stored"]);
    const hits = search("platform deploy");
    expect(hits.map((h) => h.id)).toEqual(["l-stored"]);
    expect(hits[0].appliesTo).toEqual(["forge", "aks"]);
    expect(search("platform deploy", { appliesTo: ["aks"] }).map((h) => h.id)).toEqual(["l-stored"]);
    expect(search("platform deploy", { stack: ["aks"] })[0].stackMismatch).toBeUndefined();
    // Filtering on the unlisted label itself is a write-side vocabulary check: refused.
    const { parseAppliesToFilter } = await import("../lib/applies-to");
    expect(() => parseAppliesToFilter("forge")).toThrow(/Unknown/);
  });

  it("a correction inherits an unlisted stored label, and setting new labels replaces it", async () => {
    await seedStored();
    const { create, getById, setLabels } = await import("../lib/learnings");
    const next = create({ authorId: AUTHOR, title: "Deploy through the app platform v2", body: "corrected platform deploy words", supersedesId: "l-stored" });
    expect(JSON.parse(getById(next.id)!.applies_to)).toEqual(["forge", "aks"]);
    expect(() => setLabels(next.id, AUTHOR, ["forge"])).toThrow(/Unknown appliesTo/);
    expect(JSON.parse(setLabels(next.id, AUTHOR, ["aks"]).learning.applies_to)).toEqual(["aks"]);
  });

  it("a consolidation of memories that carry an unlisted stored label keeps the union, and still refuses a typed unlisted label", async () => {
    await seedStored();
    const { getDb } = await import("../lib/db");
    getDb()
      .prepare("INSERT INTO learnings (id, author_id, title, body, tags, status, applies_to) VALUES ('l-stored-2', ?, 'Deploy through the app platform too', 'platform deploy more words', '[]', 'active', ?)")
      .run(AUTHOR, '["forge","docker"]');
    const { createWithSupersedes, getById } = await import("../lib/learnings");
    const merged = createWithSupersedes(
      { authorId: AUTHOR, title: "Deploy through the app platform, merged", body: "merged platform deploy words" },
      ["l-stored", "l-stored-2"],
    );
    expect(JSON.parse(getById(merged.id)!.applies_to).sort()).toEqual(["aks", "docker", "forge"]);
    expect(getById("l-stored")!.status).toBe("archived");
    expect(getById("l-stored-2")!.status).toBe("archived");

    // Labels the caller types are still checked against the vocabulary in force.
    getDb()
      .prepare("INSERT INTO learnings (id, author_id, title, body, tags, status, applies_to) VALUES ('l-a', ?, 'Alpha thing', 'alpha thing words', '[]', 'active', '[]'), ('l-b', ?, 'Beta thing', 'beta thing words', '[]', 'active', '[]')")
      .run(AUTHOR, AUTHOR);
    expect(() =>
      createWithSupersedes({ authorId: AUTHOR, title: "Alpha beta merged", body: "alpha beta merged words", appliesTo: ["forge"] }, ["l-a", "l-b"]),
    ).toThrow(/Unknown appliesTo/);
    expect(getById("l-a")!.status).toBe("active");
  });

  it("the REST read and the memory pages render a stored unlisted label", async () => {
    await seedStored();
    mockIdentity();
    const { GET: GET_ID } = await import("../app/api/learnings/[id]/route");
    const got = await GET_ID(new Request("http://x/api/learnings/l-stored") as never, { params: Promise.resolve({ id: "l-stored" }) });
    expect((await got.json()).learning.appliesTo).toEqual(["forge", "aks"]);

    const { renderToReadableStream } = await import("react-dom/server.edge");
    const render = async (node: unknown) => new Response(await renderToReadableStream(node as never)).text();
    const { default: MemoryPage } = await import("../app/memory/page");
    expect(await render(MemoryPage({ searchParams: Promise.resolve({}) }))).toContain("Deploy through the app platform");
    const { default: DetailPage } = await import("../app/memory/[id]/page");
    expect(await render(DetailPage({ params: Promise.resolve({ id: "l-stored" }) }))).toContain("forge");
  });

  it("the tool descriptions agents read list the extra label, and only when it is set", async () => {
    const { TOOLS } = await import("../lib/mcp");
    const text = () => JSON.stringify(TOOLS.filter((t) => t.name === "bab_search" || t.name === "bab_learn").map((t) => t.inputSchema));
    expect(text()).not.toContain("forge");
    process.env.BAB_EXTRA_APPLIES_TO = "forge";
    const { _resetConfigForTests } = await import("../lib/config");
    _resetConfigForTests();
    const learn = TOOLS.find((t) => t.name === "bab_learn")!.inputSchema.properties as Record<string, { description: string }>;
    const search = TOOLS.find((t) => t.name === "bab_search")!.inputSchema.properties as Record<string, { description: string }>;
    expect(learn.appliesTo.description).toContain("platform aks, azure, aws, windows, linux, macos, forge (aliases");
    expect(search.stack.description).toContain("also aks, forge, docker, kafka and so on");
  });

  it("the memory filter lists the extra label as a platform when it is set", async () => {
    process.env.BAB_EXTRA_APPLIES_TO = "forge";
    await seedStored();
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    const { renderToReadableStream } = await import("react-dom/server.edge");
    const { default: MemoryPage } = await import("../app/memory/page");
    const html = await new Response(await renderToReadableStream((await MemoryPage({ searchParams: Promise.resolve({}) })) as never)).text();
    expect(html).toContain('<option value="forge"');
    expect(html).toContain('<option value="aks"');
  });
});
