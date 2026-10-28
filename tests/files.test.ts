import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;
const OWNER = "owner.one@example.com";
const OTHER = "other.two@example.com";
const THIRD = "third.three@example.com";
const ORIGIN = "https://bab.example.com";
const MB = 1024 * 1024;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-files-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  const { upsertUser } = await import("../lib/users");
  for (const [id, name] of [[OWNER, "Owner One"], [OTHER, "Other Two"], [THIRD, "Third Three"]]) {
    upsertUser({ id, email: id, name, roles: [] });
  }
});

afterEach(async () => {
  const { _resetDbForTests } = await import("../lib/db");
  const { _setStatfsForTests } = await import("../lib/file-store");
  const { _resetConfigForTests } = await import("../lib/config");
  _setStatfsForTests(null);
  _resetDbForTests();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  for (const k of Object.keys(process.env)) if (k.startsWith("BAB_FILES")) delete process.env[k];
  _resetConfigForTests();
  vi.resetModules();
});

const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const streamOf = (b: Uint8Array, chunk = 64 * 1024) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < b.length; i += chunk) c.enqueue(b.subarray(i, i + chunk));
      c.close();
    },
  });

async function lib() {
  // Settings are read once per process; a test that changed a BAB_FILES_* variable needs a fresh read.
  (await import("../lib/config"))._resetConfigForTests();
  return import("../lib/files");
}

async function put(owner: string, name: string, body: Uint8Array, extra: Record<string, unknown> = {}) {
  const { putFile } = await lib();
  return putFile({ ownerId: owner, name, body: streamOf(body), declaredSize: body.length, ...extra }, "mcp", ORIGIN);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

describe("put, list, get, delete", () => {
  it("round-trips a file with its checksum, a download link and quota usage", async () => {
    const body = bytes(3000, 0x62);
    const r = await put(OWNER, "report.md", body);
    expect(r.file.name).toBe("report.md");
    expect(r.file.size).toBe(3000);
    expect(r.file.sha256).toBe(sha(body));
    expect(r.file.own).toBe(true);
    expect(r.download.url).toMatch(new RegExp(`^${ORIGIN}/api/files/dl/[A-Za-z0-9_-]{43}$`));
    expect(r.usage).toMatchObject({ usedBytes: 3000, quotaBytes: 100 * MB, remainingBytes: 100 * MB - 3000, files: 1 });

    const { listFiles, fileForActor, openForDownload, deleteFile } = await lib();
    const listing = listFiles(OWNER);
    expect(listing.files.map((f) => f.id)).toEqual([r.file.id]);
    expect(listing.usage.usedBytes).toBe(3000);

    const file = fileForActor(OWNER, r.file.id);
    const back = await readAll(openForDownload(file, OWNER, "mcp", "direct"));
    expect(sha(back)).toBe(r.file.sha256);

    const del = deleteFile(OWNER, r.file.id, "mcp");
    expect(del.usage.usedBytes).toBe(0);
    expect(listFiles(OWNER).files).toEqual([]);
    expect(() => fileForActor(OWNER, r.file.id)).toThrow(/not found/i);
  });

  it("stores bytes under DATA_DIR/files by id only, never by the uploaded name", async () => {
    const r = await put(OWNER, "../../etc/passwd", bytes(10));
    expect(r.file.name).toBe("passwd");
    const stored = path.join(dataDir, "files", r.file.id.slice(0, 2), r.file.id);
    expect(existsSync(stored)).toBe(true);
    expect(readdirSync(path.join(dataDir, "files", "tmp"))).toEqual([]);
  });

  it("audits put, get and delete", async () => {
    const r = await put(OWNER, "a.txt", bytes(5));
    const { fileForActor, openForDownload, deleteFile } = await lib();
    await readAll(openForDownload(fileForActor(OWNER, r.file.id), OWNER, "mcp", "direct"));
    deleteFile(OWNER, r.file.id, "mcp");
    const { getDb } = await import("../lib/db");
    const actions = (getDb().prepare("SELECT action FROM audit_log WHERE entity = 'file' AND entity_id = ? ORDER BY id").all(r.file.id) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(["file_put", "file_get", "file_delete"]);
  });
});

describe("names and types", () => {
  it("refuses an empty name, an empty body and an over-long name", async () => {
    await expect(put(OWNER, "", bytes(1))).rejects.toThrow(/name is required/);
    await expect(put(OWNER, "x.txt", new Uint8Array(0))).rejects.toThrow(/empty/);
    await expect(put(OWNER, "a".repeat(201), bytes(1))).rejects.toThrow(/200 characters/);
  });

  it("refuses executables by extension and by their first bytes", async () => {
    await expect(put(OWNER, "setup.EXE", bytes(10))).rejects.toThrow(/\.exe files are refused/);
    await expect(put(OWNER, "run.ps1", bytes(10))).rejects.toThrow(/refused/);
    const pe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 1, 2, 3]);
    await expect(put(OWNER, "innocent.txt", pe)).rejects.toThrow(/executable/);
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    await expect(put(OWNER, "data.bin.txt", elf)).rejects.toThrow(/executable/);
    // A shell script is source text: allowed.
    const ok = await put(OWNER, "build.sh", new TextEncoder().encode("#!/bin/sh\necho hi\n"));
    expect(ok.file.name).toBe("build.sh");
    expect(readdirSync(path.join(dataDir, "files", "tmp"))).toEqual([]);
  });

  it("refuses a name that holds an email address", async () => {
    await expect(put(OWNER, "notes-for-someone@acme.org.txt", bytes(1))).rejects.toThrow(/rename/);
  });
});

describe("per-file cap", () => {
  it("refuses a file over the cap from Content-Length, before reading it", async () => {
    process.env.BAB_FILES_MAX_FILE_BYTES = String(1000);
    await expect(put(OWNER, "big.bin", bytes(1001))).rejects.toMatchObject({ status: 413 });
  });

  it("refuses a file over the cap from its bytes when no size was declared, and leaves no temp file", async () => {
    process.env.BAB_FILES_MAX_FILE_BYTES = String(1000);
    const { putFile } = await lib();
    await expect(putFile({ ownerId: OWNER, name: "big.bin", body: streamOf(bytes(5000), 300) }, "mcp", ORIGIN)).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(path.join(dataDir, "files", "tmp"))).toEqual([]);
  });

  it("refuses a lying Content-Length that understates the size", async () => {
    process.env.BAB_FILES_MAX_FILE_BYTES = String(1000);
    const { putFile } = await lib();
    await expect(putFile({ ownerId: OWNER, name: "big.bin", body: streamOf(bytes(5000)), declaredSize: 10 }, "mcp", ORIGIN)).rejects.toMatchObject({ status: 413 });
  });
});

describe("per-user quota", () => {
  beforeEach(() => {
    process.env.BAB_FILES_MAX_FILE_BYTES = String(400);
    process.env.BAB_FILES_USER_QUOTA_BYTES = String(1000);
  });

  it("refuses the put that would pass the cap, saying used and remaining bytes", async () => {
    await put(OWNER, "a.bin", bytes(400));
    await put(OWNER, "b.bin", bytes(400));
    const err = await put(OWNER, "c.bin", bytes(300)).catch((e) => e);
    expect(err.status).toBe(507);
    expect(err.message).toContain("you use 800 of 1000 bytes");
    expect(err.message).toContain("200 bytes");
    // Another person has their own quota.
    expect((await put(OTHER, "c.bin", bytes(300))).usage.usedBytes).toBe(300);
  });

  it("checks the quota on the real size when no size was declared", async () => {
    await put(OWNER, "a.bin", bytes(400));
    await put(OWNER, "b.bin", bytes(400));
    const { putFile } = await lib();
    await expect(putFile({ ownerId: OWNER, name: "c.bin", body: streamOf(bytes(300)) }, "mcp", ORIGIN)).rejects.toMatchObject({ status: 507 });
    expect(readdirSync(path.join(dataDir, "files", "tmp"))).toEqual([]);
  });

  it("frees space when a file is deleted", async () => {
    const a = await put(OWNER, "a.bin", bytes(400));
    await put(OWNER, "b.bin", bytes(400));
    await expect(put(OWNER, "c.bin", bytes(300))).rejects.toMatchObject({ status: 507 });
    const { deleteFile } = await lib();
    expect(deleteFile(OWNER, a.file.id, "mcp").usage.usedBytes).toBe(400);
    expect((await put(OWNER, "c.bin", bytes(300))).usage.usedBytes).toBe(700);
  });

  it("frees space when a file expires, once its bytes are removed", async () => {
    const a = await put(OWNER, "a.bin", bytes(400));
    await put(OWNER, "b.bin", bytes(400));
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE files SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", a.file.id);
    const { quotaUsage, listFiles, purgeRemovable } = await lib();
    // Expired but still on disk: no longer listed, still counted.
    expect(listFiles(OWNER).files).toHaveLength(1);
    expect(quotaUsage(OWNER).usedBytes).toBe(800);
    expect(purgeRemovable()).toBe(1);
    expect(quotaUsage(OWNER).usedBytes).toBe(400);
    expect(existsSync(path.join(dataDir, "files", a.file.id.slice(0, 2), a.file.id))).toBe(false);
    expect((await put(OWNER, "c.bin", bytes(300))).usage.usedBytes).toBe(700);
  });

  it("removes expired files at the start of a put, so they free space without waiting for maintenance", async () => {
    const a = await put(OWNER, "a.bin", bytes(400));
    await put(OWNER, "b.bin", bytes(400));
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE files SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", a.file.id);
    expect((await put(OWNER, "c.bin", bytes(300))).usage.usedBytes).toBe(700);
  });

  it("runs the purge from maintenance", async () => {
    const a = await put(OWNER, "a.bin", bytes(100));
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE files SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", a.file.id);
    const { runMaintenance } = await import("../lib/maintenance");
    expect(runMaintenance(true)?.filesPurged).toBe(1);
  });
});

describe("disk guard", () => {
  it("refuses uploads while the volume is over the threshold, and reports usage", async () => {
    const { _setStatfsForTests } = await import("../lib/file-store");
    _setStatfsForTests(() => ({ blocks: 1000, bsize: 1000, bavail: 100 }));
    const err = await put(OWNER, "a.txt", bytes(10)).catch((e) => e);
    expect(err.status).toBe(507);
    expect(err.message).toContain("90% used");
    const { filesAdminSummary } = await lib();
    const s = filesAdminSummary();
    expect(s.uploadsBlocked).toBe(true);
    expect(s.volume).toMatchObject({ totalBytes: 1_000_000, freeBytes: 100_000, usedPercent: 90 });
  });

  it("refuses an upload that would push the volume over the threshold", async () => {
    const { _setStatfsForTests } = await import("../lib/file-store");
    _setStatfsForTests(() => ({ blocks: 1000, bsize: 1000, bavail: 200 }));
    await expect(put(OWNER, "a.txt", bytes(60_000))).rejects.toMatchObject({ status: 507 });
    expect((await put(OWNER, "b.txt", bytes(10_000))).file.size).toBe(10_000);
  });

  it("allows uploads when the platform cannot report the volume", async () => {
    const { _setStatfsForTests } = await import("../lib/file-store");
    _setStatfsForTests(() => {
      throw new Error("no statfs");
    });
    expect((await put(OWNER, "a.txt", bytes(10))).file.size).toBe(10);
    const { filesAdminSummary } = await lib();
    expect(filesAdminSummary().volume).toBeNull();
  });
});

describe("sharing", () => {
  it("hides a file from others until it is shared, and answers not found, never forbidden", async () => {
    const r = await put(OWNER, "a.txt", bytes(5));
    const { fileForActor, listFiles, updateFile } = await lib();
    expect(() => fileForActor(OTHER, r.file.id)).toThrow(/not found/i);
    expect(listFiles(OTHER).shared).toEqual([]);
    updateFile(OWNER, r.file.id, { shareWith: [OTHER] }, "mcp");
    expect(fileForActor(OTHER, r.file.id).id).toBe(r.file.id);
    expect(listFiles(OTHER).shared.map((f) => f.id)).toEqual([r.file.id]);
    // The recipient does not see the owner's share list.
    expect(listFiles(OTHER).shared[0].sharedWith).toBeUndefined();
    expect(() => fileForActor(THIRD, r.file.id)).toThrow(/not found/i);
    updateFile(OWNER, r.file.id, { unshare: [OTHER] }, "mcp");
    expect(() => fileForActor(OTHER, r.file.id)).toThrow(/not found/i);
  });

  it("opens a file to everyone with orgVisible", async () => {
    const r = await put(OWNER, "a.txt", bytes(5), { orgVisible: "true" });
    const { fileForActor } = await lib();
    expect(fileForActor(THIRD, r.file.id).id).toBe(r.file.id);
  });

  it("lets only the owner delete or share", async () => {
    const r = await put(OWNER, "a.txt", bytes(5), { shareWith: OTHER });
    const { deleteFile, updateFile } = await lib();
    expect(() => deleteFile(OTHER, r.file.id, "mcp")).toThrow(/owner/);
    expect(() => updateFile(OTHER, r.file.id, { orgVisible: true }, "mcp")).toThrow(/owner/);
    expect(() => deleteFile(THIRD, r.file.id, "mcp")).toThrow(/not found/i);
  });

  it("refuses unknown people", async () => {
    await expect(put(OWNER, "a.txt", bytes(5), { shareWith: "nobody.here@example.com" })).rejects.toThrow(/Unknown user/);
    await expect(put(OWNER, "a.txt", bytes(5), { to: "nobody.here@example.com" })).rejects.toThrow(/Unknown recipient/);
  });
});

describe("expiry", () => {
  it("defaults to 14 days and refuses more than 30", async () => {
    const before = Date.now();
    const r = await put(OWNER, "a.txt", bytes(5));
    const days = (Date.parse(r.file.expiresAt) - before) / 86_400_000;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);
    await expect(put(OWNER, "a.txt", bytes(5), { expiresInDays: 31 })).rejects.toThrow(/1 to 30/);
    await expect(put(OWNER, "a.txt", bytes(5), { expiresInDays: 0 })).rejects.toThrow(/1 to 30/);
  });

  it("lets the owner shorten the expiry but not pass 30 days from the upload", async () => {
    const r = await put(OWNER, "a.txt", bytes(5), { expiresInDays: 3 });
    const { updateFile, getDb } = await (async () => ({ ...(await lib()), ...(await import("../lib/db")) }))();
    const shorter = updateFile(OWNER, r.file.id, { expiresInDays: 1 }, "mcp");
    expect(Date.parse(shorter.expiresAt)).toBeLessThan(Date.parse(r.file.expiresAt));
    getDb().prepare("UPDATE files SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 10 * 86_400_000).toISOString(), r.file.id);
    expect(() => updateFile(OWNER, r.file.id, { expiresInDays: 30 }, "mcp")).toThrow(/at most 30 days/);
  });

  it("stops serving an expired file at once", async () => {
    const r = await put(OWNER, "a.txt", bytes(5));
    const { getDb } = await import("../lib/db");
    getDb().prepare("UPDATE files SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", r.file.id);
    const { fileForActor, resolveDownloadLink } = await lib();
    expect(() => fileForActor(OWNER, r.file.id)).toThrow(/not found/i);
    expect(resolveDownloadLink(r.download.url.split("/").pop()!)).toBeNull();
  });
});

describe("download links", () => {
  it("resolves a fresh link and refuses wrong, malformed and expired ones", async () => {
    const r = await put(OWNER, "a.txt", bytes(5));
    const { resolveDownloadLink } = await lib();
    const token = r.download.url.split("/").pop()!;
    expect(resolveDownloadLink(token)?.file.id).toBe(r.file.id);
    expect(resolveDownloadLink(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(resolveDownloadLink("../../bab.db")).toBeNull();
    expect(resolveDownloadLink("")).toBeNull();
    const { getDb } = await import("../lib/db");
    // Only the hash is stored.
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM file_links WHERE token_hash = ?").get(token)).toEqual({ n: 0 });
    getDb().prepare("UPDATE file_links SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    expect(resolveDownloadLink(token)).toBeNull();
  });

  it("stops a recipient's link once the file is unshared", async () => {
    const r = await put(OWNER, "a.txt", bytes(5), { shareWith: [OTHER] });
    const { createDownloadLink, resolveDownloadLink, updateFile } = await lib();
    const link = createDownloadLink(OTHER, r.file.id, ORIGIN);
    const token = link.url.split("/").pop()!;
    expect(resolveDownloadLink(token)).not.toBeNull();
    updateFile(OWNER, r.file.id, { unshare: OTHER }, "mcp");
    expect(resolveDownloadLink(token)).toBeNull();
  });

  it("stops every link once the file is deleted", async () => {
    const r = await put(OWNER, "a.txt", bytes(5));
    const { resolveDownloadLink, deleteFile } = await lib();
    deleteFile(OWNER, r.file.id, "mcp");
    expect(resolveDownloadLink(r.download.url.split("/").pop()!)).toBeNull();
  });
});

describe("delivery", () => {
  it("shares the file with the recipient and sends them a BAB message naming it", async () => {
    const r = await put(OWNER, "brief.md", bytes(20), { to: OTHER, note: "Here is the brief.", subject: "[from VM] brief" });
    expect(r.delivery?.to).toBe(OTHER);
    const { fileForActor } = await lib();
    expect(fileForActor(OTHER, r.file.id).id).toBe(r.file.id);
    const { inboxFor, thread } = await import("../lib/messages");
    const threads = inboxFor(OTHER);
    expect(threads).toHaveLength(1);
    expect(threads[0].thread.subject).toBe("[from VM] brief");
    const body = thread(threads[0].thread.id, OTHER)!.messages.map((m) => m.body).join(" ");
    expect(body).toContain(r.file.id);
    expect(body).toContain("brief.md");
    expect(body).toContain("Here is the brief.");
  });

  it("delivers to the owner's own inbox (the other machine)", async () => {
    const r = await put(OWNER, "report.md", bytes(20), { to: OWNER });
    expect(r.delivery?.to).toBe(OWNER);
    expect(r.file.sharedWith).toEqual([]);
  });
});

describe("temp files and switch", () => {
  it("sweeps temp uploads older than an hour", async () => {
    const { sweepStaleTemps } = await import("../lib/file-store");
    const tmp = path.join(dataDir, "files", "tmp");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(path.join(tmp, "old"), "x");
    writeFileSync(path.join(tmp, "new"), "x");
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(path.join(tmp, "old"), past, past);
    expect(sweepStaleTemps()).toBe(1);
    expect(readdirSync(tmp)).toEqual(["new"]);
  });

  it("answers not found everywhere while BAB_FILES is off", async () => {
    process.env.BAB_FILES = "0";
    await expect(put(OWNER, "a.txt", bytes(5))).rejects.toThrow(/switched off/);
    const { listFiles, resolveDownloadLink } = await lib();
    expect(() => listFiles(OWNER)).toThrow(/switched off/);
    expect(resolveDownloadLink("x".repeat(43))).toBeNull();
  });

  it("refuses a file id that is not one of BAB's", async () => {
    const { blobPath } = await import("../lib/file-store");
    expect(() => blobPath("../bab.db")).toThrow();
    const { fileForActor } = await lib();
    expect(() => fileForActor(OWNER, "../bab.db")).toThrow(/not found/i);
  });
});

describe("config", () => {
  it("refuses a per-file cap over the per-user cap, over 50 MB, and a default expiry over the maximum", async () => {
    const { config, _resetConfigForTests } = await import("../lib/config");
    process.env.BAB_FILES_MAX_FILE_BYTES = String(200 * MB);
    process.env.BAB_FILES_USER_QUOTA_BYTES = String(500 * MB);
    _resetConfigForTests();
    expect(() => config()).toThrow(/at most/);
    process.env.BAB_FILES_MAX_FILE_BYTES = String(20 * MB);
    process.env.BAB_FILES_USER_QUOTA_BYTES = String(10 * MB);
    _resetConfigForTests();
    expect(() => config()).toThrow(/must not exceed BAB_FILES_USER_QUOTA_BYTES/);
    delete process.env.BAB_FILES_MAX_FILE_BYTES;
    delete process.env.BAB_FILES_USER_QUOTA_BYTES;
    process.env.BAB_FILES_DEFAULT_EXPIRY_DAYS = "40";
    _resetConfigForTests();
    expect(() => config()).toThrow(/BAB_FILES_DEFAULT_EXPIRY_DAYS/);
    process.env.BAB_FILES_DEFAULT_EXPIRY_DAYS = "14";
    process.env.BAB_FILES_DISK_FULL_PERCENT = "100";
    _resetConfigForTests();
    expect(() => config()).toThrow(/1-99/);
  });

  it("defaults to 25 MB per file, 100 MB per person, 14 and 30 days, 85 percent", async () => {
    const { config, _resetConfigForTests } = await import("../lib/config");
    _resetConfigForTests();
    expect(config().files).toEqual({ enabled: true, maxFileBytes: 25 * MB, userQuotaBytes: 100 * MB, defaultExpiryDays: 14, maxExpiryDays: 30, diskFullPercent: 85 });
  });
});

describe("migration", () => {
  it("creates the file tables when a database is rewound to v50", async () => {
    const { getDb, closeDb } = await import("../lib/db");
    const db = getDb();
    db.exec("DROP TABLE files; DROP TABLE file_shares; DROP TABLE file_links; DELETE FROM migrations WHERE version = 51;");
    closeDb();
    vi.resetModules();
    const again = await import("../lib/db");
    const tables = (again.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'file%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(["file_links", "file_shares", "files"]);
  });
});
