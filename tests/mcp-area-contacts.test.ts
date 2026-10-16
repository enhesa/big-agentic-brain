import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _resetConfigForTests } from "../lib/config";

/**
 * Home team and area contacts through bab_people and the search that has no answer (MCP), and
 * through the JSON API (/api/people, /api/me/team, /api/me/areas, /api/learnings).
 */

let dataDir: string;
const ADA = { email: "ada.t@example.com", name: "Ada T" };
const BOB = { email: "bob.b@example.com", name: "Bob B" };
const MAINT = { email: "maint.m@example.com", name: "Maint M" };

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-mcp-area-test-"));
  process.env.DATA_DIR = dataDir;
  process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";
  process.env.BAB_MAINTAINERS = MAINT.email;
  _resetConfigForTests();
  vi.resetModules();
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": current.email, "x-bab-actor-name": current.name }),
  }));
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_PUBLIC_ORIGIN;
  delete process.env.BAB_MAINTAINERS;
  _resetConfigForTests();
  vi.doUnmock("next/headers");
  vi.resetModules();
});

// The route modules keep the first next/headers binding they import, so the identity is a variable it reads.
let current = ADA;
function as(who: { email: string; name: string }) {
  current = who;
}

/** Calls a tool as `who`; returns the parsed JSON, or { error } when the tool refused. */
async function tool(who: { email: string; name: string }, name: string, args: Record<string, unknown> = {}) {
  as(who);
  const { POST } = await import("../app/mcp/route");
  const res = await POST(
    new Request("https://bab.example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const result = (await res.json()).result as { isError?: boolean; content: { text: string }[] };
  const text = result.content[0].text;
  return result.isError ? { error: text } : JSON.parse(text);
}

async function api(who: { email: string; name: string }, route: string, method: string, url: string, body?: unknown) {
  as(who);
  const mod = await import(route);
  const res: Response = await mod[method](
    new Request(url, {
      method,
      headers: { "content-type": "application/json", host: "localhost" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

describe("bab_people", () => {
  it("shows homeTeam and areas in the directory, null and empty until someone opts in", async () => {
    await tool(ADA, "bab_people");
    await tool(BOB, "bab_people");
    expect(await tool(ADA, "bab_people", { action: "set_home_team", team: "regulatory" })).toEqual({ homeTeam: "regulatory" });
    await tool(ADA, "bab_people", { action: "add_contact", area: "toxicology" });
    const out = await tool(BOB, "bab_people");
    const ada = out.users.find((u: { id: string }) => u.id === ADA.email);
    const bob = out.users.find((u: { id: string }) => u.id === BOB.email);
    expect(ada).toMatchObject({ homeTeam: "regulatory", areas: ["toxicology"], learningCount: 0 });
    expect(bob).toMatchObject({ homeTeam: null, areas: [] });
    expect(out.self).toBe(BOB.email);
  });

  it("adds yourself as a contact, lists the contacts for the area, and removes yourself", async () => {
    const added = await tool(ADA, "bab_people", { action: "add_contact", area: "Toxicology", note: "regulatory lists, CHAs, certifications" });
    expect(added.area).toBe("toxicology");
    expect(added.contacts).toEqual([
      { area: "toxicology", id: ADA.email, name: "Ada T", note: "regulatory lists, CHAs, certifications" },
    ]);
    const listed = await tool(BOB, "bab_people", { area: "toxicology" });
    expect(listed.contacts.map((c: { id: string }) => c.id)).toEqual([ADA.email]);
    expect((await tool(BOB, "bab_people", { area: "Toxicology " })).area).toBe("toxicology");
    await tool(ADA, "bab_people", { action: "add_contact", area: "regulatory-lists" });
    expect((await tool(BOB, "bab_people", { area: "Regulatory Lists" })).area).toBe("regulatory-lists");
    expect(await tool(ADA, "bab_people", { action: "remove_contact", area: "toxicology" })).toEqual({ removed: true });
    expect((await tool(BOB, "bab_people", { area: "toxicology" })).contacts).toEqual([]);
    expect(await tool(ADA, "bab_people", { action: "remove_contact", area: "toxicology" })).toEqual({ removed: false });
  });

  it("refuses bad input with a clear message", async () => {
    expect((await tool(ADA, "bab_people", { action: "set_home_team", team: "wizards" })).error).toMatch(/team must be one of/);
    expect((await tool(ADA, "bab_people", { action: "add_contact" })).error).toMatch(/area is required/);
    expect((await tool(ADA, "bab_people", { action: "add_contact", area: "x", note: "n".repeat(201) })).error).toMatch(/200 characters/);
    expect((await tool(ADA, "bab_people", { action: "dance" })).error).toMatch(/action must be one of/);
    expect((await tool(ADA, "bab_people", { area: "!!!" })).error).toMatch(/area is required/);
  });

  it("clears the home team with an empty team", async () => {
    await tool(ADA, "bab_people", { action: "set_home_team", team: "legal" });
    expect(await tool(ADA, "bab_people", { action: "set_home_team", team: "" })).toEqual({ homeTeam: null });
    expect((await tool(ADA, "bab_people", { action: "set_home_team" })).error).toMatch(/team is required/);
    expect((await tool(ADA, "bab_people", { action: "add_contact", area: ["pass", "word=hunter2"].join("") })).error).toMatch(/personal data/);
  });

  it("lets only a maintainer remove someone else", async () => {
    await tool(BOB, "bab_people", { action: "add_contact", area: "toxicology" });
    expect((await tool(ADA, "bab_people", { action: "remove_contact", area: "toxicology", user: BOB.email })).error).toMatch(/Only maintainers/);
    expect(await tool(MAINT, "bab_people", { action: "remove_contact", area: "toxicology", user: BOB.email })).toEqual({ removed: true });
    // A maintainer adding names only themselves: add_contact has no user argument.
    await tool(MAINT, "bab_people", { action: "add_contact", area: "toxicology", user: BOB.email });
    expect((await tool(ADA, "bab_people", { area: "toxicology" })).contacts.map((c: { id: string }) => c.id)).toEqual([MAINT.email]);
  });

  it("the tool description and schema name the new arguments", async () => {
    const { TOOLS } = await import("../lib/mcp");
    const t = TOOLS.find((x) => x.name === "bab_people")!;
    expect(Object.keys((t.inputSchema as { properties: object }).properties)).toEqual(["area", "action", "team", "note", "user"]);
    expect(t.description).toContain("homeTeam");
    expect(t.description).toContain("add_contact");
  });
});

describe("bab_search with no answer", () => {
  async function seedContacts() {
    await tool(ADA, "bab_people", { action: "add_contact", area: "toxicology", note: "chemical hazard assessments" });
    await tool(BOB, "bab_people", { action: "add_contact", area: "regulatory-lists" });
  }

  it("names the area contacts when nothing matches, with the hint", async () => {
    await seedContacts();
    const out = await tool(MAINT, "bab_search", { query: "toxicology zzzzqqq" });
    expect(out.total).toBe(0);
    expect(out.contacts).toEqual([
      { area: "toxicology", id: ADA.email, name: "Ada T", note: "chemical hazard assessments" },
    ]);
    expect(out.contactsHint).toContain("bab_send");
    expect(out.contactsHint).toContain("bab_learn");
  });

  it("also uses the tag filter", async () => {
    await seedContacts();
    const out = await tool(MAINT, "bab_search", { query: "zzzzqqq", tag: "regulatory-lists" });
    expect(out.contacts.map((c: { id: string }) => c.id)).toEqual([BOB.email]);
  });

  it("adds nothing when there is a result, and does not change it", async () => {
    await seedContacts();
    await tool(ADA, "bab_learn", { title: "Toxicology screening gotcha", body: "Check the screening list version first.", tags: ["regulatory"] });
    const out = await tool(MAINT, "bab_search", { query: "toxicology" });
    expect(out.total).toBe(1);
    expect(out.contacts).toBeUndefined();
    expect(out.contactsHint).toBeUndefined();
  });

  it("adds nothing when no contact fits, on a later page, or on an empty listing", async () => {
    await seedContacts();
    expect((await tool(MAINT, "bab_search", { query: "zzzzqqq pizza" })).contacts).toBeUndefined();
    expect((await tool(MAINT, "bab_search", { query: "toxicology zzzzqqq", offset: 5 })).contacts).toBeUndefined();
    expect((await tool(MAINT, "bab_search", { query: "" })).contacts).toBeUndefined();
  });
});

describe("JSON API", () => {
  const people = "../app/api/people/route";
  const team = "../app/api/me/team/route";
  const areas = "../app/api/me/areas/route";

  it("401s without identity", async () => {
    vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
    vi.resetModules();
    for (const [route, method] of [[team, "POST"], [areas, "GET"], [areas, "POST"], [areas, "DELETE"]] as const) {
      const mod = await import(route);
      expect((await mod[method](new Request("http://localhost/x", { method }))).status).toBe(401);
    }
  });

  it("sets and clears the home team, and the directory shows it", async () => {
    expect((await api(ADA, team, "POST", "http://localhost/api/me/team", { team: "Product" })).body).toEqual({ homeTeam: "product" });
    const dir = await api(BOB, people, "GET", "http://localhost/api/people");
    expect(dir.body.users.find((u: { id: string }) => u.id === ADA.email)).toMatchObject({ homeTeam: "product", areas: [] });
    expect((await api(ADA, team, "POST", "http://localhost/api/me/team", { team: null })).body).toEqual({ homeTeam: null });
  });

  it("refuses a bad team, a bad body and a non-string team", async () => {
    expect((await api(ADA, team, "POST", "http://localhost/api/me/team", { team: "wizards" })).status).toBe(400);
    expect((await api(ADA, team, "POST", "http://localhost/api/me/team", { team: 5 })).status).toBe(400);
    const missing = await api(ADA, team, "POST", "http://localhost/api/me/team", {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/team is required/);
    as(ADA);
    const mod = await import(team);
    const res: Response = await mod.POST(new Request("http://localhost/api/me/team", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
  });

  it("adds, lists, changes and drops your areas, and lists the contacts for an area", async () => {
    const add = await api(ADA, areas, "POST", "http://localhost/api/me/areas", { area: "Toxicology", note: "hazards" });
    expect(add.status).toBe(200);
    expect(add.body.contacts).toHaveLength(1);
    await api(ADA, areas, "POST", "http://localhost/api/me/areas", { area: "toxicology", note: "hazards and lists" });
    expect((await api(ADA, areas, "GET", "http://localhost/api/me/areas")).body).toEqual({ areas: [{ area: "toxicology", note: "hazards and lists" }] });
    await api(ADA, team, "POST", "http://localhost/api/me/team", { team: "legal" });
    const me = await api(ADA, "../app/api/me/route", "GET", "http://localhost/api/me");
    expect(me.body).toMatchObject({ homeTeam: "legal", areas: [{ area: "toxicology", note: "hazards and lists" }] });
    await api(ADA, team, "POST", "http://localhost/api/me/team", { team: null });
    expect((await api(BOB, people, "GET", "http://localhost/api/people?area=Regulatory%20Lists")).body.area).toBe("regulatory-lists");
    const byArea = await api(BOB, people, "GET", "http://localhost/api/people?area=toxicology");
    expect(byArea.body.contacts).toEqual([{ area: "toxicology", id: ADA.email, name: "Ada T", note: "hazards and lists" }]);
    expect((await api(BOB, people, "GET", "http://localhost/api/people?area=!!!")).status).toBe(400);
    expect((await api(ADA, areas, "DELETE", "http://localhost/api/me/areas?area=toxicology")).body).toEqual({ removed: true });
    expect((await api(ADA, areas, "DELETE", "http://localhost/api/me/areas?area=toxicology")).body).toEqual({ removed: false });
  });

  it("enforces the limits and the maintainer rule", async () => {
    for (const who of [ADA, BOB, MAINT]) await api(who, areas, "POST", "http://localhost/api/me/areas", { area: "toxicology" });
    const dee = { email: "dee.d@example.com", name: "Dee D" };
    const full = await api(dee, areas, "POST", "http://localhost/api/me/areas", { area: "toxicology" });
    expect(full.status).toBe(400);
    expect(full.body.error).toMatch(/already has 3 contacts/);
    expect((await api(ADA, areas, "DELETE", `http://localhost/api/me/areas?area=toxicology&user=${BOB.email}`)).status).toBe(403);
    expect((await api(MAINT, areas, "DELETE", `http://localhost/api/me/areas?area=toxicology&user=${BOB.email}`)).body).toEqual({ removed: true });
    expect((await api(ADA, areas, "DELETE", "http://localhost/api/me/areas")).status).toBe(400);
    expect((await api(ADA, areas, "POST", "http://localhost/api/me/areas", [])).status).toBe(400);
  });

  it("replays a POST with the same Idempotency-Key", async () => {
    as(ADA);
    const mod = await import(areas);
    const send = (note: string) =>
      mod.POST(
        new Request("http://localhost/api/me/areas", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "k1" },
          body: JSON.stringify({ area: "toxicology", note }),
        }),
      );
    expect((await send("first")).status).toBe(200);
    expect((await send("second")).status).toBe(422);
    expect((await api(ADA, areas, "GET", "http://localhost/api/me/areas")).body.areas[0].note).toBe("first");
  });

  it("GET /api/learnings carries contacts when nothing matches, and not otherwise", async () => {
    await api(ADA, areas, "POST", "http://localhost/api/me/areas", { area: "toxicology" });
    const none = await api(BOB, "../app/api/learnings/route", "GET", "http://localhost/api/learnings?q=toxicology+zzzzqqq");
    expect(none.body.results).toEqual([]);
    expect(none.body.contacts.map((c: { id: string }) => c.id)).toEqual([ADA.email]);
    expect(none.body.contactsHint).toContain("bab_send");
    const unrelated = await api(BOB, "../app/api/learnings/route", "GET", "http://localhost/api/learnings?q=pizza");
    expect(unrelated.body.contacts).toBeUndefined();
    const listing = await api(BOB, "../app/api/learnings/route", "GET", "http://localhost/api/learnings");
    expect(listing.body.contacts).toBeUndefined();
  });

  it("GET /api lists the new endpoints", async () => {
    const { GET } = await import("../app/api/route");
    const body = await (await GET()).json();
    for (const key of ["POST /api/me/team", "GET /api/me/areas", "POST /api/me/areas", "DELETE /api/me/areas"]) {
      expect(body.endpoints[key], key).toBeTruthy();
    }
    expect(body.endpoints["GET /api/people"]).toContain("homeTeam");
    expect(body.endpoints["GET /api/me"]).toContain("homeTeam");
  });
});

describe("the instructions tell agents about contacts", () => {
  it("the served skill and the plugin skill carry the line; the server instructions stay as they were", async () => {
    const { readFileSync } = await import("node:fs");
    const { mcpInstructions } = await import("../lib/mcp");
    // bab_search hands over contactsHint with the contacts, so the size-capped instructions need no line.
    expect(mcpInstructions("https://bab.example.com")).not.toContain("bab_people area=");
    for (const file of ["content/instructions/skill.md", "plugins/claude-code/skills/big-agentic-brain/SKILL.md"]) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8").replace(/\s+/g, " ");
      expect(text, file).toContain("suggest them, or with the user's yes send only that person the question with `bab_send`");
      expect(text, file).toContain("save it with `bab_learn`");
    }
  });
});
