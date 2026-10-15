import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-round3-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

async function seedUser(id: string) {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id, email: id, name: id, roles: [] });
}

describe("canonicalise is idempotent", () => {
  it("strips stacked prefixes in one pass", async () => {
    const { normalizeProjectKey } = await import("../lib/project-key");
    expect(normalizeProjectKey("acme.acme.bab")).toBe("bab");
    expect(normalizeProjectKey("acmecorp.acme.bab.git")).toBe("bab");
  });

  it("canonicalising twice equals once", async () => {
    const { normalizeProjectKey } = await import("../lib/project-key");
    for (const x of ["acme.acme.bab", "acme.bab.git", "acme", "a.git.git", "acmecorp.acmecorp.x"]) {
      const once = normalizeProjectKey(x);
      expect(normalizeProjectKey(once)).toBe(once);
    }
  });
});

describe("resolveProjectFromCwd only prefix-matches inside a worktree", () => {
  it("a plain folder acme-app does not resolve to project acme", async () => {
    await seedUser("a@example.com");
    const { create, resolveProjectFromCwd } = await import("../lib/learnings");
    create({ authorId: "a@example.com", title: "Acme note", body: "A fact about acme.", project: "acme" });
    expect(resolveProjectFromCwd("/home/x/acme/acme-app")).toBe("acme-app");
    expect(resolveProjectFromCwd("/home/x/acme/_worktrees/acme-app-count-fix")).toBe("acme");
  });

  it("a .claude/worktrees cwd still resolves through its repo folder", async () => {
    await seedUser("a@example.com");
    const { create, resolveProjectFromCwd } = await import("../lib/learnings");
    create({ authorId: "a@example.com", title: "Bab note", body: "A fact about bab.", project: "bab" });
    expect(resolveProjectFromCwd("/x/bab/.claude/worktrees/some-branch")).toBe("bab");
  });
});

describe("consolidation atomicity", () => {
  async function two() {
    await seedUser("bob@example.com");
    await seedUser("ada@example.com");
    const { create } = await import("../lib/learnings");
    const a = create({ authorId: "bob@example.com", title: "Alpha fact one", body: "First old fact about alpha." });
    const b = create({ authorId: "bob@example.com", title: "Zulu fact two", body: "Second old fact about zulu." });
    return { a, b };
  }

  it("rejects an id that is already superseded, and creates nothing", async () => {
    const { a, b } = await two();
    const { createWithSupersedes, getById, search } = await import("../lib/learnings");
    const first = createWithSupersedes({ authorId: "ada@example.com", title: "Merged one", body: "Alpha replaced." }, [a.id], "mcp");
    expect(getById(a.id)!.status).toBe("archived");
    let err: unknown;
    try {
      createWithSupersedes({ authorId: "ada@example.com", title: "Merged two", body: "Alpha and zulu again." }, [b.id, a.id], "mcp");
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe(`Learning ${a.id} is already superseded by ${first.id}`);
    expect((err as { status: number }).status).toBe(409);
    expect(getById(b.id)!.status).toBe("active");
    expect(search("Merged two", {}, 5).filter((r) => r.title === "Merged two")).toHaveLength(0);
  });

  it("rolls back the new learning and earlier archives if a later supersede fails", async () => {
    const { a, b } = await two();
    const learnings = await import("../lib/learnings");
    const { getDb } = await import("../lib/db");
    // Make the second link insert fail so the loop dies midway.
    getDb().exec(
      `CREATE TRIGGER boom BEFORE INSERT ON supersession_links WHEN NEW.old_id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'boom'); END;`,
    );
    expect(() =>
      learnings.createWithSupersedes({ authorId: "ada@example.com", title: "Merged", body: "Both." }, [a.id, b.id], "mcp"),
    ).toThrow();
    expect(learnings.getById(a.id)!.status).toBe("active");
    expect(learnings.search("Merged", {}, 5)).toHaveLength(0);
  });
});

describe("raw length cap before redaction", () => {
  it("create() rejects an absurdly long body without running redact on it", async () => {
    await seedUser("a@example.com");
    const { create } = await import("../lib/learnings");
    const t0 = performance.now();
    expect(() => create({ authorId: "a@example.com", title: "T", body: "_".repeat(2_000_000) })).toThrow(/8000/);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
