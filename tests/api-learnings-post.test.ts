import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-api-learnings-post-test-"));
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

function mockNoIdentity() {
  vi.doMock("next/headers", () => ({ headers: async () => new Headers() }));
}

function mockAgentIdentity(email: string, name: string) {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "x-bab-actor-email": email, "x-bab-actor-name": name }),
  }));
}

function postReq(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request("http://x/api/learnings", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

describe("POST /api/learnings", () => {
  it("supersedes accepts an array and archives every listed learning", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob@example.com", email: "bob@example.com", name: "Bob", roles: [] });
    const { create, getById } = await import("../lib/learnings");
    const a = create({ authorId: "bob@example.com", title: "Alpha fact one", body: "First old fact about alpha." });
    const b = create({ authorId: "bob@example.com", title: "Zulu fact two", body: "Second old fact about zulu." });
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "Merged", body: "Alpha and zulu combined.", supersedes: [a.id, b.id] }) as never);
    expect(res.status).toBe(201);
    expect(getById(a.id)!.status).toBe("archived");
    expect(getById(b.id)!.status).toBe("archived");
  });

  it("one bad id in a supersedes array rejects everything and archives nothing", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob@example.com", email: "bob@example.com", name: "Bob", roles: [] });
    const { create, getById, search } = await import("../lib/learnings");
    const a = create({ authorId: "bob@example.com", title: "Alpha fact one", body: "First old fact about alpha." });
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "Merged", body: "Alpha combined.", supersedes: [a.id, "nope"] }) as never);
    expect(res.status).toBe(404);
    expect(getById(a.id)!.status).toBe("active");
    expect(search("Merged", {}, 5)).toHaveLength(0);
  });

  it('project "_general" means no project (null), not the key "general"', async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(
      postReq({ title: "Company rule", body: "Applies everywhere.", repo: "acme.api", project: "_general" }) as never,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).learning.project).toBeNull();
  });

  it("returns 401 without identity", async () => {
    mockNoIdentity();
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "T", body: "B" }) as never);
    expect(res.status).toBe(401);
  });

  it("happy path: creates a learning and returns 201", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(
      postReq({ title: "Use runTest.sh", body: "It wires up loggers.", tags: ["ci"], repo: "acme.api" }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.learning.title).toBe("Use runTest.sh");
    expect(body.learning.author_id).toBe("ada.t@example.com");
  });

  it("400s when title or body is missing", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "", body: "" }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("400s on an invalid confidence value", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "T", body: "B", confidence: "extreme" }) as never);
    expect(res.status).toBe(400);
  });

  // `sensitivity` was dropped (owner, 2026-09-21). Agents whose installed skill predates
  // that keep sending it, so it must be ignored rather than rejected.
  it("ignores a sensitivity field from an older agent instead of rejecting it", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "T", body: "B", sensitivity: "top-secret" }) as never);
    expect(res.status).toBe(201);
    expect(await res.json()).not.toHaveProperty("learning.sensitivity");
  });

  it("400s on a malformed expiresAt", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "T", body: "B", expiresAt: "next month" }) as never);
    expect(res.status).toBe(400);
  });

  it('accepts expiresAt "never" and stores no expiry', async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "House rule", body: "Never push trunk.", expiresAt: "never" }) as never);
    expect(res.status).toBe(201);
    expect((await res.json()).learning.expires_at).toBeNull();
  });

  it("runs supersede after create when supersedes is set", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const first = await POST(postReq({ title: "Old", body: "Old body" }) as never);
    const firstBody = await first.json();

    const second = await POST(
      postReq({ title: "New", body: "New body", supersedes: firstBody.learning.id }) as never,
    );
    expect(second.status).toBe(201);

    const { getById } = await import("../lib/learnings");
    expect(getById(firstBody.learning.id)!.status).toBe("archived");
  });

  it("404s when supersedes points at a learning that doesn't exist", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "T", body: "B", supersedes: "does-not-exist" }) as never);
    expect(res.status).toBe(404);
  });

  it("does NOT replay a 409: the same Idempotency-Key succeeds once the caller resolves the conflict", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const seed = await POST(postReq({ title: "UTM naming convention for campaigns", body: "Use source-medium-campaign in lowercase with hyphens.", tags: ["marketing"] }) as never);
    expect(seed.status).toBe(201);

    const dup = { title: "UTM naming convention for campaigns", body: "Lowercase source-medium-campaign, hyphenated.", tags: ["marketing"] };
    const first = await POST(postReq(dup, { "Idempotency-Key": "retry-me" }) as never);
    expect(first.status).toBe(409);

    const second = await POST(postReq({ ...dup, confirmNotDuplicate: true }, { "Idempotency-Key": "retry-me" }) as never);
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotent-Replayed")).toBeNull();

    const third = await POST(postReq({ ...dup, confirmNotDuplicate: true }, { "Idempotency-Key": "retry-me" }) as never);
    expect(third.status).toBe(201);
    expect(third.headers.get("Idempotent-Replayed")).toBe("true");
  });

  it("replays the same body and marks Idempotent-Replayed on a repeat Idempotency-Key", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");

    const first = await POST(postReq({ title: "T", body: "B" }, { "Idempotency-Key": "abc-123" }) as never);
    const firstBody = await first.json();
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();

    const second = await POST(postReq({ title: "Different", body: "Different" }, { "Idempotency-Key": "abc-123" }) as never);
    const secondBody = await second.json();

    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(secondBody).toEqual(firstBody);

    const { list } = await import("../lib/learnings");
    expect(list().length).toBe(1);
  });

  it("409s with { error, candidates } when the draft looks like a duplicate", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");

    await POST(
      postReq({
        title: "Use runTest.sh not dotnet test directly",
        body: "runTest.sh wires up loggers and coverage and starts dependency containers for integration tests.",
        tags: ["ci", "testing"],
      }) as never,
    );

    const res = await POST(
      postReq({
        title: "Use runTest.sh instead of dotnet test",
        body: "runTest.sh wires up loggers and coverage and starts dependency containers for integration tests.",
        tags: ["ci", "testing"],
      }) as never,
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("Looks like a duplicate");
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.length).toBeGreaterThan(0);

    const { list } = await import("../lib/learnings");
    expect(list().length).toBe(1);
  });

  it("201s when confirmNotDuplicate is set on an otherwise-duplicate draft", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");

    await POST(
      postReq({
        title: "Use runTest.sh not dotnet test directly",
        body: "runTest.sh wires up loggers and coverage and starts dependency containers for integration tests.",
        tags: ["ci", "testing"],
      }) as never,
    );

    const res = await POST(
      postReq({
        title: "Use runTest.sh instead of dotnet test",
        body: "runTest.sh wires up loggers and coverage and starts dependency containers for integration tests.",
        tags: ["ci", "testing"],
        confirmNotDuplicate: true,
      }) as never,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.learning.title).toBe("Use runTest.sh instead of dotnet test");

    const { list } = await import("../lib/learnings");
    expect(list().length).toBe(2);
  });
});

describe("POST /api/learnings kind and source fields", () => {
  const MIRROR_URL = "https://wiki.example.com/wiki/spaces/E/pages/9#r1";

  it("accepts kind, source, source_url, source_version and returns them on the learning", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(
      postReq({
        title: "Use one pipeline template",
        body: "Every repo extends the shared template.",
        kind: "standard",
        source: "confluence",
        source_url: MIRROR_URL,
        source_version: 4,
        expiresAt: "never",
      }) as never,
    );
    expect(res.status).toBe(201);
    const { learning } = await res.json();
    expect(learning).toMatchObject({ kind: "standard", source: "confluence", source_url: MIRROR_URL, source_version: 4, expires_at: null });
  });

  it("with no new fields still makes a learning/native entry", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "Plain note", body: "Nothing special." }) as never);
    expect(res.status).toBe(201);
    expect((await res.json()).learning).toMatchObject({ kind: "learning", source: "native", source_url: null, source_version: null });
  });

  it.each([
    [{ kind: "rule" }],
    [{ source: "confluence" }], // no url, no version
    [{ source_url: "https://wiki.example.com/wiki/x" }], // native refuses it
    [{ source: "confluence", source_url: "https://evil.com/wiki/x", source_version: 1 }],
    [{ source: "confluence", source_url: "https://wiki.example.com/wiki/x", source_version: "2" }],
    [{ sourceUrl: "https://wiki.example.com/wiki/x" }], // wrong spelling is loud, not ignored
  ])("%j is 400 and creates nothing", async (extra) => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "Bad fields", body: "Should not be stored.", ...extra }) as never);
    expect(res.status).toBe(400);
    const { list } = await import("../lib/learnings");
    expect(list({ status: "all" })).toHaveLength(0);
  });
});

describe("POST /api/learnings provenance edge cases", () => {
  const MIRROR_URL = "https://wiki.example.com/wiki/spaces/E/pages/9#r1";

  it("kind: null is treated as absent, not a 400", async () => {
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");
    const res = await POST(postReq({ title: "Null kind", body: "Kind sent as null.", kind: null }) as never);
    expect(res.status).toBe(201);
    expect((await res.json()).learning.kind).toBe("learning");
  });

  it("a correction through POST inherits kind and the source triple, also when the triple is sent as null", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "bob.t@example.com", email: "bob.t@example.com", name: "Bob", roles: [] });
    const { create } = await import("../lib/learnings");
    const old = create({
      authorId: "bob.t@example.com",
      title: "Pipelines extend one template",
      body: "Every repo extends the shared template.",
      kind: "standard",
      source: "confluence",
      sourceUrl: MIRROR_URL,
      sourceVersion: 4,
      expiresAt: null,
    });
    mockAgentIdentity("ada.t@example.com", "Ada");
    const { POST } = await import("../app/api/learnings/route");

    const first = await POST(
      postReq({ title: "Pipelines extend one shared template", body: "Corrected wording of the rule.", supersedes: old.id }) as never,
    );
    expect(first.status).toBe(201);
    const next = (await first.json()).learning;
    expect(next).toMatchObject({ kind: "standard", source: "confluence", source_url: MIRROR_URL, source_version: 4 });

    const second = await POST(
      postReq({
        title: "Pipelines extend the shared template",
        body: "A second correction with nulls on the wire.",
        supersedes: next.id,
        source_url: null,
        source_version: null,
      }) as never,
    );
    expect(second.status).toBe(201);
    expect((await second.json()).learning).toMatchObject({ kind: "standard", source: "confluence", source_url: MIRROR_URL, source_version: 4 });
  });
});
