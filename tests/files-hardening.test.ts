import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The review fixes of the file store: identity rule, disk guard, upload deadline and caps, content checks, crash safety. */

let dataDir: string;
const OWNER = "owner.one@example.com";
const OTHER = "other.two@example.com";
const ORIGIN = "https://bab.example.com";
const MB = 1024 * 1024;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "bab-files-hard-test-"));
  process.env.DATA_DIR = dataDir;
  vi.resetModules();
  const { upsertUser } = await import("../lib/users");
  upsertUser({ id: OWNER, email: OWNER, name: "Owner One", roles: [] });
  upsertUser({ id: OTHER, email: OTHER, name: "Other Two", roles: [] });
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
const text = (s: string) => new TextEncoder().encode(s);
const streamOf = (b: Uint8Array, chunk = 64 * 1024) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < b.length; i += chunk) c.enqueue(b.subarray(i, i + chunk));
      c.close();
    },
  });

async function lib() {
  (await import("../lib/config"))._resetConfigForTests();
  return import("../lib/files");
}

async function put(owner: string, name: string, body: Uint8Array, extra: Record<string, unknown> = {}) {
  const { putFile } = await lib();
  return putFile({ ownerId: owner, name, body: streamOf(body), declaredSize: body.length, ...extra }, "mcp", ORIGIN);
}

/** A held-open upload: returns the stream and a way to finish it. */
function openStream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      c.enqueue(text("partial"));
    },
  });
  return { body, close: () => ctl.close() };
}

/** A fake volume, half full, whose free space is the store's floor plus `margin` bytes, read live. */
async function volumeWithMargin(margin: () => number) {
  const files = await lib();
  const { _setStatfsForTests } = await import("../lib/file-store");
  _setStatfsForTests(() => {
    const free = Math.max(files.diskFloorBytes() + margin(), 0);
    return { blocks: 2 * (files.diskFloorBytes() + 20 * MB), bsize: 1, bavail: free };
  });
}

const tmpFiles = () => {
  const dir = path.join(dataDir, "files", "tmp");
  return existsSync(dir) ? readdirSync(dir) : [];
};

/** A zip file with the given entries; `deflate` compresses them. CRCs are left 0: the checks do not read them. */
function zip(entries: Record<string, string>, deflate = false): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(entries)) {
    const raw = Buffer.from(body);
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

describe("identity rule", () => {
  it("allows a bound device, the sign-in proxy and a token bound to the person, and refuses headers and connections", async () => {
    const { assertFilesIdentity } = await lib();
    expect(() => assertFilesIdentity({ source: "device" })).not.toThrow();
    expect(() => assertFilesIdentity({ source: "proxy" })).not.toThrow();
    expect(() => assertFilesIdentity({ source: "declared", tokenBound: true })).not.toThrow();
    expect(() => assertFilesIdentity({ source: "declared" })).toThrow(/identity BAB remembers or checks/);
    expect(() => assertFilesIdentity({ source: "connection" })).toThrow(/identity BAB remembers or checks/);
    try {
      assertFilesIdentity({ source: "declared" });
    } catch (e) {
      expect((e as { status: number }).status).toBe(403);
    }
  });

  it("lets BAB_FILES_ALLOW_DECLARED open it for local development", async () => {
    process.env.BAB_FILES_ALLOW_DECLARED = "1";
    const { assertFilesIdentity } = await lib();
    expect(() => assertFilesIdentity({ source: "declared" })).not.toThrow();
    expect(() => assertFilesIdentity({ source: "connection" })).not.toThrow();
  });
});

describe("disk guard", () => {
  it("counts every upload in progress at the full per-file size, also one with no Content-Length", async () => {
    process.env.BAB_FILES_MAX_FILE_BYTES = String(1 * MB);
    process.env.BAB_FILES_USER_QUOTA_BYTES = String(10 * MB);
    await volumeWithMargin(() => 1.5 * MB);
    const { putFile } = await lib();
    const first = openStream();
    const running = putFile({ ownerId: OWNER, name: "a.txt", body: first.body }, "mcp", ORIGIN);
    // A second upload, chunked with no size, would need a second full reservation: refused.
    const second = openStream();
    await expect(putFile({ ownerId: OTHER, name: "b.txt", body: second.body }, "mcp", ORIGIN)).rejects.toMatchObject({ status: 507 });
    first.close();
    expect((await running).file.size).toBe(7);
    // Once the first is done, there is room for one again.
    expect((await put(OTHER, "c.txt", bytes(10))).file.size).toBe(10);
  });

  it("keeps an absolute free-space floor for the database even under the percentage limit", async () => {
    // 10 MB over the floor, but the upload reserves the 25 MB per-file cap: refused.
    let margin = 10 * MB;
    await volumeWithMargin(() => margin);
    const err = await put(OWNER, "a.txt", bytes(10)).catch((e) => e);
    expect(err.status).toBe(507);
    expect(err.message).toMatch(/free/);
    const { filesAdminSummary } = await lib();
    expect(filesAdminSummary().uploadsBlocked).toBe(false);
    margin = -1;
    expect(filesAdminSummary().uploadsBlocked).toBe(true);
  });

  it("re-checks the disk while streaming and drops the upload cleanly when it fills", async () => {
    process.env.BAB_FILES_MAX_FILE_BYTES = String(10 * MB);
    process.env.BAB_FILES_USER_QUOTA_BYTES = String(20 * MB);
    let margin = 11 * MB;
    await volumeWithMargin(() => margin);
    const { putFile } = await lib();
    const total = 6 * MB;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= total) return c.close();
        c.enqueue(bytes(256 * 1024));
        sent += 256 * 1024;
        // Something else fills the disk part way through.
        if (sent >= 2 * MB) margin = -1;
      },
    });
    await expect(putFile({ ownerId: OWNER, name: "big.bin", body }, "mcp", ORIGIN)).rejects.toMatchObject({ status: 507 });
    expect(sent).toBeLessThan(total);
    expect(tmpFiles()).toEqual([]);
  });
});

describe("slow and many uploads", () => {
  it("drops an upload that is still running at its deadline, even while bytes trickle in", async () => {
    const { stageUpload, UploadDeadlineError } = await import("../lib/file-store");
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        timer = setInterval(() => c.enqueue(bytes(1)), 10);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    await expect(stageUpload(body, 1000, { idleMs: 1000, deadlineMs: 120 })).rejects.toBeInstanceOf(UploadDeadlineError);
    clearInterval(timer);
    expect(tmpFiles()).toEqual([]);
  });

  it("caps uploads at once per verified client address", async () => {
    const { putFile, UPLOADS_IN_FLIGHT_PER_IP } = await lib();
    const open = Array.from({ length: UPLOADS_IN_FLIGHT_PER_IP }, () => openStream());
    const owners = ["a.one@example.com", "b.two@example.com", "c.three@example.com", "d.four@example.com"];
    const { upsertUser } = await import("../lib/users");
    for (const o of owners) upsertUser({ id: o, email: o, name: "Person " + o[0], roles: [] });
    const running = open.map((o, i) => putFile({ ownerId: owners[i], name: "a.txt", body: o.body, ip: "198.51.100.7" }, "mcp", ORIGIN));
    await expect(putFile({ ownerId: owners[3], name: "b.txt", body: streamOf(bytes(3)), ip: "198.51.100.7" }, "mcp", ORIGIN)).rejects.toThrow(/from this address/);
    // Another address is not blocked.
    expect((await putFile({ ownerId: owners[3], name: "c.txt", body: streamOf(bytes(3)), ip: "198.51.100.8" }, "mcp", ORIGIN)).file.size).toBe(3);
    for (const o of open) o.close();
    await Promise.all(running);
    expect((await putFile({ ownerId: owners[3], name: "d.txt", body: streamOf(bytes(3)), ip: "198.51.100.7" }, "mcp", ORIGIN)).file.size).toBe(3);
  });
});

describe("executables", () => {
  it("refuses disk images, shortcuts, OneNote, macro documents and Java and Android packages by extension", async () => {
    for (const name of ["disk.iso", "disk.img", "vm.vhdx", "help.chm", "site.url", "x.scf", "a.application", "a.appref-ms", "l.library-ms", "n.one", "r.docm", "add.xlam", "app.jar", "app.apk", "pkg.msix"]) {
      await expect(put(OWNER, name, bytes(10)), name).rejects.toThrow(/refused/);
    }
  });

  it("refuses zip files that are Android apps, Windows app packages or runnable Java programs, and keeps plain zips", async () => {
    await expect(put(OWNER, "game.zip", zip({ "AndroidManifest.xml": "<manifest/>", "classes.dex": "x" }))).rejects.toThrow(/Android app/);
    await expect(put(OWNER, "tool.zip", zip({ "AppxManifest.xml": "<Package/>" }))).rejects.toThrow(/Windows app package/);
    await expect(put(OWNER, "run.zip", zip({ "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\nMain-Class: com.acme.Main\n" }, true))).rejects.toThrow(/runnable Java/);
    expect((await put(OWNER, "lib.zip", zip({ "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" }, true))).file.name).toBe("lib.zip");
    expect((await put(OWNER, "docs.zip", zip({ "readme.md": "hello", "notes/a.txt": "b" }))).file.name).toBe("docs.zip");
  });

  it("finds a zip behind bytes put in front of it", async () => {
    const apk = zip({ "AndroidManifest.xml": "<manifest/>" });
    const prefixed = new Uint8Array([...text('#!/bin/sh\nexec java -jar "$0"\n'), ...apk]);
    await expect(put(OWNER, "setup.dat", prefixed)).rejects.toThrow(/Android app/);
  });

  it("tries every end-of-directory record, so a fake one in the zip comment does not hide an app", async () => {
    const apk = Buffer.from(zip({ "AndroidManifest.xml": "<manifest/>" }));
    // A harmless directory of its own, then a fake end record pointing at it, all inside the comment.
    const decoy = Buffer.from(zip({ "readme.md": "hi" }));
    const comment = Buffer.concat([decoy]);
    apk.writeUInt16LE(comment.length, apk.length - 2);
    const crafted = new Uint8Array(Buffer.concat([apk, comment]));
    await expect(put(OWNER, "game.zip", crafted)).rejects.toThrow(/Android app/);
  });

  it("treats a manifest that inflates past the cap as runnable", async () => {
    // Small when compressed, far over the cap when inflated: the check must not give up and allow it.
    const bomb = zip({ "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" + " ".repeat(2 * 1024 * 1024) }, true);
    await expect(put(OWNER, "big.zip", bomb)).rejects.toThrow(/cannot check/);
  });
});

describe("secrets in text files", () => {
  it("scans 1 MB of key-value lines quickly", async () => {
    const { sensitiveKind } = await import("../lib/file-checks");
    const line = "pass" + "word: changeme pass" + "word: changeme token: abc\n";
    const big = line.repeat(Math.floor((1024 * 1024) / line.length));
    const t0 = Date.now();
    expect(sensitiveKind(big)).toMatch(/secret/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  // Built at runtime so the source holds no real-looking secret.
  const secretLine = () => "pass" + "word=" + "Zq7" + "Xv9Lm2Rt";

  it("refuses a text file that holds a secret, naming the kind and never the value", async () => {
    const err = await put(OWNER, "app.env", text(`HOST=db\n${secretLine()}\n`)).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/a secret such as a password/);
    expect(err.message).not.toContain("Zq7");
    expect(tmpFiles()).toEqual([]);
  });

  it("refuses an outside email address and keeps colleagues' addresses", async () => {
    await expect(put(OWNER, "list.txt", text("write to someone@outside-company.net please"))).rejects.toThrow(/email address/);
    expect((await put(OWNER, "team.txt", text("ask other.two@example.com about it"))).file.name).toBe("team.txt");
  });

  it("does not inspect binary files", async () => {
    const bin = new Uint8Array([0, ...text(secretLine())]);
    expect((await put(OWNER, "blob.bin", bin)).file.size).toBe(bin.length);
  });

  it("names what it found without echoing it", async () => {
    const { sensitiveKind } = await import("../lib/file-checks");
    expect(sensitiveKind("nothing to see here")).toBeNull();
    expect(sensitiveKind(secretLine())).toMatch(/secret/);
  });
});

describe("crash safety", () => {
  it("moves the bytes into place before the row, and removes them when the row is refused", async () => {
    process.env.BAB_FILES_MAX_FILE_BYTES = "1000";
    process.env.BAB_FILES_USER_QUOTA_BYTES = "1500";
    await put(OWNER, "a.bin", bytes(1000));
    // Over quota without a declared size: refused at the row, after the bytes were staged.
    const { putFile } = await lib();
    await expect(putFile({ ownerId: OWNER, name: "b.bin", body: streamOf(bytes(900)) }, "mcp", ORIGIN)).rejects.toMatchObject({ status: 507 });
    const stored = readdirSync(path.join(dataDir, "files")).filter((d) => d !== "tmp").flatMap((d) => readdirSync(path.join(dataDir, "files", d)));
    expect(stored).toHaveLength(1);
  });

  it("drops nothing when the file store folder is gone (a volume that is not mounted)", async () => {
    const a = await put(OWNER, "a.bin", bytes(100));
    const b = await put(OWNER, "b.bin", bytes(100));
    rmSync(path.join(dataDir, "files"), { recursive: true, force: true });
    const { purgeRemovable, listFiles } = await lib();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    purgeRemovable();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/volume mounted/));
    warn.mockRestore();
    expect(listFiles(OWNER).files.map((f) => f.id).sort()).toEqual([a.file.id, b.file.id].sort());
  });

  it("drops nothing when the only stored file is missing", async () => {
    const a = await put(OWNER, "a.bin", bytes(100));
    const { blobPath } = await import("../lib/file-store");
    rmSync(blobPath(a.file.id));
    const { purgeRemovable, listFiles } = await lib();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    purgeRemovable();
    warn.mockRestore();
    expect(listFiles(OWNER).files.map((f) => f.id)).toEqual([a.file.id]);
  });

  it("drops nothing when a file answers an error other than does-not-exist", async () => {
    const a = await put(OWNER, "a.bin", bytes(100));
    const b = await put(OWNER, "b.bin", bytes(100));
    const { blobPath, _setBlobStatForTests } = await import("../lib/file-store");
    rmSync(blobPath(a.file.id));
    _setBlobStatForTests((p) => {
      if (p.endsWith(b.file.id)) throw Object.assign(new Error("I/O error"), { code: "EIO" });
      const e = Object.assign(new Error("gone"), { code: "ENOENT" });
      if (p.endsWith(a.file.id)) throw e;
      return { isFile: () => true };
    });
    try {
      const { purgeRemovable, listFiles, fileForActor, openForDownload } = await lib();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      purgeRemovable();
      warn.mockRestore();
      expect(listFiles(OWNER).files).toHaveLength(2);
      // A download of a file that cannot be checked is an error, not "gone".
      expect(() => openForDownload(fileForActor(OWNER, b.file.id), OWNER, "mcp", "direct")).toThrow(expect.objectContaining({ status: 503 }));
    } finally {
      _setBlobStatForTests(null);
    }
  });

  it("maintenance drops live rows whose bytes are gone, and old bytes that have no row", async () => {
    const a = await put(OWNER, "a.bin", bytes(100));
    const kept = await put(OWNER, "kept.bin", bytes(50));
    const { blobPath, newFileId } = await import("../lib/file-store");
    rmSync(blobPath(a.file.id));
    const orphan = newFileId();
    const young = newFileId();
    for (const id of [orphan, young]) {
      mkdirSync(path.dirname(blobPath(id)), { recursive: true });
      writeFileSync(blobPath(id), "x");
    }
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(blobPath(orphan), past, past);

    const { purgeRemovable, listFiles, quotaUsage } = await lib();
    purgeRemovable();
    expect(listFiles(OWNER).files.map((f) => f.id)).toEqual([kept.file.id]);
    expect(quotaUsage(OWNER).usedBytes).toBe(50);
    expect(existsSync(blobPath(orphan))).toBe(false);
    // A young file may be an upload writing its row right now: kept.
    expect(existsSync(blobPath(young))).toBe(true);
    const { getDb } = await import("../lib/db");
    expect(getDb().prepare("SELECT action FROM audit_log WHERE entity_id = ?").all(a.file.id).map((r) => (r as { action: string }).action)).toContain("file_lost");
  });
});
