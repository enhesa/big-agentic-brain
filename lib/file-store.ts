import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
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

/** Thrown when an upload stalls for UPLOAD_IDLE_TIMEOUT_MS. */
export class UploadStalledError extends Error {
  constructor() {
    super("upload stalled");
    this.name = "UploadStalledError";
  }
}

async function* chunksOf(body: Body, idleMs: number): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UploadStalledError()), idleMs);
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

/**
 * Streams a body to a temp file, hashing and counting as it goes, and stops as soon as it passes
 * `maxBytes` (Content-Length is not trusted: a chunked request has none). Memory use stays at one
 * chunk, whatever the file size.
 */
export async function stageUpload(body: Body, maxBytes: number, idleMs: number = UPLOAD_IDLE_TIMEOUT_MS): Promise<StagedUpload> {
  mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(tmpDir(), randomBytes(16).toString("hex"));
  const out = createWriteStream(tmpPath, { mode: 0o600 });
  const hash = createHash("sha256");
  let size = 0;
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
    for await (const chunk of chunksOf(body, idleMs)) {
      if (writeError) throw writeError;
      size += chunk.byteLength;
      if (size > maxBytes) throw new UploadTooLargeError();
      if (head.length < HEAD_BYTES) head = Buffer.concat([head, Buffer.from(chunk.subarray(0, HEAD_BYTES - head.length))]);
      hash.update(chunk);
      if (!out.write(chunk)) await drained();
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
export function stageBuffer(bytes: Uint8Array, maxBytes: number): StagedUpload {
  if (bytes.byteLength > maxBytes) throw new UploadTooLargeError();
  mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(tmpDir(), randomBytes(16).toString("hex"));
  writeFileSync(tmpPath, bytes, { mode: 0o600 });
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { tmpPath, size: bytes.byteLength, sha256: createHash("sha256").update(buf).digest("hex"), head: Buffer.from(buf.subarray(0, HEAD_BYTES)) };
}

/** A stored file's bytes, read at once. Only for small files. */
export function readBlobSync(id: string): Buffer {
  return readFileSync(blobPath(id));
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
      if (now - statSync(p).mtimeMs > 60 * 60 * 1000) {
        rmSync(p, { force: true });
        removed += 1;
      }
    } catch {
      // gone already
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

/** Test-only: replace statfs so a test controls how full the volume looks. Pass null to restore. */
export function _setStatfsForTests(fn: StatfsFn | null): void {
  statfs = fn ?? ((dir) => statfsSync(dir));
}
