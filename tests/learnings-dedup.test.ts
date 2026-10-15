import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-learnings-dedup-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seedUsers() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
  upsertUser({ id: "author-2", email: "b@example.com", name: "Bob", roles: [] });
}

describe("learnings.create dedup guard", () => {
  it("throws ConflictError with candidates when a near-duplicate already exists", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const { ConflictError } = await import("../lib/errors");

    create({
      authorId: "author-1",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage and starts dependency containers for integration tests.",
      tags: ["engineering", "ci"],
    });

    let thrown: unknown;
    try {
      create({
        authorId: "author-2",
        title: "Always use runTest.sh not dotnet test",
        body: "runTest.sh wires up loggers and coverage, starts dependency containers for integration tests.",
        tags: ["engineering", "ci"],
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ConflictError);
    const err = thrown as InstanceType<typeof ConflictError>;
    expect(Array.isArray(err.candidates)).toBe(true);
    expect((err.candidates as { verdict: string }[]).some((c) => c.verdict === "duplicate")).toBe(true);
  });

  it("allows a create about a clearly different topic", async () => {
    await seedUsers();
    const { create, list } = await import("../lib/learnings");

    create({
      authorId: "author-1",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage for CI.",
      tags: ["engineering", "ci"],
    });

    const second = create({
      authorId: "author-2",
      title: "Python images only ship 3-slim in ACR",
      body: "No alpine, no 3.11+, other tags fail with manifest unknown.",
      tags: ["it", "python"],
    });

    expect(second.title).toBe("Python images only ship 3-slim in ACR");
    expect(list().length).toBe(2);
  });

  it("supersedes bypasses the duplicate check even for a near-identical draft", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");

    const first = create({
      authorId: "author-1",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage for CI.",
      tags: ["engineering", "ci"],
    });

    const second = create({
      authorId: "author-2",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage for CI.",
      tags: ["engineering", "ci"],
      supersedesId: first.id,
    });

    expect(second.id).not.toBe(first.id);
  });

  it("confirmNotDuplicate bypasses the check and writes an audit action listing the overridden candidates", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");

    const first = create({
      authorId: "author-1",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage for CI, starts dependency containers.",
      tags: ["engineering", "ci"],
    });

    const second = create({
      authorId: "author-2",
      title: "Always use runTest.sh not dotnet test",
      body: "runTest.sh wires up loggers and coverage for CI, starts dependency containers.",
      tags: ["engineering", "ci"],
      confirmNotDuplicate: true,
    });

    expect(second.id).not.toBe(first.id);

    const db = getDb();
    const rows = db
      .prepare(
        "SELECT * FROM audit_log WHERE entity_id = ? AND action = 'create_confirmed_not_duplicate'",
      )
      .all(second.id) as { action: string; details: string | null }[];
    expect(rows.length).toBe(1);
    expect(rows[0].details).toContain(first.id);
    expect(JSON.parse(rows[0].details ?? "{}").overriddenCandidateIds).toContain(first.id);
  });

  it("audits create_rejected_duplicate with candidate ids when the guard throws 409", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const { ConflictError } = await import("../lib/errors");

    const first = create({
      authorId: "author-1",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage for CI, starts dependency containers.",
      tags: ["engineering", "ci"],
    });

    let thrown: unknown;
    try {
      create({
        authorId: "author-2",
        title: "Always use runTest.sh not dotnet test",
        body: "runTest.sh wires up loggers and coverage for CI, starts dependency containers.",
        tags: ["engineering", "ci"],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictError);

    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM audit_log WHERE action = 'create_rejected_duplicate'")
      .all() as { details: string | null }[];
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].details ?? "{}").candidateIds).toContain(first.id);
  });

  it("ignores archived and expired candidates when checking for duplicates", async () => {
    await seedUsers();
    const { create, supersede } = await import("../lib/learnings");

    const original = create({
      authorId: "author-1",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage for CI.",
      tags: ["engineering", "ci"],
    });

    const correction = create({
      authorId: "author-2",
      title: "Correction: runTest.sh setup",
      body: "Totally unrelated replacement body content about something else entirely.",
      tags: ["engineering"],
    });
    supersede(correction.id, original.id, "author-2");

    // original is now archived; posting the same content again should not conflict
    const third = create({
      authorId: "author-1",
      title: "Use runTest.sh instead of dotnet test",
      body: "runTest.sh wires up loggers and coverage for CI.",
      tags: ["engineering", "ci"],
    });

    expect(third.id).not.toBe(original.id);

    const expired = create({
      authorId: "author-1",
      title: "Expired learning about widgets",
      body: "Widgets need calibration every quarter for accuracy.",
      tags: ["ops"],
      expiresAt: "2000-01-01",
    });
    // expired.status is still "active" in storage (status field distinct from
    // expiry state); simulate a fully retired one directly via archived status
    // through supersede so it's excluded from the dedup scan.
    const replacement = create({
      authorId: "author-2",
      title: "Widgets calibration replacement note",
      body: "Different content entirely, nothing like the widgets note.",
      tags: ["ops"],
    });
    supersede(replacement.id, expired.id, "author-2");

    const fourth = create({
      authorId: "author-1",
      title: "Expired learning about widgets",
      body: "Widgets need calibration every quarter for accuracy.",
      tags: ["ops"],
    });
    expect(fourth.id).not.toBe(expired.id);
  });
});

describe("learnings.findSimilar tag-only fallback", () => {
  it("falls back to tag overlap >= 0.5 when the draft has no usable title/body tokens", async () => {
    await seedUsers();
    const { create, findSimilar } = await import("../lib/learnings");

    // Title/body below the 3-char / stopword floor produce zero tokens.
    const existing = create({
      authorId: "author-1",
      title: "ok ok",
      body: "ok ok ok",
      tags: ["engineering", "ci", "kubernetes"],
      confirmNotDuplicate: true,
    });

    const matches = findSimilar({
      title: "ok ok",
      body: "ok ok ok",
      tags: ["engineering", "ci", "kubernetes"],
    });

    expect(matches.map((m) => m.id)).toContain(existing.id);
  });

  it("returns nothing when the draft has no tokens and no tags", async () => {
    await seedUsers();
    const { findSimilar } = await import("../lib/learnings");
    expect(findSimilar({ title: "ok", body: "ok" })).toEqual([]);
  });

  it("does not fall back to tag overlap below 0.5", async () => {
    await seedUsers();
    const { create, findSimilar } = await import("../lib/learnings");
    create({
      authorId: "author-1",
      title: "ok ok",
      body: "ok ok ok",
      tags: ["engineering", "ci", "kubernetes", "azure"],
      confirmNotDuplicate: true,
    });

    // Only 1 of 4 candidate tags overlaps => jaccard well below 0.5.
    const matches = findSimilar({ title: "ok", body: "ok", tags: ["engineering"] });
    expect(matches.length).toBe(0);
  });
});

describe("findSimilar candidate selection", () => {
  it("finds an older true duplicate when 20 newer rows share a common token", async () => {
    await seedUsers();
    const { create, findSimilar } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const dup = create({
      authorId: "author-1",
      title: "Rotate the kafka consumer offsets after a schema change",
      body: "Reset offsets with the admin tool after a schema change so the consumer group replays cleanly.",
      tags: ["kafka"],
    });
    for (let i = 0; i < 20; i++) {
      create({
        authorId: "author-2",
        title: `Unrelated kafka note number ${i}`,
        body: `Something else entirely about topic ${i} and partitions.`,
        confirmNotDuplicate: true,
      });
    }
    getDb().prepare("UPDATE learnings SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(dup.id);

    const found = findSimilar({
      title: "Rotate the kafka consumer offsets after a schema change",
      body: "Reset offsets with the admin tool after a schema change so the consumer group replays cleanly.",
      tags: ["kafka"],
    });
    expect(found[0]?.id).toBe(dup.id);
    expect(found[0]?.verdict).toBe("duplicate");
  });

  it("takes candidates from the draft's project first", async () => {
    await seedUsers();
    const { create, findSimilar } = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    const dup = create({
      authorId: "author-1",
      title: "Deploy needs the vault token refreshed first",
      body: "Refresh the vault token before every deploy or the pod fails to start.",
      project: "alpha",
    });
    for (let i = 0; i < 25; i++) {
      create({
        authorId: "author-2",
        title: `Deploy note ${i} vault token`,
        body: `Deploy detail ${i} about the vault token and the pod.`,
        project: "beta",
        confirmNotDuplicate: true,
      });
    }
    getDb().prepare("UPDATE learnings SET created_at = '2020-01-01 00:00:00' WHERE id = ?").run(dup.id);
    const found = findSimilar({
      title: "Deploy needs the vault token refreshed first",
      body: "Refresh the vault token before every deploy or the pod fails to start.",
      project: "alpha",
    });
    expect(found[0]?.id).toBe(dup.id);
  });
});
