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
// The file store needs a proven identity (lib/files.ts assertFilesIdentity): these callers come from bound devices.
const me: SessionUser = { id: OWNER, email: OWNER, name: "Owner One", roles: [], source: "device" };
const them: SessionUser = { id: OTHER, email: OTHER, name: "Other Two", roles: [], source: "device" };

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
  for (const k of Object.keys(process.env)) if (k.startsWith("BAB_FILES")) delete process.env[k];
  (await import("../lib/config"))._resetConfigForTests();
  vi.resetModules();
});

async function tool() {
  const { findTool } = await import("../lib/mcp");
  const t = findTool("bab_files")!;
  return async (actor: SessionUser, args: Record<string, unknown>) => JSON.parse(await t.run(actor, args, ctx));
}

describe("bab_files", () => {
  it("round-trips text: put, list, get with inline content and checksum, delete", async () => {
    const run = await tool();
    const text = "line one\nline two\n";
    const put = await run(me, { action: "put", name: "notes.md", content: text });
    expect(put.file.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(put.download.url).toContain("https://bab.example.com/api/files/dl/");
    expect((await run(me, { action: "list" })).files).toHaveLength(1);
    const got = await run(me, { action: "get", id: put.file.id });
    expect(got.content).toBe(text);
    expect((await run(me, { action: "delete", id: put.file.id })).usage.usedBytes).toBe(0);
    expect((await run(me, { action: "list" })).files).toHaveLength(0);
  });

  it("stores base64 bytes and does not inline binary", async () => {
    const run = await tool();
    const bin = Buffer.from([0, 1, 2, 3, 255]);
    const put = await run(me, { action: "put", name: "blob.dat", contentBase64: bin.toString("base64") });
    expect(put.file.size).toBe(5);
    const got = await run(me, { action: "get", id: put.file.id });
    expect(got.content).toBeUndefined();
    expect(got.contentHint).toContain("download.url");
  });

  it("delivers with to, shares with share, and keeps others out", async () => {
    const run = await tool();
    const put = await run(me, { action: "put", name: "brief.md", content: "x", to: OTHER, note: "for you" });
    expect(put.delivery.to).toBe(OTHER);
    expect((await run(them, { action: "get", id: put.file.id })).content).toBe("x");
    await expect(run(them, { action: "delete", id: put.file.id })).rejects.toThrow(/owner/);
    const p2 = await run(me, { action: "put", name: "private.md", content: "y" });
    await expect(run(them, { action: "get", id: p2.file.id })).rejects.toThrow(/not found/i);
    await run(me, { action: "share", id: p2.file.id, orgVisible: true });
    expect((await run(them, { action: "get", id: p2.file.id })).content).toBe("y");
    expect((await run(them, { action: "list" })).shared).toHaveLength(2);
  });

  it("refuses bad input", async () => {
    const run = await tool();
    await expect(run(me, {})).rejects.toThrow(/required, has no default/);
    await expect(run(me, { action: "put", name: "a.txt" })).rejects.toThrow(/exactly one/);
    await expect(run(me, { action: "put", name: "a.txt", content: "a", contentBase64: "YQ==" })).rejects.toThrow(/exactly one/);
    await expect(run(me, { action: "put", name: "a.txt", contentBase64: "not base64!" })).rejects.toThrow(/base64/);
    await expect(run(me, { action: "get" })).rejects.toThrow(/needs id/);
    await expect(run(me, { action: "put", name: "x.exe", content: "MZ" })).rejects.toThrow(/refused/);
  });

  it("enforces the inline put limit and points to the REST upload", async () => {
    const run = await tool();
    const { FILE_MCP_PUT_MAX_BYTES } = await import("../lib/files");
    await expect(run(me, { action: "put", name: "big.txt", content: "a".repeat(FILE_MCP_PUT_MAX_BYTES + 1) })).rejects.toThrow(/curl -X POST --data-binary/);
    expect((await run(me, { action: "put", name: "ok.txt", content: "a".repeat(1000) })).file.size).toBe(1000);
  });

  it("refuses text that holds a secret, without echoing it", async () => {
    const run = await tool();
    const value = "Zq7" + "Xv9Lm2Rt";
    const err = await run(me, { action: "put", name: "conf.txt", content: "pass" + "word=" + value }).catch((e) => e);
    expect(err.message).toMatch(/secret/);
    expect(err.message).not.toContain(value);
  });

  it("refuses callers identified only by headers or a connection", async () => {
    const run = await tool();
    await expect(run({ ...me, source: "declared" }, { action: "list" })).rejects.toThrow(/proven identity/);
    await expect(run({ ...me, source: "connection" }, { action: "list" })).rejects.toThrow(/proven identity/);
    expect((await run({ ...me, source: "declared", tokenBound: true }, { action: "list" })).files).toEqual([]);
  });

  it("says what not to upload and this deployment's limits in its description", async () => {
    const { findTool } = await import("../lib/mcp");
    const d = findTool("bab_files")!.description;
    expect(d).toContain("Never upload confidential data");
    expect(d).toContain("25 MB per file");
    expect(d).toContain("100 MB per person");
    expect(d).toContain("14 days");
    expect(d).toContain("tar or zip");
    expect(d).toContain("orgVisible:true opens it to everyone and needs the user's yes");
    process.env.BAB_FILES_USER_QUOTA_BYTES = String(1024 * 1024 * 1024);
    process.env.BAB_FILES_DEFAULT_EXPIRY_DAYS = "7";
    (await import("../lib/config"))._resetConfigForTests();
    const d2 = findTool("bab_files")!.description;
    expect(d2).toContain("1 GB per person");
    expect(d2).toContain("expiry 7 days by default");
  });
});
