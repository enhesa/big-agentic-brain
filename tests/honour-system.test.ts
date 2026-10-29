import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * BAB is an honour system (by design). It
 * is run by Claude agents that honour its guardrails, and the guardrails live in the agent texts
 * (MCP instructions, tool descriptions, the hosted skill, hook texts). The server adds no check
 * whose only job is to stop an agent breaking one. These tests pin that, so a refusal is not
 * rebuilt unnoticed:
 *
 *   - a non-maintainer can post a standard;
 *   - anyone can supersede another author's decision;
 *   - anyone can retire another author's standard.
 *
 * The texts say otherwise to agents (standards: maintainers only; a decision only by its author
 * with the user's yes, or a maintainer; everyone else flags with evidence). That is the guard, by
 * design. If one of these tests fails because a server check was added, remove the check
 * and strengthen the text instead; do not change the test. What the server DOES enforce is
 * required fields (a note on a flag, a confirm and a non-author's retire) and plain data rules,
 * which have their own tests.
 *
 * One exception, on purpose: pin / unpin. A pinned house rule goes straight into every agent's
 * first prompt, so with BAB_MAINTAINERS set the server refuses a non-maintainer (403), like a
 * feedback status change. With no maintainers configured it is still an honour system. That
 * contract is in tests/pin-maintainers.test.ts.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-honour-test-"));
  process.env.DATA_DIR = dataDir;
  // A maintainer list exists and does not include the actors below: having one changes nothing.
  process.env.BAB_MAINTAINERS = "maintainer.one@example.com";
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  vi.doUnmock("next/headers");
  vi.resetModules();
});

const AGENT = { id: "ada.agent@example.com", email: "ada.agent@example.com", name: "Ada Agent" };
const OWNER = { id: "bob.owner@example.com", email: "bob.owner@example.com", name: "Bob Owner" };

async function users() {
  const { upsertUser } = await import("../lib/users");
  for (const u of [AGENT, OWNER]) upsertUser({ ...u, roles: [] });
}

/** Runs an MCP tool the way the route does: an identified actor and the tool's own arguments. */
async function tool(name: string, args: Record<string, unknown>) {
  const { findTool } = await import("../lib/mcp");
  return JSON.parse(findTool(name)!.run({ id: AGENT.id } as never, args) as string);
}

describe("a non-maintainer can post a standard", () => {
  // The texts guard this, by design: "kind standard: maintainers only" (MCP
  // instructions) and "standard is posted and changed only by BAB maintainers" (bab_learn). The
  // server does not check it.
  it("through the library", async () => {
    await users();
    const { create } = await import("../lib/learnings");
    const { isMaintainer } = await import("../lib/feedback");
    expect(isMaintainer(AGENT.id)).toBe(false);
    const l = create({ authorId: AGENT.id, title: "Services extend the pipeline", body: "Every service extends it.", kind: "standard" });
    expect(l.kind).toBe("standard");
    expect(l.status).toBe("active");
  });

  it("through bab_learn", async () => {
    await users();
    const out = await tool("bab_learn", { title: "Services extend the pipeline", body: "Every service extends it.", kind: "standard" });
    expect(out.learning.kind).toBe("standard");
  });

  it("through POST /api/learnings", async () => {
    await users();
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": AGENT.email, "x-bab-actor-name": AGENT.name }),
    }));
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(
      new Request("http://x/api/learnings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Services extend the pipeline", body: "Every service extends it.", kind: "standard" }),
      }) as never,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).learning.kind).toBe("standard");
  });

  it("and a correction may change a learning into one", async () => {
    await users();
    const { create, createWithSupersedes } = await import("../lib/learnings");
    const rule = create({ authorId: OWNER.id, title: "House rule about pipelines", body: "Extend the pipeline template." });
    const corrected = createWithSupersedes(
      { authorId: AGENT.id, title: "Pipelines are a standard", body: "Extend the pipeline template, always.", kind: "standard" },
      [rule.id],
    );
    expect(corrected.kind).toBe("standard");
  });
});

describe("anyone can supersede another author's decision", () => {
  // The texts guard this, by design: "Never supersede someone else's standard
  // or decision: flag it with your evidence" (bab_learn, the skill) and "another's standard or
  // decision: flag only" (MCP instructions). The server does not check it.
  async function decision() {
    const { create } = await import("../lib/learnings");
    return create({
      authorId: OWNER.id,
      title: "Kafka over REST between services",
      body: "Services talk through events. Chosen for decoupling; REST rejected.",
      kind: "decision",
    });
  }

  it("through the library", async () => {
    await users();
    const old = await decision();
    const { createWithSupersedes, getById, findSupersededBy } = await import("../lib/learnings");
    const fixed = createWithSupersedes(
      { authorId: AGENT.id, title: "Kafka over REST, revised", body: "Events between services; REST only at the edge.", confirmNotDuplicate: true },
      [old.id],
    );
    expect(getById(old.id)!.status).toBe("archived");
    expect(findSupersededBy(old.id)!.id).toBe(fixed.id);
    expect(fixed.kind).toBe("decision"); // a correction keeps the kind it replaces
  });

  it("through bab_learn", async () => {
    await users();
    const old = await decision();
    const out = await tool("bab_learn", {
      title: "Kafka over REST, revised",
      body: "Events between services; REST only at the edge.",
      supersedes: old.id,
    });
    const { getById } = await import("../lib/learnings");
    expect(out.learning.supersedes_id).toBe(old.id);
    expect(getById(old.id)!.status).toBe("archived");
  });
});

describe("anyone can retire another author's standard", () => {
  // The texts guard this, by design: a standard is "retired by a maintainer
  // only" (bab_react); everyone else flags it with their evidence. The server only asks a
  // non-author for the one-line note, a required field, and does not check whose standard it is.
  async function standard() {
    const { create } = await import("../lib/learnings");
    return create({
      authorId: OWNER.id,
      title: "Services extend the shared pipeline template",
      body: "Every repository extends the shared pipeline template.",
      kind: "standard",
    });
  }

  it("through the library, with the note a non-author must give", async () => {
    await users();
    const std = await standard();
    const { retire, getById } = await import("../lib/learnings");
    expect(retire(std.id, AGENT.id, "mcp", "Replaced by template v2, azure-pipelines.yml 2026-10-02").status).toBe("archived");
    expect(getById(std.id)!.status).toBe("archived");
  });

  it("through bab_react", async () => {
    await users();
    const std = await standard();
    const out = await tool("bab_react", { learningId: std.id, action: "retire", note: "Replaced by template v2, azure-pipelines.yml 2026-10-02" });
    expect(out.learning.status).toBe("archived");
  });

  it("and can bring it back again with keep, with a note", async () => {
    await users();
    const std = await standard();
    await tool("bab_react", { learningId: std.id, action: "retire", note: "Replaced by template v2, azure-pipelines.yml 2026-10-02" });
    const out = await tool("bab_react", { learningId: std.id, action: "keep", note: "Still the rule: CLAUDE.md, 2026-10-02" });
    expect(out.learning.status).toBe("active");
  });
});
