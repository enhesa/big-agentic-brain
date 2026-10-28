import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionUser } from "../lib/session";

let dataDir: string;
const OWNER = "owner.one@example.com";
const OTHER = "other.two@example.com";
const ctx = { origin: "https://bab.example.com" };
const me: SessionUser = { id: OWNER, email: OWNER, name: "Owner One", roles: [], source: "declared" };
const them: SessionUser = { id: OTHER, email: OTHER, name: "Other Two", roles: [], source: "declared" };

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-mcp-files-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
  upsertUser({ id: OTHER, email: OTHER, name: "Other Two", roles: [] });
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  vi.resetModules();
});

async function tool() {
  const { findTool } = await import("../lib/mcp");
  const t = findTool("bab_files")!;
  return (actor: SessionUser, args: Record<string, unknown>) => JSON.parse(t.run(actor, args, ctx));
}

describe("bab_files", () => {
  it("round-trips text: put, list, get with inline content and checksum, delete", async () => {
    const run = await tool();
    const text = "line one\nline two\n";
    const put = run(me, { action: "put", name: "notes.md", content: text });
    expect(put.file.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(put.download.url).toContain("https://bab.example.com/api/files/dl/");
    expect(run(me, { action: "list" }).files).toHaveLength(1);
    const got = run(me, { action: "get", id: put.file.id });
    expect(got.content).toBe(text);
    expect(run(me, { action: "delete", id: put.file.id }).usage.usedBytes).toBe(0);
    expect(run(me, { action: "list" }).files).toHaveLength(0);
  });

  it("stores base64 bytes and does not inline binary", async () => {
    const run = await tool();
    const bin = Buffer.from([0, 1, 2, 3, 255]);
    const put = run(me, { action: "put", name: "blob.dat", contentBase64: bin.toString("base64") });
    expect(put.file.size).toBe(5);
    const got = run(me, { action: "get", id: put.file.id });
    expect(got.content).toBeUndefined();
    expect(got.contentHint).toContain("download.url");
  });

  it("delivers with to, shares with share, and keeps others out", async () => {
    const run = await tool();
    const put = run(me, { action: "put", name: "brief.md", content: "x", to: OTHER, note: "for you" });
    expect(put.delivery.to).toBe(OTHER);
    expect(run(them, { action: "get", id: put.file.id }).content).toBe("x");
    expect(() => run(them, { action: "delete", id: put.file.id })).toThrow(/owner/);
    const p2 = run(me, { action: "put", name: "private.md", content: "y" });
    expect(() => run(them, { action: "get", id: p2.file.id })).toThrow(/not found/i);
    run(me, { action: "share", id: p2.file.id, orgVisible: true });
    expect(run(them, { action: "get", id: p2.file.id }).content).toBe("y");
    expect(run(them, { action: "list" }).shared).toHaveLength(2);
  });

  it("refuses bad input", async () => {
    const run = await tool();
    expect(() => run(me, {})).toThrow(/required, has no default/);
    expect(() => run(me, { action: "put", name: "a.txt" })).toThrow(/exactly one/);
    expect(() => run(me, { action: "put", name: "a.txt", content: "a", contentBase64: "YQ==" })).toThrow(/exactly one/);
    expect(() => run(me, { action: "put", name: "a.txt", contentBase64: "not base64!" })).toThrow(/base64/);
    expect(() => run(me, { action: "get" })).toThrow(/needs id/);
    expect(() => run(me, { action: "put", name: "x.exe", content: "MZ" })).toThrow(/refused/);
  });

  it("says what not to upload and the limits in its description", async () => {
    const { findTool } = await import("../lib/mcp");
    const d = findTool("bab_files")!.description;
    expect(d).toContain("Never upload confidential data");
    expect(d).toContain("25 MB per file");
    expect(d).toContain("100 MB per person");
    expect(d).toContain("14 days");
    expect(d).toContain("tar or zip");
  });
});
