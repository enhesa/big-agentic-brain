import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The retire is visible (owner review, 2026-10-02). The latest retire or restore of a memory (who,
 * when, why) is its own field, lastRetire: on the memory page, in GET /api/learnings/:id and in
 * every search hit. It does not take one of the five shared note slots of recentNotes, so later
 * confirmations and flags cannot push it out and hide why a memory was archived.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-last-retire-test-"));
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

async function seedUsers(extra = 0) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
  upsertUser({ id: "voter-1", email: "b@example.com", name: "Bob", roles: [] });
  upsertUser({ id: "voter-2", email: "c@example.com", name: "Cid", roles: [] });
  for (let i = 1; i <= extra; i++) upsertUser({ id: `x-${i}`, email: `x${i}@example.com`, name: `Extra ${i}`, roles: [] });
}

let seq = 0;
async function mk(over: Record<string, unknown> = {}) {
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({
    authorId: "author-1",
    title: `Fixture ${seq} zq${seq}`,
    body: `Body ${seq} about topic zq${seq}x`,
    confirmNotDuplicate: true,
    ...over,
  });
}

describe("lastRetire", () => {
  it("is who, when and why for a retired memory, and nothing for one that never was", async () => {
    await seedUsers();
    const l = await mk();
    const other = await mk();
    const { retire, lastRetire, lastRetiresFor, getById } = await import("../lib/learnings");
    expect(lastRetire(l)).toBeUndefined();
    const out = retire(l.id, "voter-1", "mcp", "Replaced by the new pipeline, azure-pipelines.yml 2026-10-02");
    expect(lastRetire(out)).toEqual({
      kind: "retire",
      voterName: "Bob",
      note: "Replaced by the new pipeline, azure-pipelines.yml 2026-10-02",
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });
    const page = lastRetiresFor([getById(l.id)!, getById(other.id)!]);
    expect([...page.keys()]).toEqual([l.id]);
  });

  it("an author's retire without a note has a null note", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, lastRetire } = await import("../lib/learnings");
    expect(lastRetire(retire(l.id, "author-1", "mcp"))).toMatchObject({ kind: "retire", voterName: "Ada", note: null });
  });

  it("is still there after five later confirmations and flags filled the shared note list", async () => {
    await seedUsers(6);
    const l = await mk();
    const { retire, confirm, flag, lastRetire, recentNotes, RECENT_NOTES_LIMIT } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Gone from main, 2026-10-02");
    for (let i = 1; i <= 3; i++) confirm(l.id, `x-${i}`, `src/c${i}.ts, 2026-10-02`);
    for (let i = 4; i <= 6; i++) flag(l.id, `x-${i}`, "mcp", `flag note ${i}`);
    const notes = recentNotes(l.id);
    expect(notes).toHaveLength(RECENT_NOTES_LIMIT);
    expect(notes.some((n) => (n.kind as string) === "retire")).toBe(false);
    expect(lastRetire({ id: l.id, status: "archived" })).toMatchObject({ kind: "retire", voterName: "Bob", note: "Gone from main, 2026-10-02" });
  });

  it("follows the newest event: retire, restore, retire again, all inside one second", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning, lastRetire, getById } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "First retire");
    expect(lastRetire(getById(l.id)!)).toMatchObject({ kind: "retire", note: "First retire" });

    keepLearning(l.id, "voter-2", "mcp", "Still true: src/a.ts, 2026-10-02");
    expect(lastRetire(getById(l.id)!)).toMatchObject({ kind: "restore", voterName: "Cid", note: "Still true: src/a.ts, 2026-10-02" });

    retire(l.id, "voter-1", "mcp", "Second retire");
    expect(lastRetire(getById(l.id)!)).toMatchObject({ kind: "retire", voterName: "Bob", note: "Second retire" });
  });

  it("does not say restore once the memory is archived again by flags", async () => {
    await seedUsers(2);
    const l = await mk();
    const { retire, keepLearning, flag, lastRetire, search, getById } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "First retire");
    keepLearning(l.id, "voter-2", "mcp", "Still true: src/a.ts, 2026-10-02");
    expect(lastRetire(getById(l.id)!)).toMatchObject({ kind: "restore" });

    flag(l.id, "x-1", "mcp", "Gone again, 2026-10-02");
    flag(l.id, "x-2", "mcp", "Gone again too, 2026-10-02");
    expect(getById(l.id)!.status).toBe("archived");
    expect(lastRetire(getById(l.id)!)).toBeUndefined();
    const [hit] = search("", { status: "archived" });
    expect(hit.id).toBe(l.id);
    expect(hit.lastRetire).toBeUndefined();
  });

  it("is gone with a deleted memory", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, deleteOwn, lastRetire, search } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Looked stale");
    const deleted = deleteOwn(l.id, "author-1", "mcp");
    expect(lastRetire(deleted)).toBeUndefined();
    const [hit] = search("", { status: "all" });
    expect(hit.id).toBe(l.id);
    expect(JSON.stringify(hit)).not.toContain("Looked stale");
  });
});

describe("search hits carry lastRetire", () => {
  it("on the full-text path and on the plain listing, only for the memories that have one", async () => {
    await seedUsers();
    const a = await mk({ title: "Kafka batch limits", body: "Keep batches under 200KB." });
    const b = await mk({ title: "Kafka retry policy", body: "Retry with backoff." });
    const { retire, search } = await import("../lib/learnings");
    retire(a.id, "voter-1", "mcp", "Limits moved to the broker config, 2026-10-02");

    const fts = search("kafka", { status: "all" });
    const byId = new Map(fts.map((h) => [h.id, h]));
    expect(byId.get(a.id)!.lastRetire).toMatchObject({ kind: "retire", voterName: "Bob", note: "Limits moved to the broker config, 2026-10-02" });
    expect(byId.get(b.id)!.lastRetire).toBeUndefined();
    expect("lastRetire" in JSON.parse(JSON.stringify(byId.get(b.id)))).toBe(false);

    const plain = search("", { status: "all" });
    expect(plain.find((h) => h.id === a.id)!.lastRetire).toMatchObject({ kind: "retire", voterName: "Bob" });
    expect(plain.find((h) => h.id === b.id)!.lastRetire).toBeUndefined();
  });

  it("the note is carried but is still not searchable: the full-text index covers title, body and tags only", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, search } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "SENTINEL-RETIRE-NOTE-9921 checked");
    expect(search("SENTINEL-RETIRE-NOTE-9921", { status: "all" })).toEqual([]);
    expect(JSON.stringify(search("", { status: "all" }))).toContain("SENTINEL-RETIRE-NOTE-9921");
  });

  it("a restored memory is active again and its hit says it was restored", async () => {
    await seedUsers();
    const l = await mk();
    const { retire, keepLearning, search } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Looked stale");
    keepLearning(l.id, "voter-2", "mcp", "Rechecked, still in the repo");
    const [hit] = search("", {});
    expect(hit).toMatchObject({ id: l.id, status: "active", lastRetire: { kind: "restore", voterName: "Cid", note: "Rechecked, still in the repo" } });
  });
});

describe("GET /api/learnings and /api/learnings/:id", () => {
  function mockAgentIdentity() {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "x-bab-actor-email": "reader.t@example.com", "x-bab-actor-name": "Reader" }),
    }));
  }

  it("the list carries lastRetire on an archived hit", async () => {
    await seedUsers();
    const l = await mk();
    const { retire } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Replaced, see docs/x.md");
    mockAgentIdentity();
    const { GET } = await import("../app/api/learnings/route");
    const { NextRequest } = await import("next/server");
    const json = await (await GET(new NextRequest("http://x/api/learnings?status=archived"))).json();
    expect(json.results).toHaveLength(1);
    expect(json.results[0].lastRetire).toMatchObject({ kind: "retire", voterName: "Bob", note: "Replaced, see docs/x.md" });
  });

  it("the single read has lastRetire next to recentNotes, which holds confirmations and flags only", async () => {
    await seedUsers(2);
    const l = await mk();
    const { retire, confirm } = await import("../lib/learnings");
    retire(l.id, "voter-1", "mcp", "Replaced, see docs/x.md");
    confirm(l.id, "x-1", "src/a.ts, 2026-10-02");
    mockAgentIdentity();
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request(`http://x/api/learnings/${l.id}`) as never, { params: Promise.resolve({ id: l.id }) });
    const body = await res.json();
    expect(body.lastRetire).toMatchObject({ kind: "retire", voterName: "Bob", note: "Replaced, see docs/x.md" });
    expect(body.recentNotes).toEqual([expect.objectContaining({ kind: "confirm" })]);
  });

  it("the single read has no lastRetire key for a memory that was never retired", async () => {
    await seedUsers();
    const l = await mk();
    mockAgentIdentity();
    const { GET } = await import("../app/api/learnings/[id]/route");
    const res = await GET(new Request(`http://x/api/learnings/${l.id}`) as never, { params: Promise.resolve({ id: l.id }) });
    expect("lastRetire" in (await res.json())).toBe(false);
  });
});
