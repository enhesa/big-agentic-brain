/**
 * The file store: agents and people put, list, get, share and delete files through BAB, with BAB's own
 * identity (docs/files.md). Bytes live on the data volume (lib/file-store.ts); rows in `files`,
 * `file_shares` and `file_links`. Rules:
 *
 * - A file belongs to its uploader. Only the owner deletes, shares or changes it.
 * - Others fetch it only when the owner shared it with them or made it visible to the whole org.
 *   A file someone may not see answers "not found", never "forbidden", so ids cannot be probed.
 * - Caps: BAB_FILES_MAX_FILE_BYTES per file, BAB_FILES_USER_QUOTA_BYTES per owner across their files
 *   still on disk, and no uploads while the volume is fuller than BAB_FILES_DISK_FULL_PERCENT.
 * - Every file expires (default 14 days, at most 30). Expired and deleted files stop counting
 *   towards the quota once their bytes are removed (purgeRemovable).
 * - Executables are refused by extension and by their first bytes.
 * - Every put, fetch, share and delete writes an audit row.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb, inTransaction } from "./db";
import { config } from "./config";
import { audit } from "./audit";
import { redact } from "./redact";
import { getUser } from "./users";
import { send } from "./messages";
import { ApiError, NotFoundError, ValidationError, ForbiddenError } from "./errors";
import type { AuditVia } from "./types";
import {
  blobExists,
  commitUpload,
  discardUpload,
  newFileId,
  readBlob,
  removeBlob,
  stageUpload,
  readBlobSync,
  stageBuffer,
  sweepStaleTemps,
  UploadTooLargeError,
  type StagedUpload,
  volumeUsage,
  type VolumeUsage,
} from "./file-store";

/** How long a download link works. */
export const FILE_LINK_TTL_MINUTES = 60;
/** Longest file name kept. */
export const FILE_NAME_MAX = 200;
/** Most people one file may be shared with. */
export const FILE_SHARES_MAX = 50;
/** The note sent with a delivery message. */
export const FILE_NOTE_MAX = 2000;
/** Largest file a bab_files get returns inline as text. */
export const FILE_INLINE_MAX_BYTES = 256 * 1024;

/** What every caller is told about content. Shown in the tool description and the docs. */
export const FILES_CONTENT_RULE =
  "Never upload confidential data: no customer data, database dumps, credentials, secrets or personal data.";

/** Extensions refused as executables. Source code (.sh, .py, .js) is allowed: it is text. */
const EXECUTABLE_EXTENSIONS = new Set([
  "exe", "dll", "sys", "scr", "com", "pif", "cpl", "msi", "msp", "msix", "msixbundle", "appx", "appxbundle",
  "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "jse", "wsf", "wsh", "hta", "lnk", "reg", "gadget",
  "jar", "apk", "aab", "ipa", "app", "dmg", "pkg", "deb", "rpm", "elf", "so", "dylib", "bin", "run", "xll",
]);

/** First bytes of native executables: PE (MZ), ELF, Mach-O (both byte orders, 32 and 64 bit), fat Mach-O / Java class. */
const EXECUTABLE_MAGIC: Buffer[] = [
  Buffer.from([0x4d, 0x5a]),
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
];

/** 413: the upload is bigger than the per-file cap. */
export class FileTooLargeError extends ApiError {
  constructor(message: string) {
    super(message, 413);
    this.name = "FileTooLargeError";
  }
}

/** 507: the owner's quota or the volume has no room for this upload. */
export class InsufficientStorageError extends ApiError {
  constructor(message: string) {
    super(message, 507);
    this.name = "InsufficientStorageError";
  }
}

/** 404 with a reason: the file store is switched off (BAB_FILES=0). */
export function assertFilesEnabled(): void {
  if (!config().files.enabled) throw new NotFoundError("The file store is switched off on this BAB");
}

export interface FileRow {
  id: string;
  owner_id: string;
  name: string;
  size: number;
  sha256: string;
  org_visible: number;
  created_at: string;
  expires_at: string;
  deleted_at: string | null;
  removed_at: string | null;
}

export interface FileView {
  id: string;
  name: string;
  size: number;
  sha256: string;
  owner: string;
  orgVisible: boolean;
  createdAt: string;
  expiresAt: string;
  /** Only on the caller's own files: who else may fetch it. */
  sharedWith?: string[];
  own?: true;
}

export interface QuotaUsage {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  files: number;
}

const nowIso = (now: number = Date.now()): string => new Date(now).toISOString();

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** The name kept for a file: the last path segment, no control characters, at most FILE_NAME_MAX. */
export function cleanFileName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const last = text.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const name = last.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name === "." || name === "..") throw new ValidationError("name is required: the file name, such as report.md");
  if (name.length > FILE_NAME_MAX) throw new ValidationError(`name must be ${FILE_NAME_MAX} characters or fewer`);
  if (redact(name) !== name) throw new ValidationError("name looks like it holds a secret or an email address; rename the file");
  return name;
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Refuses executables by extension (from the name alone, so before any upload). */
export function assertNotExecutableName(name: string): void {
  const ext = extensionOf(name);
  if (EXECUTABLE_EXTENSIONS.has(ext)) throw new ValidationError(`.${ext} files are refused: BAB does not store executables`);
}

/** Refuses executables by their first bytes. */
export function assertNotExecutableContent(head: Buffer): void {
  if (EXECUTABLE_MAGIC.some((m) => head.length >= m.length && head.subarray(0, m.length).equals(m))) {
    throw new ValidationError("this looks like an executable program, and BAB does not store executables");
  }
}

/** Expiry in days from the caller, else the default. Whole days, 1 to the maximum. */
export function parseExpiryDays(raw: unknown): number {
  const f = config().files;
  if (raw == null || raw === "") return f.defaultExpiryDays;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > f.maxExpiryDays) {
    throw new ValidationError(`expiresInDays must be a whole number from 1 to ${f.maxExpiryDays}`);
  }
  return n;
}

/** People to share with: user ids (emails), known to BAB, at most FILE_SHARES_MAX. */
export function parseShareList(raw: unknown): string[] {
  if (raw == null || raw === "") return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const ids = [...new Set(list.map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
  if (ids.length > FILE_SHARES_MAX) throw new ValidationError(`share with at most ${FILE_SHARES_MAX} people`);
  for (const id of ids) {
    if (!getUser(id)) throw new ValidationError(`Unknown user ${id}: find people with bab_people`);
  }
  return ids;
}

function parseBool(raw: unknown, name: string): boolean | undefined {
  if (raw == null || raw === "") return undefined;
  if (raw === true || raw === false) return raw;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ValidationError(`${name} must be true or false`);
}

/** Bytes still on disk for this owner: every file not yet removed, live, expired or deleted. */
export function quotaUsage(ownerId: string): QuotaUsage {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(size), 0) AS used, COUNT(*) AS n FROM files WHERE owner_id = ? AND removed_at IS NULL")
    .get(ownerId) as unknown as { used: number; n: number };
  const quotaBytes = config().files.userQuotaBytes;
  const usedBytes = Number(row.used);
  return { usedBytes, quotaBytes, remainingBytes: Math.max(quotaBytes - usedBytes, 0), files: Number(row.n) };
}

function quotaMessage(u: QuotaUsage, size: number): string {
  return (
    `Over your file quota: this file is ${size} bytes (${mb(size)}), you use ${u.usedBytes} of ${u.quotaBytes} bytes ` +
    `(${mb(u.usedBytes)} of ${mb(u.quotaBytes)}), ${u.remainingBytes} bytes (${mb(u.remainingBytes)}) remain. ` +
    "Delete files you no longer need (bab_files action=delete) or wait for one to expire."
  );
}

function assertVolumeRoom(extraBytes: number): void {
  const v = volumeUsage();
  if (!v) return;
  const limit = config().files.diskFullPercent;
  const after = ((v.usedBytes + extraBytes) / v.totalBytes) * 100;
  if (v.usedPercent > limit || after > limit) {
    throw new InsufficientStorageError(
      `BAB's disk is too full for uploads (${v.usedPercent}% used, uploads stop above ${limit}%). Try again later or tell a BAB maintainer.`,
    );
  }
}

function visibleTo(db: ReturnType<typeof getDb>, file: FileRow, actorId: string): boolean {
  if (file.owner_id === actorId) return true;
  if (file.org_visible) return true;
  return !!db.prepare("SELECT 1 FROM file_shares WHERE file_id = ? AND user_id = ?").get(file.id, actorId);
}

/** True while a file can still be fetched: not deleted, not expired, bytes not removed. */
function isLive(file: FileRow, now: string = nowIso()): boolean {
  return !file.deleted_at && !file.removed_at && file.expires_at > now;
}

function sharesOf(db: ReturnType<typeof getDb>, id: string): string[] {
  return (db.prepare("SELECT user_id FROM file_shares WHERE file_id = ? ORDER BY user_id").all(id) as unknown as { user_id: string }[]).map((r) => r.user_id);
}

function viewOf(db: ReturnType<typeof getDb>, file: FileRow, actorId: string): FileView {
  const own = file.owner_id === actorId;
  return {
    id: file.id,
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    owner: file.owner_id,
    orgVisible: !!file.org_visible,
    createdAt: file.created_at,
    expiresAt: file.expires_at,
    ...(own ? { sharedWith: sharesOf(db, file.id), own: true as const } : {}),
  };
}

/** A live file the actor may fetch, else 404. */
export function fileForActor(actorId: string, id: string): FileRow {
  assertFilesEnabled();
  const db = getDb();
  const file = db.prepare("SELECT * FROM files WHERE id = ?").get(String(id)) as unknown as FileRow | undefined;
  if (!file || !isLive(file) || !visibleTo(db, file, actorId)) throw new NotFoundError("File not found (or expired, deleted, or not shared with you)");
  return file;
}

export function fileView(actorId: string, id: string): FileView {
  return viewOf(getDb(), fileForActor(actorId, id), actorId);
}

export interface LinkResult {
  url: string;
  expiresAt: string;
}

/** A new download link for a file the actor may fetch. Only the token's hash is stored. */
export function createDownloadLink(actorId: string, id: string, origin: string): LinkResult {
  const file = fileForActor(actorId, id);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = nowIso(Date.now() + FILE_LINK_TTL_MINUTES * 60 * 1000);
  const linkExpires = expiresAt < file.expires_at ? expiresAt : file.expires_at;
  getDb().prepare("INSERT INTO file_links (token_hash, file_id, created_by, expires_at) VALUES (?, ?, ?, ?)").run(hashToken(token), file.id, actorId, linkExpires);
  return { url: `${origin}/api/files/dl/${token}`, expiresAt: linkExpires };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The live file a download link points to, and who made the link; null for an unknown, expired or malformed token. */
export function resolveDownloadLink(token: string): { file: FileRow; createdBy: string } | null {
  if (!config().files.enabled) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const db = getDb();
  const link = db.prepare("SELECT file_id, created_by, expires_at FROM file_links WHERE token_hash = ?").get(hashToken(token)) as unknown as
    | { file_id: string; created_by: string; expires_at: string }
    | undefined;
  const now = nowIso();
  if (!link || link.expires_at <= now) return null;
  const file = db.prepare("SELECT * FROM files WHERE id = ?").get(link.file_id) as unknown as FileRow | undefined;
  if (!file || !isLive(file, now)) return null;
  // The link stops working once its maker can no longer see the file (unshared, made private).
  if (!visibleTo(db, file, link.created_by)) return null;
  return { file, createdBy: link.created_by };
}

/** Records a fetch and returns the bytes. */
export function openForDownload(file: FileRow, actorId: string, via: AuditVia, how: "direct" | "link" | "inline"): ReadableStream<Uint8Array> {
  if (!blobExists(file.id)) throw new NotFoundError("File not found (its bytes are gone)");
  audit(getDb(), actorId, "file_get", "file", file.id, via, { details: { how, size: file.size } });
  return readBlob(file.id);
}

export interface PutInput {
  ownerId: string;
  name: unknown;
  body: ReadableStream<Uint8Array> | Uint8Array | null;
  /** Content-Length when the caller sent one: lets an oversized upload be refused before it is read. */
  declaredSize?: number | null;
  expiresInDays?: unknown;
  shareWith?: unknown;
  orgVisible?: unknown;
  /** A person to tell about the file: it is shared with them and a BAB message names it. */
  to?: unknown;
  subject?: unknown;
  note?: unknown;
}

export interface PutResult {
  file: FileView;
  download: LinkResult;
  usage: QuotaUsage;
  /** Set when `to` was given: the delivery message. */
  delivery?: { to: string; threadId: string; messageId: string };
}

interface PreparedPut {
  ownerId: string;
  name: string;
  days: number;
  orgVisible: boolean;
  shares: string[];
  to: string | null;
  note: string;
  subject: string;
}

/** Everything that needs no bytes: name, type, recipient, caps from the declared size, disk. */
function preparePut(input: PutInput): PreparedPut {
  assertFilesEnabled();
  const f = config().files;
  const name = cleanFileName(input.name);
  assertNotExecutableName(name);
  const days = parseExpiryDays(input.expiresInDays);
  const orgVisible = parseBool(input.orgVisible, "orgVisible") ?? false;
  const shares = parseShareList(input.shareWith);
  const to = input.to == null || input.to === "" ? null : String(input.to).trim().toLowerCase();
  if (to && !getUser(to)) throw new ValidationError(`Unknown recipient ${to}: find people with bab_people`);
  const note = input.note == null ? "" : String(input.note).trim();
  if (note.length > FILE_NOTE_MAX) throw new ValidationError(`note must be ${FILE_NOTE_MAX} characters or fewer`);
  const subject = input.subject == null ? "" : String(input.subject).trim();

  // Expired and deleted files whose bytes are still on disk: remove them now, so they stop counting.
  purgeRemovable();

  const declared = input.declaredSize == null ? NaN : Number(input.declaredSize);
  if (Number.isFinite(declared) && declared > f.maxFileBytes) throw new FileTooLargeError(tooLargeMessage(declared));
  if (Number.isFinite(declared) && declared > 0) {
    const u = quotaUsage(input.ownerId);
    if (declared > u.remainingBytes) throw new InsufficientStorageError(quotaMessage(u, declared));
  }
  assertVolumeRoom(Number.isFinite(declared) && declared > 0 ? declared : 0);
  return { ownerId: input.ownerId, name, days, orgVisible, shares, to, note, subject };
}

function tooLargeMessage(size?: number): string {
  const max = config().files.maxFileBytes;
  return `File too large: ${size != null ? size + " bytes, " : ""}the limit is ${max} bytes (${mb(max)}) per file. Split it, or compress it.`;
}

/** Records a staged upload: content checks, quota under a transaction, the row, the move into place, the delivery message. */
function finishPut(p: PreparedPut, staged: StagedUpload, via: AuditVia, origin: string): PutResult {
  try {
    if (staged.size === 0) throw new ValidationError("The file is empty: send its bytes as the request body");
    assertNotExecutableContent(staged.head);
    assertVolumeRoom(0);
  } catch (err) {
    discardUpload(staged);
    throw err;
  }

  const db = getDb();
  const id = newFileId();
  const now = Date.now();
  const createdAt = nowIso(now);
  const expiresAt = nowIso(now + p.days * 24 * 60 * 60 * 1000);
  const shareIds = [...new Set([...p.shares, ...(p.to ? [p.to] : [])])].filter((s) => s !== p.ownerId);
  try {
    // Quota check and insert in one transaction: two uploads by one owner cannot both slip under the cap.
    inTransaction(db, () => {
      const u = quotaUsage(p.ownerId);
      if (staged.size > u.remainingBytes) throw new InsufficientStorageError(quotaMessage(u, staged.size));
      db.prepare(
        `INSERT INTO files (id, owner_id, name, size, sha256, org_visible, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, p.ownerId, p.name, staged.size, staged.sha256, p.orgVisible ? 1 : 0, createdAt, expiresAt);
      for (const s of shareIds) db.prepare("INSERT OR IGNORE INTO file_shares (file_id, user_id) VALUES (?, ?)").run(id, s);
      audit(db, p.ownerId, "file_put", "file", id, via, { details: { size: staged.size, sha256: staged.sha256, expiresAt, orgVisible: p.orgVisible, shares: shareIds.length } });
    });
  } catch (err) {
    discardUpload(staged);
    throw err;
  }
  try {
    commitUpload(staged, id);
  } catch (err) {
    const t = nowIso();
    db.prepare("UPDATE files SET removed_at = ?, deleted_at = COALESCE(deleted_at, ?) WHERE id = ?").run(t, t, id);
    discardUpload(staged);
    throw err;
  }

  const file = db.prepare("SELECT * FROM files WHERE id = ?").get(id) as unknown as FileRow;
  const download = createDownloadLink(p.ownerId, id, origin);
  const result: PutResult = { file: viewOf(db, file, p.ownerId), download, usage: quotaUsage(p.ownerId) };

  if (p.to) {
    const lines = [
      ...(p.note ? [p.note, ""] : []),
      `File: ${p.name} (${staged.size} bytes, sha256 ${staged.sha256}), id ${id}, kept until ${expiresAt}.`,
      `Fetch it with bab_files action=get id=${id}, or GET ${origin}/api/files/${id}/content with your BAB identity.`,
    ];
    const sent = send({ fromId: p.ownerId, to: p.to, subject: p.subject || `File: ${p.name}`, body: lines.join("\n") }, via);
    result.delivery = { to: sent.message.to_id, threadId: sent.thread.id, messageId: sent.message.id };
  }
  return result;
}

/**
 * Stores one file from a request body. Checks everything that needs no bytes first, then streams
 * the body to disk with the per-file cap enforced on the bytes themselves (Content-Length is only a
 * hint), then checks the quota again and records the row in one transaction.
 */
export async function putFile(input: PutInput, via: AuditVia, origin: string): Promise<PutResult> {
  const p = preparePut(input);
  let staged: StagedUpload;
  try {
    staged = await stageUpload(input.body, config().files.maxFileBytes);
  } catch (err) {
    if (err instanceof UploadTooLargeError) throw new FileTooLargeError(tooLargeMessage());
    throw err;
  }
  return finishPut(p, staged, via, origin);
}

/** The same for bytes already in memory (the MCP tool), synchronously. */
export function putFileBytes(input: PutInput & { body: Uint8Array }, via: AuditVia, origin: string): PutResult {
  const p = preparePut({ ...input, declaredSize: input.body.byteLength });
  let staged: StagedUpload;
  try {
    staged = stageBuffer(input.body, config().files.maxFileBytes);
  } catch (err) {
    if (err instanceof UploadTooLargeError) throw new FileTooLargeError(tooLargeMessage(input.body.byteLength));
    throw err;
  }
  return finishPut(p, staged, via, origin);
}

export interface FileListing {
  files: FileView[];
  /** Live files others shared with the caller or made visible to the whole org. */
  shared: FileView[];
  usage: QuotaUsage;
}

/** The caller's live files and the files they may fetch from others, newest first. */
export function listFiles(actorId: string, limit = 200): FileListing {
  assertFilesEnabled();
  const db = getDb();
  const now = nowIso();
  const own = db
    .prepare("SELECT * FROM files WHERE owner_id = ? AND deleted_at IS NULL AND removed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT ?")
    .all(actorId, now, limit) as unknown as FileRow[];
  const shared = db
    .prepare(
      `SELECT * FROM files WHERE owner_id != ? AND deleted_at IS NULL AND removed_at IS NULL AND expires_at > ?
         AND (org_visible = 1 OR id IN (SELECT file_id FROM file_shares WHERE user_id = ?))
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(actorId, now, actorId, limit) as unknown as FileRow[];
  return { files: own.map((r) => viewOf(db, r, actorId)), shared: shared.map((r) => viewOf(db, r, actorId)), usage: quotaUsage(actorId) };
}

function ownFile(actorId: string, id: string): FileRow {
  const file = fileForActor(actorId, id);
  if (file.owner_id !== actorId) throw new ForbiddenError("Only the file's owner can do this");
  return file;
}

/** Deletes the caller's own file. Its bytes go at once, so the quota frees at once. */
export function deleteFile(actorId: string, id: string, via: AuditVia): { deleted: string; usage: QuotaUsage } {
  const file = ownFile(actorId, id);
  const db = getDb();
  const now = nowIso();
  inTransaction(db, () => {
    db.prepare("UPDATE files SET deleted_at = ? WHERE id = ?").run(now, file.id);
    db.prepare("DELETE FROM file_links WHERE file_id = ?").run(file.id);
    db.prepare("DELETE FROM file_shares WHERE file_id = ?").run(file.id);
    audit(db, actorId, "file_delete", "file", file.id, via, { details: { size: file.size } });
  });
  if (removeBlob(file.id)) db.prepare("UPDATE files SET removed_at = ? WHERE id = ?").run(nowIso(), file.id);
  return { deleted: file.id, usage: quotaUsage(actorId) };
}

export interface UpdateInput {
  shareWith?: unknown;
  unshare?: unknown;
  orgVisible?: unknown;
  /** Days from now. May shorten; may lengthen only up to the maximum counted from the upload. */
  expiresInDays?: unknown;
}

/** The owner shares, unshares, opens to the org or changes the expiry. */
export function updateFile(actorId: string, id: string, input: UpdateInput, via: AuditVia): FileView {
  const file = ownFile(actorId, id);
  const db = getDb();
  const add = parseShareList(input.shareWith).filter((s) => s !== actorId);
  const remove = input.unshare == null || input.unshare === "" ? [] : (Array.isArray(input.unshare) ? input.unshare : String(input.unshare).split(",")).map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  const org = parseBool(input.orgVisible, "orgVisible");
  let expiresAt: string | undefined;
  if (input.expiresInDays != null && input.expiresInDays !== "") {
    const days = parseExpiryDays(input.expiresInDays);
    expiresAt = nowIso(Date.now() + days * 24 * 60 * 60 * 1000);
    const ceiling = nowIso(Date.parse(file.created_at) + config().files.maxExpiryDays * 24 * 60 * 60 * 1000);
    if (expiresAt > ceiling) throw new ValidationError(`A file is kept at most ${config().files.maxExpiryDays} days from its upload, until ${ceiling}`);
  }
  if (!add.length && !remove.length && org === undefined && !expiresAt) {
    throw new ValidationError("Nothing to change: pass shareWith, unshare, orgVisible or expiresInDays");
  }
  const existing = sharesOf(db, file.id).length;
  if (existing + add.length > FILE_SHARES_MAX) throw new ValidationError(`share with at most ${FILE_SHARES_MAX} people`);
  inTransaction(db, () => {
    for (const s of add) db.prepare("INSERT OR IGNORE INTO file_shares (file_id, user_id) VALUES (?, ?)").run(file.id, s);
    for (const s of remove) db.prepare("DELETE FROM file_shares WHERE file_id = ? AND user_id = ?").run(file.id, s);
    if (org !== undefined) db.prepare("UPDATE files SET org_visible = ? WHERE id = ?").run(org ? 1 : 0, file.id);
    if (expiresAt) db.prepare("UPDATE files SET expires_at = ? WHERE id = ?").run(expiresAt, file.id);
    audit(db, actorId, "file_update", "file", file.id, via, { details: { shared: add.length, unshared: remove.length, orgVisible: org, expiresAt } });
  });
  const fresh = db.prepare("SELECT * FROM files WHERE id = ?").get(file.id) as unknown as FileRow;
  return viewOf(db, fresh, actorId);
}

/**
 * Removes the bytes of every expired or deleted file still on disk, plus dead download links and
 * stale temp uploads. Runs from maintenance and at the start of each upload. Returns the number of
 * files whose bytes were removed.
 */
export function purgeRemovable(now: number = Date.now(), limit = 500): number {
  const db = getDb();
  const iso = nowIso(now);
  const rows = db
    .prepare("SELECT id, owner_id, size, deleted_at FROM files WHERE removed_at IS NULL AND (deleted_at IS NOT NULL OR expires_at <= ?) LIMIT ?")
    .all(iso, limit) as unknown as { id: string; owner_id: string; size: number; deleted_at: string | null }[];
  let removed = 0;
  for (const r of rows) {
    if (!removeBlob(r.id)) continue;
    inTransaction(db, () => {
      db.prepare("UPDATE files SET removed_at = ? WHERE id = ?").run(iso, r.id);
      db.prepare("DELETE FROM file_links WHERE file_id = ?").run(r.id);
      db.prepare("DELETE FROM file_shares WHERE file_id = ?").run(r.id);
      if (!r.deleted_at) audit(db, "system", "file_expire", "file", r.id, "mcp", { details: { owner: r.owner_id, size: r.size } });
    });
    removed += 1;
  }
  db.prepare("DELETE FROM file_links WHERE expires_at <= ?").run(iso);
  sweepStaleTemps(now);
  return removed;
}

export interface FilesAdminSummary {
  volume: VolumeUsage | null;
  diskFullPercent: number;
  uploadsBlocked: boolean;
  liveFiles: number;
  bytesOnDisk: number;
  owners: number;
  topOwners: { owner: string; bytes: number; files: number }[];
}

/** For maintainers: the volume, and who uses the store. */
export function filesAdminSummary(): FilesAdminSummary {
  const db = getDb();
  const volume = volumeUsage();
  const limit = config().files.diskFullPercent;
  const totals = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, COUNT(DISTINCT owner_id) AS owners FROM files WHERE removed_at IS NULL")
    .get() as unknown as { n: number; bytes: number; owners: number };
  const top = db
    .prepare("SELECT owner_id AS owner, SUM(size) AS bytes, COUNT(*) AS files FROM files WHERE removed_at IS NULL GROUP BY owner_id ORDER BY bytes DESC LIMIT 10")
    .all() as unknown as { owner: string; bytes: number; files: number }[];
  return {
    volume,
    diskFullPercent: limit,
    uploadsBlocked: !!volume && volume.usedPercent > limit,
    liveFiles: Number(totals.n),
    bytesOnDisk: Number(totals.bytes),
    owners: Number(totals.owners),
    topOwners: top.map((t) => ({ owner: t.owner, bytes: Number(t.bytes), files: Number(t.files) })),
  };
}

/** For bab_files get: the text of a small UTF-8 file, else null. Records the fetch only when it returns text. */
export function inlineText(file: FileRow, actorId: string, via: AuditVia): string | null {
  if (file.size > FILE_INLINE_MAX_BYTES) return null;
  if (!blobExists(file.id)) throw new NotFoundError("File not found (its bytes are gone)");
  const buf = readBlobSync(file.id);
  if (buf.includes(0)) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (text.includes("�")) return null;
  audit(getDb(), actorId, "file_get", "file", file.id, via, { details: { how: "inline", size: file.size } });
  return text;
}
