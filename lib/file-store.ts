import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { resolveDataDir } from "./db";

/**
 * Where the bytes of the file store live: DATA_DIR/files/<first two id chars>/<id>. The path is built
 * from the id only, which BAB makes itself (hex), never from a name a caller sent. An upload streams
 * into DATA_DIR/files/tmp first and is renamed into place once it is complete, so a backup or a crash
 * never sees half a file under a final name. Everything sits under DATA_DIR, so a backup of the data
 * volume covers it.
 */
const ID_PATTERN = /^[0-9a-f]{32}$/;

export function filesDir(): string {
  return path.join(resolveDataDir(), "files");
}

function tmpDir(): string {
  return path.join(filesDir(), "tmp");
}

/** The on-disk path of a stored file. Throws on anything that is not a BAB file id. */
export function blobPath(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error("not a file id");
  return path.join(filesDir(), id.slice(0, 2), id);
}

export function newFileId(): string {
  return randomBytes(16).toString("hex");
}

export interface StagedUpload {
  tmpPath: string;
  size: number;
  sha256: string;
  /** The first bytes, for the executable check. */
  head: Buffer;
}

/** Thrown by stageUpload when the body passes `maxBytes`. The partial temp file is already gone. */
export class UploadTooLargeError extends Error {
  constructor() {
    super("upload too large");
    this.name = "UploadTooLargeError";
  }
}

const HEAD_BYTES = 8;

type Body = ReadableStream<Uint8Array> | Uint8Array | null;

/** An upload that sends nothing for this long is dropped, so a stalled client cannot hold an upload slot. */
export const UPLOAD_IDLE_TIMEOUT_MS = 30_000;

/** How often (in bytes written) a streaming upload asks whether the disk still has room. */
export const UPLOAD_PROGRESS_EVERY_BYTES = 4 * 1024 * 1024;

/** Thrown when an upload stalls for UPLOAD_IDLE_TIMEOUT_MS. */
export class UploadStalledError extends Error {
  constructor() {
    super("upload stalled");
    this.name = "UploadStalledError";
  }
}

/** Thrown when an upload is still running at its overall deadline (BAB_FILES_UPLOAD_DEADLINE_SECONDS). */
export class UploadDeadlineError extends Error {
  constructor() {
    super("upload too slow");
    this.name = "UploadDeadlineError";
  }
}

async function* chunksOf(body: Body, idleMs: number, deadlineAt: number): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const left = deadlineAt - Date.now();
      if (left <= 0) throw new UploadDeadlineError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(left < idleMs ? new UploadDeadlineError() : new UploadStalledError()), Math.min(idleMs, left));
      });
      try {
        const { done, value } = await Promise.race([reader.read(), stalled]);
        if (done) return;
        if (value) yield value;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface StageOptions {
  /** Drop the upload after this long with nothing arriving. */
  idleMs?: number;
  /** Drop the upload when it is still running this long after it started. */
  deadlineMs?: number;
  /** Called every UPLOAD_PROGRESS_EVERY_BYTES with the bytes written so far; a throw aborts the upload. */
  onProgress?: (bytes: number) => void;
}

/**
 * Streams a body to a temp file, hashing and counting as it goes, and stops as soon as it passes
 * `maxBytes` (Content-Length is not trusted: a chunked request has none). Memory use stays at one
 * chunk, whatever the file size.
 */
export async function stageUpload(body: Body, maxBytes: number, opts: StageOptions = {}): Promise<StagedUpload> {
  const idleMs = opts.idleMs ?? UPLOAD_IDLE_TIMEOUT_MS;
  const deadlineAt = Date.now() + (opts.deadlineMs ?? Number.MAX_SAFE_INTEGER / 2);
  mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(tmpDir(), randomBytes(16).toString("hex"));
  const out = createWriteStream(tmpPath, { mode: 0o600 });
  const hash = createHash("sha256");
  let size = 0;
  let nextProgress = UPLOAD_PROGRESS_EVERY_BYTES;
  let head = Buffer.alloc(0);
  // A write error (disk full, I/O) can arrive while the loop waits on the network: remember it and
  // fail the next step, never leave it as an unhandled rejection or a drain wait that never ends.
  let writeError: Error | null = null;
  const closed = new Promise<void>((resolve) => {
    out.on("close", resolve);
    out.on("error", (e) => {
      writeError = e;
      resolve();
    });
  });
  const drained = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        out.off("drain", done);
        out.off("error", done);
        out.off("close", done);
        resolve();
      };
      out.on("drain", done);
      out.on("error", done);
      out.on("close", done);
    });
  try {
    for await (const chunk of chunksOf(body, idleMs, deadlineAt)) {
      if (writeError) throw writeError;
      size += chunk.byteLength;
      if (size > maxBytes) throw new UploadTooLargeError();
      if (head.length < HEAD_BYTES) head = Buffer.concat([head, Buffer.from(chunk.subarray(0, HEAD_BYTES - head.length))]);
      hash.update(chunk);
      if (!out.write(chunk)) await drained();
      if (opts.onProgress && size >= nextProgress) {
        nextProgress = size + UPLOAD_PROGRESS_EVERY_BYTES;
        opts.onProgress(size);
      }
    }
    if (writeError) throw writeError;
    out.end();
    await closed;
    if (writeError) throw writeError;
  } catch (err) {
    out.destroy();
    await closed;
    rmSync(tmpPath, { force: true });
    throw err;
  }
  return { tmpPath, size, sha256: hash.digest("hex"), head };
}

/** The same as stageUpload for bytes already in memory (an MCP put, which is small). */
export async function stageBuffer(bytes: Uint8Array, maxBytes: number): Promise<StagedUpload> {
  if (bytes.byteLength > maxBytes) throw new UploadTooLargeError();
  mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(tmpDir(), randomBytes(16).toString("hex"));
  try {
    await writeFile(tmpPath, bytes, { mode: 0o600 });
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { tmpPath, size: bytes.byteLength, sha256: createHash("sha256").update(buf).digest("hex"), head: Buffer.from(buf.subarray(0, HEAD_BYTES)) };
}

/** A stored file's bytes, read at once. Only for small files. */
export function readBlobSync(id: string): Buffer {
  return readFileSync(blobPath(id));
}

/** Up to `length` bytes of a file from `position`, read with one small synchronous read. */
export function readRange(filePath: string, position: number, length: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const n = readSync(fd, buf, 0, buf.length, position);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Moves a staged upload to its final place. */
export function commitUpload(staged: StagedUpload, id: string): void {
  const dest = blobPath(id);
  mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  renameSync(staged.tmpPath, dest);
}

export function discardUpload(staged: StagedUpload): void {
  rmSync(staged.tmpPath, { force: true });
}

/** Removes a stored file's bytes. True when nothing is left on disk afterwards. */
export function removeBlob(id: string): boolean {
  try {
    rmSync(blobPath(id), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function blobExists(id: string): boolean {
  try {
    return statSync(blobPath(id)).isFile();
  } catch {
    return false;
  }
}

/** A web stream of a stored file's bytes. */
export function readBlob(id: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(blobPath(id))) as ReadableStream<Uint8Array>;
}

const STALE_MS = 60 * 60 * 1000;

/** Deletes temp files older than an hour: uploads that died mid-way. */
export function sweepStaleTemps(now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(tmpDir());
  } catch {
    return 0;
  }
  for (const name of names) {
    const p = path.join(tmpDir(), name);
    try {
      if (now - statSync(p).mtimeMs > STALE_MS) {
        rmSync(p, { force: true });
        removed += 1;
      }
    } catch {
      // gone already
    }
  }
  return removed;
}

/**
 * Deletes stored bytes older than an hour that `hasRow` does not know: a crash between moving an
 * upload into place and writing its row leaves them behind. Younger ones may be an upload that is
 * writing its row right now.
 */
export function sweepOrphanBlobs(hasRow: (id: string) => boolean, now = Date.now()): number {
  let removed = 0;
  let dirs: string[];
  try {
    dirs = readdirSync(filesDir());
  } catch {
    return 0;
  }
  for (const dir of dirs) {
    if (!/^[0-9a-f]{2}$/.test(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(path.join(filesDir(), dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!ID_PATTERN.test(name) || name.slice(0, 2) !== dir) continue;
      const p = path.join(filesDir(), dir, name);
      try {
        if (now - statSync(p).mtimeMs > STALE_MS && !hasRow(name)) {
          rmSync(p, { force: true });
          removed += 1;
        }
      } catch {
        // gone already
      }
    }
  }
  return removed;
}

export interface VolumeUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

type StatfsFn = (dir: string) => { blocks: number | bigint; bsize: number | bigint; bavail: number | bigint };
let statfs: StatfsFn = (dir) => statfsSync(dir);

/** How full the data volume is, or null when the platform cannot say. */
export function volumeUsage(): VolumeUsage | null {
  try {
    const dir = resolveDataDir();
    const s = statfs(dir);
    const bsize = Number(s.bsize);
    const totalBytes = Number(s.blocks) * bsize;
    const freeBytes = Number(s.bavail) * bsize;
    if (!(totalBytes > 0)) return null;
    const usedBytes = Math.max(totalBytes - freeBytes, 0);
    return { totalBytes, freeBytes, usedBytes, usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10 };
  } catch {
    return null;
  }
}

/** Bytes the database takes on disk: bab.db plus its write-ahead log. 0 for a file that is not there. */
export function databaseBytes(): number {
  let total = 0;
  for (const name of ["bab.db", "bab.db-wal"]) {
    try {
      total += statSync(path.join(resolveDataDir(), name)).size;
    } catch {
      // not there
    }
  }
  return total;
}

/** Test-only: replace statfs so a test controls how full the volume looks. Pass null to restore. */
export function _setStatfsForTests(fn: StatfsFn | null): void {
  statfs = fn ?? ((dir) => statfsSync(dir));
}
