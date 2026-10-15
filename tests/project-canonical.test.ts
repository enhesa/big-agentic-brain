import { useLegacyProxyNames } from "./db-legacy-names";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-canonical-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe("canonical project keys", () => {
  it("strips a leading acme. or acmecorp. and a trailing .git", async () => {
    const { normalizeProjectKey, canonicalProjectKey } = await import("../lib/project-key");
    expect(normalizeProjectKey("acme.bab")).toBe("bab");
    expect(canonicalProjectKey("Acme.BAB")).toBe("bab");
    expect(normalizeProjectKey("acme.widgets")).toBe("widgets");
    expect(normalizeProjectKey("acmecorp.bab")).toBe("bab");
    expect(normalizeProjectKey("bab.git")).toBe("bab");
    expect(normalizeProjectKey("acme.bab.git")).toBe("bab");
  });

  it("keeps a key that is only the prefix, and leaves other dots alone", async () => {
    const { normalizeProjectKey } = await import("../lib/project-key");
    expect(normalizeProjectKey("acme")).toBe("acme");
    expect(normalizeProjectKey("my.acme.thing")).toBe("my.acme.thing");
    expect(normalizeProjectKey("acmelike.thing")).toBe("acmelike.thing");
  });

  it("derives the same key from a repo slug, URL and scp form", async () => {
    const { deriveProjectFromRepo } = await import("../lib/project-key");
    expect(deriveProjectFromRepo("acme.bab")).toBe("bab");
    expect(deriveProjectFromRepo("acmecorp/acme.bab")).toBe("bab");
    expect(deriveProjectFromRepo("https://bitbucket.org/acmecorp/acme.bab.git")).toBe("bab");
    expect(deriveProjectFromRepo("git@bitbucket.org:acmecorp/acme.bab.git")).toBe("bab");
  });

  it("never lets the reserved _general survive normalisation", async () => {
    const { normalizeProjectKey, GENERAL_PROJECT_KEY } = await import("../lib/project-key");
    expect(normalizeProjectKey(GENERAL_PROJECT_KEY)).toBe("general");
  });
});

describe("projectKeyFromCwd", () => {
  it("uses the last segment on POSIX and Windows paths", async () => {
    const { projectKeyFromCwd } = await import("../lib/project-key");
    expect(projectKeyFromCwd("/home/x/acme/bab")).toBe("bab");
    expect(projectKeyFromCwd("C:\\Users\\x\\acme\\bab")).toBe("bab");
    expect(projectKeyFromCwd("C:\\Users\\x\\acme\\acme.bab\\")).toBe("bab");
    expect(projectKeyFromCwd("/home/x/acme/acme.widgets/")).toBe("widgets");
  });

  it("uses the repo before .claude/worktrees", async () => {
    const { projectKeyFromCwd } = await import("../lib/project-key");
    expect(projectKeyFromCwd("C:\\Users\\x\\acme\\bab\\.claude\\worktrees\\bab-plugin-memory-414621")).toBe("bab");
    expect(projectKeyFromCwd("/home/x/acme/acme.bab/.claude/worktrees/feature-a")).toBe("bab");
    expect(projectKeyFromCwd("/home/x/bab/.claude/worktrees/feature-a/app")).toBe("bab");
  });

  it("uses the folder after _worktrees as is", async () => {
    const { projectKeyFromCwd } = await import("../lib/project-key");
    expect(projectKeyFromCwd("/home/x/acme/_worktrees/acme-app-count-fix")).toBe("acme-app-count-fix");
    expect(projectKeyFromCwd("C:\\Users\\x\\acme\\_worktrees\\bab")).toBe("bab");
  });

  it("returns null for anything odd and never throws", async () => {
    const { projectKeyFromCwd } = await import("../lib/project-key");
    expect(projectKeyFromCwd(null)).toBeNull();
    expect(projectKeyFromCwd(undefined)).toBeNull();
    expect(projectKeyFromCwd("")).toBeNull();
    expect(projectKeyFromCwd("/")).toBeNull();
    expect(projectKeyFromCwd("/x/!!!")).toBeNull();
    expect(projectKeyFromCwd(42 as unknown as string)).toBeNull();
  });
});

describe("migration v22", () => {
  it("re-normalises stored projects, keeps repo text and NULL projects", async () => {
    const { getDb, _resetDbForTests } = await import("../lib/db");
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
    const db = getDb();
    const ins = db.prepare(
      "INSERT INTO learnings (id, author_id, title, body, repo, project, status) VALUES (?, 'author-1', 't', 'b', ?, ?, 'active')",
    );
    ins.run("l-old", "acmecorp/acme.bab", "acme.bab");
    ins.run("l-git", "x/y.git", "y.git");
    ins.run("l-ok", null, "bab");
    ins.run("l-null", "acmecorp/acme.bab", null);
    useLegacyProxyNames(db);
    db.prepare("DELETE FROM migrations WHERE version >= 22").run();
    _resetDbForTests();

    const again = (await import("../lib/db")).getDb();
    const rows = Object.fromEntries(
      (
        again.prepare("SELECT id, project, repo FROM learnings").all() as Array<{
          id: string;
          project: string | null;
          repo: string | null;
        }>
      ).map((r) => [r.id, r]),
    );
    expect(rows["l-old"].project).toBe("bab");
    expect(rows["l-old"].repo).toBe("acmecorp/acme.bab");
    expect(rows["l-git"].project).toBe("y");
    expect(rows["l-ok"].project).toBe("bab");
    expect(rows["l-null"].project).toBeNull();
    const v = again.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number };
    expect(v.v).toBeGreaterThanOrEqual(38); // the latest version, whatever it is now
  });
});

describe("a memory with no valid-until date", () => {
  it("stores NULL, reads as active, and is skipped by the sweep and the age info", async () => {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
    const { create, getById, expiryState, ageInfo, keepLearning, search } = await import("../lib/learnings");
    // An explicit null and an omitted expiresAt are the same thing: memories do not expire by default.
    const l = create({ authorId: "author-1", title: "House rule", body: "Never push trunk.", expiresAt: null });
    const plain = create({ authorId: "author-1", title: "Plain note", body: "Goes unread for a while." });
    expect(l.expires_at).toBeNull();
    expect(plain.expires_at).toBeNull();
    expect(expiryState(l)).toBe("active");
    expect(ageInfo(l).expiresInDays).toBeNull();
    expect(search("trunk")[0].expiresInDays).toBeNull();

    const { runMaintenance, _resetMaintenanceGuardForTests } = await import("../lib/maintenance");
    _resetMaintenanceGuardForTests();
    runMaintenance(true);
    expect(getById(l.id)!.status).toBe("active");
    expect(getById(plain.id)!.status).toBe("active");

    // Keeping a memory with no date must not put one on it.
    expect(keepLearning(l.id, "author-1").learning.expires_at).toBeNull();
  });
});

describe("resolveProjectFromCwd", () => {
  async function seed(...projects: string[]) {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "a@example.com", email: "a@example.com", name: "A", roles: [] });
    const { create } = await import("../lib/learnings");
    for (const project of projects) {
      create({ authorId: "a@example.com", title: `Note for ${project}`, body: `Fact about ${project}.`, project, confirmNotDuplicate: true });
    }
  }

  it("matches a _worktrees folder to the longest known project it starts with", async () => {
    await seed("bab", "bab-extra");
    const { resolveProjectFromCwd } = await import("../lib/learnings");
    expect(resolveProjectFromCwd("/home/x/acme/_worktrees/bab-fix-count")).toBe("bab");
    expect(resolveProjectFromCwd("/home/x/acme/_worktrees/bab-extra-fix")).toBe("bab-extra");
  });

  it("treats . and - as equal and needs a - boundary", async () => {
    await seed("claude.plugins", "ba");
    const { resolveProjectFromCwd } = await import("../lib/learnings");
    expect(resolveProjectFromCwd("/x/_worktrees/claude-plugins-bab-capture")).toBe("claude.plugins");
    expect(resolveProjectFromCwd("/x/_worktrees/bab-thing")).toBe("bab-thing");
  });

  it("keeps the candidate when nothing matches", async () => {
    await seed("bab");
    const { resolveProjectFromCwd } = await import("../lib/learnings");
    expect(resolveProjectFromCwd("/x/_worktrees/unknown-thing")).toBe("unknown-thing");
    expect(resolveProjectFromCwd(null)).toBeNull();
  });

  it("leaves an existing project's plain folder alone", async () => {
    await seed("bab", "bab-fix");
    const { resolveProjectFromCwd } = await import("../lib/learnings");
    expect(resolveProjectFromCwd("/x/acme/bab-fix")).toBe("bab-fix");
  });
});

/**
 * The hook asks for a session's project on every prompt (twice), and matching a worktree folder
 * against the projects in use reads them all. The answer is remembered per folder for 5 minutes;
 * a plain folder is answered from its name and never reads them.
 */
describe("resolveProjectFromCwd is remembered per folder for 5 minutes", () => {
  async function seed(...projects: string[]) {
    const { upsertUser } = await import("../lib/users");
    upsertUser({ id: "a@example.com", email: "a@example.com", name: "A", roles: [] });
    const { create } = await import("../lib/learnings");
    for (const project of projects) {
      create({ authorId: "a@example.com", title: `Note for ${project}`, body: `Fact about ${project}.`, project, confirmNotDuplicate: true });
    }
  }

  /** How many times the projects in use were read since the spy was set up. */
  async function spyOnProjectReads() {
    const { getDb } = await import("../lib/db");
    const spy = vi.spyOn(getDb(), "prepare");
    return {
      reads: () => spy.mock.calls.filter(([sql]) => String(sql).includes("GROUP BY project")).length,
      stop: () => spy.mockRestore(),
    };
  }

  it("looks the projects up once, then answers from memory until the 5 minutes are over", async () => {
    await seed("bab");
    const { resolveProjectFromCwd, CWD_PROJECT_TTL_MS } = await import("../lib/learnings");
    const probe = await spyOnProjectReads();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.parse("2026-10-02T12:00:00Z");
      vi.setSystemTime(start);
      const cwd = "/home/x/acme/_worktrees/bab-fix-count";
      expect(CWD_PROJECT_TTL_MS).toBe(5 * 60 * 1000);
      expect(resolveProjectFromCwd(cwd)).toBe("bab");
      expect(resolveProjectFromCwd(cwd)).toBe("bab");
      expect(probe.reads()).toBe(1);

      // A project that gets its first memory is noticed after the 5 minutes, not before.
      await seed("bab-fix");
      vi.setSystemTime(start + CWD_PROJECT_TTL_MS - 1000);
      expect(resolveProjectFromCwd(cwd)).toBe("bab");
      expect(probe.reads()).toBe(1);
      vi.setSystemTime(start + CWD_PROJECT_TTL_MS);
      expect(resolveProjectFromCwd(cwd)).toBe("bab-fix");
      expect(probe.reads()).toBe(2);
    } finally {
      vi.useRealTimers();
      probe.stop();
    }
  });

  it("keeps one answer per folder", async () => {
    await seed("bab", "bab-extra");
    const { resolveProjectFromCwd } = await import("../lib/learnings");
    const probe = await spyOnProjectReads();
    try {
      expect(resolveProjectFromCwd("/x/acme/_worktrees/bab-fix-count")).toBe("bab");
      expect(resolveProjectFromCwd("/x/acme/_worktrees/bab-extra-fix")).toBe("bab-extra");
      expect(resolveProjectFromCwd("/x/acme/_worktrees/bab-fix-count")).toBe("bab");
      expect(resolveProjectFromCwd("/x/acme/_worktrees/bab-extra-fix")).toBe("bab-extra");
      expect(probe.reads()).toBe(2);
    } finally {
      probe.stop();
    }
  });

  it("answers a plain folder from its name, without reading the projects at all", async () => {
    await seed("bab", "bab-fix");
    const { resolveProjectFromCwd } = await import("../lib/learnings");
    const probe = await spyOnProjectReads();
    try {
      for (let i = 0; i < 3; i++) {
        expect(resolveProjectFromCwd("/x/acme/bab-fix")).toBe("bab-fix");
        expect(resolveProjectFromCwd("C:\\Users\\x\\acme\\bab\\.claude\\worktrees\\feature-1")).toBe("bab");
      }
      expect(probe.reads()).toBe(0);
    } finally {
      probe.stop();
    }
  });

  it("is bounded: a flood of different folders pushes the oldest answers out", async () => {
    await seed("bab");
    const { resolveProjectFromCwd } = await import("../lib/learnings");
    const probe = await spyOnProjectReads();
    try {
      const folder = (i: number) => `/x/acme/_worktrees/bab-branch-${i}`;
      for (let i = 0; i < 600; i++) resolveProjectFromCwd(folder(i));
      expect(probe.reads()).toBe(600);
      resolveProjectFromCwd(folder(599)); // the newest is still remembered
      expect(probe.reads()).toBe(600);
      resolveProjectFromCwd(folder(0)); // the oldest was pushed out
      expect(probe.reads()).toBe(601);
    } finally {
      probe.stop();
    }
  });

  it("ignores an answer remembered against another database", async () => {
    await seed("bab");
    const { resolveProjectFromCwd } = await import("../lib/learnings");
    const { _resetDbForTests } = await import("../lib/db");
    const cwd = "/x/acme/_worktrees/bab-fix-count";
    expect(resolveProjectFromCwd(cwd)).toBe("bab");

    const elsewhere = mkdtempSync(path.join(tmpdir(), "bab-canonical-other-"));
    try {
      _resetDbForTests();
      process.env.DATA_DIR = elsewhere; // an empty database that knows no project
      expect(resolveProjectFromCwd(cwd)).toBe("bab-fix-count");
    } finally {
      _resetDbForTests();
      process.env.DATA_DIR = dataDir;
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
