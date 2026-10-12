import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A2 review follow-ups: notes on a deleted memory, non-text notes, and the length rule after redaction.
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-notes-hardening-test-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

async function seed() {
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: "author-1", email: "a@example.com", name: "Ada", roles: [] });
  upsertUser({ id: "voter-1", email: "b@example.com", name: "Bob", roles: [] });
  const { create } = await import("../lib/learnings");
  return create({ authorId: "author-1", title: "Hardening fixture zq1", body: "Body about topic zq1x", confirmNotDuplicate: true });
}

describe("notes on a deleted memory", () => {
  it("recentNotes is empty once the author deletes the memory", async () => {
    const l = await seed();
    const { confirm, recentNotes, deleteOwn } = await import("../lib/learnings");
    confirm(l.id, "voter-1", "checked in src/lib/db.ts, 2026-10-02", "mcp");
    expect(recentNotes(l.id)).toHaveLength(1);
    deleteOwn(l.id, "author-1", "mcp");
    expect(recentNotes(l.id)).toEqual([]);
  });

  it("confirm and flag on a deleted memory are refused as not found", async () => {
    const l = await seed();
    const { confirm, flag, deleteOwn } = await import("../lib/learnings");
    const { NotFoundError } = await import("../lib/errors");
    deleteOwn(l.id, "author-1", "mcp");
    expect(() => confirm(l.id, "voter-1", "checked it", "mcp")).toThrow(NotFoundError);
    expect(() => flag(l.id, "voter-1", "mcp", "looks wrong")).toThrow(NotFoundError);
  });
});

describe("noteArg", () => {
  it("passes text and null through and refuses anything else", async () => {
    const { noteArg } = await import("../lib/learnings");
    const { ValidationError } = await import("../lib/errors");
    expect(noteArg("where I checked")).toBe("where I checked");
    expect(noteArg(undefined)).toBeNull();
    expect(noteArg(null)).toBeNull();
    expect(() => noteArg({})).toThrow(ValidationError);
    expect(() => noteArg(5)).toThrow("note must be text");
  });
});

describe("note length after redaction", () => {
  it("says the limit applies after redaction when redaction makes a note too long", async () => {
    const l = await seed();
    const { confirm } = await import("../lib/learnings");
    // Under 300 raw; each address grows to "[redacted email]" and pushes it over.
    const note = "checked " + Array.from({ length: 20 }, (_, i) => `x${i}@q.io`).join(" ");
    expect(note.length).toBeLessThanOrEqual(300);
    expect(() => confirm(l.id, "voter-1", note, "mcp")).toThrow(/after redaction/);
  });
});
