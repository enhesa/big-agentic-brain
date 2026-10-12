import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Requests built in tests carry no Host header; links come from the configured origin.
process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * Every change to someone else's memory carries a one-line evidence note (owner, 2026-10-02).
 * A flag through the agent paths (MCP and REST, via "mcp") needs one; the web path (via "ui")
 * keeps the note optional, as before.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-flag-note-required-test-"));
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

let n = 0;
async function seed() {
  n += 1;
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author.t@example.com", email: "author.t@example.com", name: "Author", roles: [] });
  upsertUser({ id: "flagger.t@example.com", email: "flagger.t@example.com", name: "Flagger", roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId: "author.t@example.com", title: `Gotcha ${n} zq${n}`, body: `A body ${n} about zq${n}x`, confirmNotDuplicate: true });
}

function mockIdentity(email: string, name: string) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": name }),
  }));
}

async function flagRows(id: string) {
  const { getDb } = await import("../lib/db");
  return getDb().prepare("SELECT voter_id, note FROM votes WHERE learning_id = ? AND kind = 'flag'").all(id) as { voter_id: string; note: string | null }[];
}

describe("flag() in lib/learnings", () => {
  it("via mcp, a missing, null, empty or blank note is refused and no flag is stored", async () => {
    const l = await seed();
    const { flag } = await import("../lib/learnings");
    const { ValidationError } = await import("../lib/errors");
    for (const n of [undefined, null, "", "   "]) {
      expect(() => flag(l.id, "flagger.t@example.com", "mcp", n as string | null | undefined)).toThrow(ValidationError);
    }
    expect(() => flag(l.id, "flagger.t@example.com", "mcp")).toThrow(/note is required/);
    expect(await flagRows(l.id)).toEqual([]);
  });

  it("via mcp, a note is accepted, redacted and capped at 300", async () => {
    const l = await seed();
    const { flag } = await import("../lib/learnings");
    flag(l.id, "flagger.t@example.com", "mcp", "moved to src/x.ts token=abc123secretvalue 2026-10-02");
    const rows = await flagRows(l.id);
    expect(rows[0].note).toContain("[redacted]");
    expect(rows[0].note).not.toContain("abc123");
    const other = await seed();
    expect(() => flag(other.id, "flagger.t@example.com", "mcp", "a".repeat(301))).toThrow(/300 characters/);
  });

  it("via ui, the note stays optional", async () => {
    const l = await seed();
    const { flag } = await import("../lib/learnings");
    flag(l.id, "flagger.t@example.com", "ui");
    expect(await flagRows(l.id)).toEqual([{ voter_id: "flagger.t@example.com", note: null }]);
  });

  it("flagging your own learning is still a 403 before the note is looked at", async () => {
    const l = await seed();
    const { flag } = await import("../lib/learnings");
    const { ForbiddenError } = await import("../lib/errors");
    expect(() => flag(l.id, "author.t@example.com", "mcp")).toThrow(ForbiddenError);
  });
});

describe("POST /api/learnings/[id]/flag", () => {
  function req(body?: unknown) {
    return new Request("http://x/flag", {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  it("400s without a note, whether the body is missing, empty or has a blank note", async () => {
    const l = await seed();
    mockIdentity("flagger.t@example.com", "Flagger");
    const { POST } = await import("../app/api/learnings/[id]/flag/route");
    for (const body of [undefined, {}, { note: "" }, { note: "  " }]) {
      const res = await POST(req(body) as never, { params: Promise.resolve({ id: l.id }) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/note is required/);
    }
    expect(await flagRows(l.id)).toEqual([]);
  });

  it("200s with a note and stores it", async () => {
    const l = await seed();
    mockIdentity("flagger.t@example.com", "Flagger");
    const { POST } = await import("../app/api/learnings/[id]/flag/route");
    const res = await POST(req({ note: "moved to src/x.ts, 2026-10-02" }) as never, { params: Promise.resolve({ id: l.id }) });
    expect(res.status).toBe(200);
    expect(await flagRows(l.id)).toEqual([{ voter_id: "flagger.t@example.com", note: "moved to src/x.ts, 2026-10-02" }]);
  });
});

describe("bab_react flag", () => {
  async function react(args: Record<string, unknown>) {
    mockIdentity("flagger.t@example.com", "Flagger");
    const { POST } = await import("../app/mcp/route");
    const res = await POST(
      new Request("https://bab.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bab_react", arguments: args } }),
      }),
    );
    return res.json();
  }

  it("without a note is an error result and stores nothing", async () => {
    const l = await seed();
    const out = await react({ learningId: l.id, action: "flag" });
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0].text).toMatch(/note is required/);
    expect(await flagRows(l.id)).toEqual([]);
  });

  it("with a note flags", async () => {
    const l = await seed();
    const out = await react({ learningId: l.id, action: "flag", note: "the service was removed, azure-pipelines.yml" });
    expect(out.result.isError).toBeFalsy();
    expect(await flagRows(l.id)).toEqual([{ voter_id: "flagger.t@example.com", note: "the service was removed, azure-pipelines.yml" }]);
  });

  it("retire without a note by a non-author is an error result; with a note it archives", async () => {
    const l = await seed();
    const bad = await react({ learningId: l.id, action: "retire" });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/note is required/);
    const ok = await react({ learningId: l.id, action: "retire", note: "Checked, the pipeline was deleted" });
    expect(ok.result.isError).toBeFalsy();
    expect(JSON.parse(ok.result.content[0].text).learning.status).toBe("archived");
  });
});
