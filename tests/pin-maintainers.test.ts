import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.BAB_PUBLIC_ORIGIN = "https://bab.example.com";

/**
 * Who may pin a house rule (GitHub issue #7). A pinned rule goes into every agent's first prompt,
 * so with BAB_MAINTAINERS set only a maintainer may pin or unpin (403, like a feedback status
 * change). With none configured it stays an honour system. Every successful pin records
 * pinned_by and pinned_at; an unpin clears both. The only entry point is bab_react (MCP); there
 * is no REST route for it, so the library function and the tool are what is tested.
 */

const MAINTAINER = "maintainer.one@example.com";
const OTHER = "bob.other@example.com";
const AUTHOR = "ada.author@example.com";
const REFUSAL = "Only maintainers can pin or unpin";

let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-pin-maint-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  const { upsertUser } = await import("../lib/users");
  for (const id of [MAINTAINER, OTHER, AUTHOR]) upsertUser({ id, email: id, name: id, roles: [] });
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.BAB_MAINTAINERS;
  vi.resetModules();
});

let seq = 0;
async function rule() {
  const { create } = await import("../lib/learnings");
  seq += 1;
  return create({
    authorId: AUTHOR,
    title: `Pin test rule number ${seq} about something distinct ${seq}`,
    body: `Body of rule ${seq}, with the detail.`,
    kind: "standard",
    confirmNotDuplicate: true,
  });
}

async function row(id: string) {
  const { getDb } = await import("../lib/db");
  const r = getDb().prepare("SELECT pinned, pinned_by, pinned_at FROM learnings WHERE id = ?").get(id) as {
    pinned: number;
    pinned_by: string | null;
    pinned_at: string | null;
  };
  return { pinned: r.pinned, pinned_by: r.pinned_by, pinned_at: r.pinned_at };
}

async function tool(args: Record<string, unknown>, actor: string) {
  const { findTool } = await import("../lib/mcp");
  return JSON.parse(findTool("bab_react")!.run({ id: actor } as never, args) as string);
}

describe("BAB_MAINTAINERS is set", () => {
  beforeEach(() => {
    process.env.BAB_MAINTAINERS = MAINTAINER;
  });

  it("refuses a non-maintainer's pin with a 403 and leaves the row unpinned", async () => {
    const r = await rule();
    const { setPinned } = await import("../lib/learnings");
    const { ForbiddenError } = await import("../lib/errors");
    let err: unknown;
    try {
      setPinned(r.id, OTHER, true, "mcp");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as { status: number }).status).toBe(403);
    expect((err as Error).message).toBe(REFUSAL);
    expect(await row(r.id)).toEqual({ pinned: 0, pinned_by: null, pinned_at: null });
  });

  it("refuses a non-maintainer's pin through bab_react, and writes no audit row", async () => {
    const r = await rule();
    await expect(tool({ learningId: r.id, action: "pin" }, OTHER)).rejects.toThrow(REFUSAL);
    expect((await row(r.id)).pinned).toBe(0);
    const { getDb } = await import("../lib/db");
    const n = getDb()
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action IN ('pin','unpin')")
      .get(r.id) as { n: number };
    expect(n.n).toBe(0);
  });

  it("refuses a non-maintainer's unpin and keeps the rule pinned", async () => {
    const r = await rule();
    await tool({ learningId: r.id, action: "pin" }, MAINTAINER);
    await expect(tool({ learningId: r.id, action: "unpin" }, OTHER)).rejects.toThrow(REFUSAL);
    const after = await row(r.id);
    expect(after.pinned).toBe(1);
    expect(after.pinned_by).toBe(MAINTAINER);
  });

  it("lets a maintainer pin, recording pinned_by and pinned_at", async () => {
    const r = await rule();
    const out = await tool({ learningId: r.id, action: "pin" }, MAINTAINER);
    expect(out.changed).toBe(true);
    expect(out.learning.pinned).toBe(1);
    const after = await row(r.id);
    expect(after.pinned).toBe(1);
    expect(after.pinned_by).toBe(MAINTAINER);
    expect(after.pinned_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("lets a maintainer unpin, clearing pinned_by and pinned_at", async () => {
    const r = await rule();
    await tool({ learningId: r.id, action: "pin" }, MAINTAINER);
    await tool({ learningId: r.id, action: "unpin" }, MAINTAINER);
    expect(await row(r.id)).toEqual({ pinned: 0, pinned_by: null, pinned_at: null });
  });

  it("matches the maintainer id case-insensitively", async () => {
    const r = await rule();
    const { setPinned } = await import("../lib/learnings");
    expect(setPinned(r.id, MAINTAINER.toUpperCase(), true, "mcp").changed).toBe(true);
  });

  it("refuses before looking the memory up, so a non-maintainer cannot probe ids", async () => {
    const { setPinned } = await import("../lib/learnings");
    expect(() => setPinned("does-not-exist", OTHER, true, "mcp")).toThrow(REFUSAL);
  });

  it("a correction by a non-maintainer is not pinned: supersede is not a way around the check", async () => {
    const r = await rule();
    await tool({ learningId: r.id, action: "pin" }, MAINTAINER);
    const { createWithSupersedes } = await import("../lib/learnings");
    const fixed = createWithSupersedes(
      {
        authorId: AUTHOR,
        title: "Corrected pin test rule wording",
        body: "The corrected rule, citing the source.",
        kind: "standard",
        confirmNotDuplicate: true,
      },
      [r.id],
    );
    expect(await row(fixed.id)).toEqual({ pinned: 0, pinned_by: null, pinned_at: null });
  });

  it("a correction by a maintainer stays pinned, attributed to the corrector", async () => {
    const r = await rule();
    await tool({ learningId: r.id, action: "pin" }, MAINTAINER);
    const { createWithSupersedes } = await import("../lib/learnings");
    const fixed = createWithSupersedes(
      {
        authorId: MAINTAINER,
        title: "Corrected pin test rule wording",
        body: "The corrected rule, citing the source.",
        kind: "standard",
        confirmNotDuplicate: true,
      },
      [r.id],
    );
    const after = await row(fixed.id);
    expect(after.pinned).toBe(1);
    expect(after.pinned_by).toBe(MAINTAINER);
    expect(after.pinned_at).toBeTruthy();
  });
});

describe("BAB_MAINTAINERS is unset (honour system)", () => {
  it("lets anyone pin and unpin, and still records who", async () => {
    delete process.env.BAB_MAINTAINERS;
    const r = await rule();
    const out = await tool({ learningId: r.id, action: "pin" }, OTHER);
    expect(out.changed).toBe(true);
    const pinned = await row(r.id);
    expect(pinned.pinned).toBe(1);
    expect(pinned.pinned_by).toBe(OTHER);
    expect(pinned.pinned_at).not.toBeNull();

    await tool({ learningId: r.id, action: "unpin" }, AUTHOR);
    expect(await row(r.id)).toEqual({ pinned: 0, pinned_by: null, pinned_at: null });
  });
});
