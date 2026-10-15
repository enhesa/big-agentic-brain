import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-project-test-"));
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
}

describe("normalizeProjectKey", () => {
  it("lowercases and hyphenates inner whitespace/underscores", async () => {
    const { normalizeProjectKey } = await import("../lib/learnings");
    expect(normalizeProjectKey("Q4 ESG Campaign")).toBe("q4-esg-campaign");
    expect(normalizeProjectKey("client_onboarding flow")).toBe("client-onboarding-flow");
  });

  it("keeps dots and hyphens as-is", async () => {
    const { normalizeProjectKey } = await import("../lib/learnings");
    expect(normalizeProjectKey("export.api")).toBe("export.api");
  });

  it("strips characters outside [a-z0-9.-]", async () => {
    const { normalizeProjectKey } = await import("../lib/learnings");
    expect(normalizeProjectKey("Client (Q4)!")).toBe("client-q4");
    expect(normalizeProjectKey("Böb's Café")).toBe("bbs-caf");
  });

  it("is idempotent on an already-normalized value", async () => {
    const { normalizeProjectKey } = await import("../lib/learnings");
    expect(normalizeProjectKey("already-normalized.key")).toBe("already-normalized.key");
  });

  it("returns null for null, undefined or a blank/whitespace-only value", async () => {
    const { normalizeProjectKey } = await import("../lib/learnings");
    expect(normalizeProjectKey(null)).toBeNull();
    expect(normalizeProjectKey(undefined)).toBeNull();
    expect(normalizeProjectKey("")).toBeNull();
    expect(normalizeProjectKey("   ")).toBeNull();
  });

  it("treats the literal text 'null', 'undefined' or 'none' as no project (case/whitespace-insensitive)", async () => {
    const { normalizeProjectKey } = await import("../lib/learnings");
    expect(normalizeProjectKey("null")).toBeNull();
    expect(normalizeProjectKey("Null")).toBeNull();
    expect(normalizeProjectKey(" NULL ")).toBeNull();
    expect(normalizeProjectKey("undefined")).toBeNull();
    expect(normalizeProjectKey("None")).toBeNull();
  });

  it("rejects a non-empty value that normalizes to nothing", async () => {
    const { normalizeProjectKey } = await import("../lib/learnings");
    expect(() => normalizeProjectKey("!!!")).toThrow(/project/i);
    expect(() => normalizeProjectKey("@@@###")).toThrow(/project/i);
  });

  it("caps at 80 characters", async () => {
    const { normalizeProjectKey } = await import("../lib/learnings");
    const key = normalizeProjectKey("a".repeat(85));
    expect(key).toBe("a".repeat(80));
  });

  it("never leaves a trailing hyphen introduced by truncation to 80 chars", async () => {
    const { normalizeProjectKey } = await import("../lib/learnings");
    // 79 a's, a hyphen falling exactly on the 80th character, then more content.
    const raw = "a".repeat(79) + " " + "b".repeat(5);
    const key = normalizeProjectKey(raw)!;
    expect(key.endsWith("-")).toBe(false);
    expect(key.length).toBeLessThanOrEqual(80);
  });
});

describe("create - project field", () => {
  it("stores an explicit project, normalized", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "Campaign kickoff", body: "Notes.", project: "Q4 ESG Campaign" });
    expect(l.project).toBe("q4-esg-campaign");
  });

  it("derives project from repo's last path segment, stripping .git", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const l = create({
      authorId: "author-1",
      title: "Runbook note",
      body: "Deploy steps.",
      repo: "https://git.forge.example.com/forge/bab.git",
    });
    expect(l.project).toBe("bab");
  });

  it("derives project from an org/slug style repo with dots", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const l = create({
      authorId: "author-1",
      title: "Export API note",
      body: "NuGet restore needs the VPN.",
      repo: "acmecorp/acme.export.api",
    });
    expect(l.project).toBe("export.api");
  });

  it("does not let the derived project override an explicit one", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const l = create({
      authorId: "author-1",
      title: "Explicit wins",
      body: "Explicit project beats the repo-derived one.",
      repo: "https://git.forge.example.com/forge/bab.git",
      project: "Q4 ESG Campaign",
    });
    expect(l.project).toBe("q4-esg-campaign");
  });

  it("treats a literal 'null' project value the same as omitting it", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "Sent literal null", body: "Agent sent the text null.", project: "null" });
    expect(l.project).toBeNull();
  });

  it("leaves project null when neither project nor repo is set", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    const l = create({ authorId: "author-1", title: "Company-wide note", body: "No scope here." });
    expect(l.project).toBeNull();
  });

  it("rejects a project value that normalizes to nothing", async () => {
    await seedUsers();
    const { create } = await import("../lib/learnings");
    expect(() =>
      create({ authorId: "author-1", title: "Bad project", body: "Body text.", project: "!!!" }),
    ).toThrow(/project/i);
  });
});

describe("list/search - project filter", () => {
  it("list() filters to an exact project match", async () => {
    await seedUsers();
    const { create, list } = await import("../lib/learnings");
    create({ authorId: "author-1", title: "Alpha rollout notes", body: "Deploy steps for alpha.", project: "bab" });
    create({
      authorId: "author-1",
      title: "Beta rollout notes",
      body: "Deploy steps for beta.",
      project: "forge2",
      confirmNotDuplicate: true,
    });

    const rows = list({ project: "bab" });
    expect(rows.map((r) => r.title)).toEqual(["Alpha rollout notes"]);
  });

  it("search() combines project with tag and q", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");
    create({
      authorId: "author-1",
      title: "Deploy pipeline gotcha",
      body: "runTest.sh wires up containers for CI.",
      tags: ["engineering", "ci"],
      project: "bab",
    });
    create({
      authorId: "author-1",
      title: "Deploy pipeline gotcha elsewhere",
      body: "runTest.sh wires up containers for CI too.",
      tags: ["engineering", "ci"],
      project: "forge2",
      confirmNotDuplicate: true,
    });

    const results = search("runTest", { tag: "ci", project: "bab" });
    expect(results.length).toBe(1);
    expect(results[0].project).toBe("bab");
  });

  it("list()/search() filter to no-project memories via the GENERAL_PROJECT_KEY sentinel", async () => {
    await seedUsers();
    const { create, list, search, GENERAL_PROJECT_KEY } = await import("../lib/learnings");
    const general = create({ authorId: "author-1", title: "Company-wide note", body: "No scope here." });
    create({ authorId: "author-1", title: "Bab deploy notes", body: "Deploy steps for bab.", project: "bab" });

    const listed = list({ project: GENERAL_PROJECT_KEY });
    expect(listed.map((r) => r.id)).toEqual([general.id]);

    const searched = search("", { project: GENERAL_PROJECT_KEY });
    expect(searched.map((r) => r.id)).toEqual([general.id]);
  });

  it("search() falls back to list() (still project-filtered) when the query has no usable tokens", async () => {
    await seedUsers();
    const { create, search } = await import("../lib/learnings");
    create({ authorId: "author-1", title: "Alpha rollout notes", body: "Deploy steps for alpha.", project: "bab" });
    create({
      authorId: "author-1",
      title: "Beta rollout notes",
      body: "Deploy steps for beta.",
      project: "forge2",
      confirmNotDuplicate: true,
    });

    const results = search("", { project: "bab" });
    expect(results.map((r) => r.title)).toEqual(["Alpha rollout notes"]);
  });
});

describe("listProjects", () => {
  it("returns known projects with a count each, newest activity first", async () => {
    await seedUsers();
    const { create, listProjects } = await import("../lib/learnings");
    const bab1 = create({ authorId: "author-1", title: "Bab note one", body: "First note about bab.", project: "bab" });
    const forge = create({
      authorId: "author-1",
      title: "Deploy note",
      body: "A note about forge2.",
      project: "forge2",
      confirmNotDuplicate: true,
    });
    const bab2 = create({
      authorId: "author-1",
      title: "Bab note two",
      body: "Second note about bab.",
      project: "bab",
      confirmNotDuplicate: true,
    });

    // datetime('now') has second granularity; force distinct activity times
    // so the newest-first ordering is deterministic instead of flaking on ties.
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare("UPDATE learnings SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").run(bab1.id);
    db.prepare("UPDATE learnings SET updated_at = '2020-01-02 00:00:00' WHERE id = ?").run(forge.id);
    db.prepare("UPDATE learnings SET updated_at = '2020-01-03 00:00:00' WHERE id = ?").run(bab2.id);

    const projects = listProjects();
    expect(projects.map((p) => p.project)).toEqual(["bab", "forge2"]);
    expect(projects.find((p) => p.project === "bab")?.count).toBe(2);
    expect(projects.find((p) => p.project === "forge2")?.count).toBe(1);
  });

  it("excludes learnings with no project and archived/deleted ones", async () => {
    await seedUsers();
    const { create, listProjects, supersede } = await import("../lib/learnings");
    create({ authorId: "author-1", title: "No project note", body: "Company-wide, no project." });
    const oldOne = create({ authorId: "author-1", title: "Old bab note", body: "Stale note.", project: "bab" });
    const newOne = create({
      authorId: "author-1",
      title: "New bab note",
      body: "Replacement note.",
      project: "bab",
      supersedesId: oldOne.id,
    });
    supersede(newOne.id, oldOne.id, "author-1");

    const projects = listProjects();
    expect(projects).toEqual([{ project: "bab", count: 1, lastActivityAt: expect.any(String) }]);
  });
});

describe("v9 backfill", () => {
  it("gives existing engineering memories a project from their repo", async () => {
    // A database that predates the project column: insert with repo only, then force the
    // migration to run again from v8 so the backfill is what fills `project` in.
    const { getDb } = await import("../lib/db");
    const db = getDb();
    db.prepare("INSERT INTO users (id, email, name) VALUES ('u1', 'a.b@example.com', 'A B')").run();
    db.prepare(
      "INSERT INTO learnings (id, author_id, title, body, tags, repo, project, status) VALUES (?, 'u1', ?, 'b', '[]', ?, NULL, 'active')",
    ).run("l-old", "old one", "https://git.forge.example.com/forge/bab.git");
    // Every row from 9 up: the runner takes the highest applied version, so leaving 10
    // in place would keep v9 from re-running at all.
    db.prepare("DELETE FROM migrations WHERE version >= 9").run();

    const { _resetDbForTests } = await import("../lib/db");
    _resetDbForTests();
    const again = (await import("../lib/db")).getDb();
    const row = again.prepare("SELECT project FROM learnings WHERE id = 'l-old'").get() as { project: string | null };
    expect(row.project).toBe("bab");
  });
});

describe("company-wide learnings", () => {
  it("an explicit project: null keeps a guardrail unscoped even when a repo is given", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "a.b@example.com", email: "a.b@example.com", name: "A B", roles: [] });
    const { create } = await import("../lib/learnings");
    const guardrail = create({
      authorId: "a.b@example.com",
      title: "Never commit secrets, use the vault",
      body: "Applies everywhere, not just here.",
      tags: ["security"],
      repo: "https://git.forge.example.com/forge/bab.git",
      project: null,
    });
    expect(guardrail.project).toBeNull();

    // Omitting it still inherits the repo, which is what makes the explicit null needed.
    const scoped = create({
      authorId: "a.b@example.com",
      title: "Deploy step that only applies here",
      body: "Project specific.",
      tags: ["engineering"],
      repo: "https://git.forge.example.com/forge/bab.git",
    });
    expect(scoped.project).toBe("bab");
  });
});
