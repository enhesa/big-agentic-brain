/**
 * The key-value store: small, short-lived coordination state that agents share through BAB, such as
 * locks, counters and a pace for bulk work (docs/kv.md). Rules:
 *
 * - Atomic by construction: one Map in one process, and no operation awaits anything, so no other
 *   request runs in the middle of one. That holds only for one BAB process: with BAB_REPLICAS above 1
 *   every call is refused.
 * - Namespaces: `u/<your id>/...` is yours alone (a key with no namespace goes there), and
 *   `shared/<name>/...` only for names in BAB_KV_SHARED_NAMESPACES, open to every bound identity.
 *   Anything else is refused. Nobody reads or lists another person's keys.
 * - Only a caller whose identity BAB remembers or checks may use it (lib/bound-identity.ts).
 * - Every key has a TTL (1 second to BAB_KV_MAX_TTL_SECONDS). Expired keys go when touched, and a
 *   sweep runs every minute. Values are JSON, at most BAB_KV_MAX_VALUE_BYTES; values that look like a
 *   secret or personal data are refused. Never for secrets, credentials or personal data.
 * - Locks and throttles are their own kinds of key: their token is never shown, and set, cas and incr
 *   cannot overwrite them.
 * - Live keys are written to DATA_DIR/kv-snapshot.json every 30 seconds when something changed and on
 *   SIGTERM, and read back at start without the expired ones. A crash loses at most 30 seconds.
 * - Writes are audited (user, key, operation, result), never values. Reads are not.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getDb, resolveDataDir } from "./db";
import { config } from "./config";
import { audit } from "./audit";
import { sensitiveKind } from "./file-checks";
import { assertBoundIdentity, type BoundCaller } from "./bound-identity";
import { checkKvRateLimit, KV_RATE_LIMIT_BURST, KV_RATE_LIMIT_PER_MINUTE } from "./rate-limit";
import { ApiError, ForbiddenError, NotFoundError, TooManyRequestsError, ValidationError } from "./errors";
import type { AuditVia } from "./types";

/** Longest key, counted after the namespace prefix. */
export const KV_KEY_MAX_CHARS = 200;
/** Longest interval a throttle may ask for, and the furthest ahead it may book a slot. */
export const KV_THROTTLE_MAX_SECONDS = 3600;
/** Most keys one list returns. */
export const KV_LIST_MAX = 1000;
/** How often changed state is written to disk, and how often expired keys are swept. */
export const KV_SNAPSHOT_INTERVAL_MS = 30_000;
export const KV_SWEEP_INTERVAL_MS = 60_000;
/** Bytes counted for a lock or throttle entry besides its key. */
const ENTRY_OVERHEAD_BYTES = 64;

/** What every caller is told about content. Shown in the tool description and the docs. */
export const KV_CONTENT_RULE =
  "Never store secrets, credentials or personal data: short-lived coordination state only (locks, counters, pacing, progress markers).";

export const KV_ACTIONS = ["get", "set", "cas", "incr", "delete", "list", "throttle", "lock", "unlock", "renew"] as const;
export type KvAction = (typeof KV_ACTIONS)[number];

type Kind = "value" | "lock" | "throttle";

interface Entry {
  kind: Kind;
  /** JSON text of the value (kind value only). */
  value?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Whose limits it counts against: a user id, or shared/<name>. */
  bucket: string;
  bytes: number;
  /** lock: who holds it, and the token that releases it (never shown). */
  holder?: string;
  token?: string;
  /** throttle: the last slot handed out, epoch milliseconds. */
  slotAt?: number;
}

interface Usage {
  keys: number;
  bytes: number;
}

interface Store {
  entries: Map<string, Entry>;
  usage: Map<string, Usage>;
  totalBytes: number;
  dirty: boolean;
  timers: ReturnType<typeof setInterval>[];
}

/**
 * One store per process, kept on globalThis: the SIGTERM handler (instrumentation-node.ts) and the
 * route handlers may load this module in different bundles, and both must see the same Map.
 */
const GLOBAL_KEY = "__babKvStore";
type Holder = { [GLOBAL_KEY]?: Store };

function existingStore(): Store | undefined {
  return (globalThis as Holder)[GLOBAL_KEY];
}

function store(): Store {
  const g = globalThis as Holder;
  let s = g[GLOBAL_KEY];
  if (!s) {
    s = { entries: new Map(), usage: new Map(), totalBytes: 0, dirty: false, timers: [] };
    g[GLOBAL_KEY] = s;
    loadSnapshotInto(s, Date.now());
    const save = setInterval(() => saveKvSnapshot(), KV_SNAPSHOT_INTERVAL_MS);
    const sweep = setInterval(() => sweepExpired(), KV_SWEEP_INTERVAL_MS);
    save.unref?.();
    sweep.unref?.();
    s.timers.push(save, sweep);
  }
  return s;
}

/** Test-only: forget the store (without saving) and stop its timers. */
export function _resetKvForTests(): void {
  const s = existingStore();
  if (s) for (const t of s.timers) clearInterval(t);
  delete (globalThis as Holder)[GLOBAL_KEY];
}

export function snapshotPath(): string {
  return path.join(resolveDataDir(), "kv-snapshot.json");
}

// ---------------------------------------------------------------------------
// Errors and checks
// ---------------------------------------------------------------------------

/** 507: the caller's, the namespace's or the whole store's limit has no room. */
export class KvFullError extends ApiError {
  constructor(message: string) {
    super(message, 507);
    this.name = "KvFullError";
  }
}

/** 409: the key holds another kind, or a value incr cannot add to. */
export class KvConflictError extends ApiError {
  constructor(message: string) {
    super(message, 409);
    this.name = "KvConflictError";
  }
}

/** 404 when switched off; 503 when more than one replica is configured. */
export function assertKvEnabled(): void {
  const c = config();
  if (!c.kv.enabled) throw new NotFoundError("The key-value store is switched off on this BAB");
  if (c.replicas > 1) {
    throw new ApiError(
      `The key-value store is off: BAB_REPLICAS is ${c.replicas}, and its operations are atomic only in one BAB process. Tell a BAB maintainer.`,
      503,
    );
  }
}

/** The identity rule of the file store (lib/bound-identity.ts). BAB_KV_ALLOW_DECLARED=1 lifts it for local development. */
export function assertKvIdentity(caller: BoundCaller): void {
  assertBoundIdentity(caller, config().kv.allowDeclared, "The key-value store");
}

/** The per-person pace for the store, on top of the general API limit. */
export function assertKvRate(actorId: string): void {
  if (!checkKvRateLimit(actorId)) {
    throw new TooManyRequestsError(
      `Too many key-value calls: at most ${KV_RATE_LIMIT_PER_MINUTE} a minute, ${KV_RATE_LIMIT_BURST} at once. Wait a few seconds; a throttle answer tells you how long to sleep.`,
    );
  }
}

const SEGMENT_RE = /^[a-z0-9._-]+$/;

/** Refuses a key part that is not lowercase segments of [a-z0-9._-] joined by single slashes, or that holds . or .. segments. */
function checkName(name: string, what: string): void {
  if (!name) throw new ValidationError(`${what} needs a name after the namespace, such as ${what === "key" ? "u/<your id>/build/lock or just build/lock" : "build/"}`);
  if (name.length > KV_KEY_MAX_CHARS) throw new ValidationError(`${what} must be ${KV_KEY_MAX_CHARS} characters or fewer after the namespace`);
  const segments = name.split("/");
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg) || seg === "." || seg === "..") {
      throw new ValidationError(`${what} may hold only lowercase letters, digits, dots, underscores and hyphens, in segments joined by single slashes (no empty, . or .. segments)`);
    }
  }
}

export interface ResolvedKey {
  /** The key as stored and shown: u/<id>/<name> or shared/<ns>/<name>. */
  key: string;
  /** u/<id>/ or shared/<ns>/. */
  namespace: string;
  /** Whose limits it counts against. */
  bucket: string;
  /** True for the caller's own u/ namespace. */
  own: boolean;
}

function sharedNamespaceRefusal(ns: string): ForbiddenError {
  const allowed = config().kv.sharedNamespaces;
  return new ForbiddenError(
    `shared/${ns}/ is not a shared namespace on this BAB. ` +
      (allowed.length ? `Shared namespaces: ${allowed.map((n) => `shared/${n}/`).join(", ")}. ` : "This BAB has no shared namespaces. ") +
      "Use your own namespace (leave the prefix out), or ask a BAB maintainer to add one (BAB_KV_SHARED_NAMESPACES).",
  );
}

/**
 * Splits a raw key (or, with `prefix`, a list prefix) into its namespace and name, and refuses
 * anything outside the caller's own u/ namespace and the allowed shared ones. No lowercasing, no
 * decoding: a key is taken exactly as given, so "U/..", "%2e%2e" or "shared/Build" are refused, not
 * mapped somewhere else.
 */
function splitKey(actorId: string, raw: unknown, prefix: boolean): { namespace: string; bucket: string; own: boolean; rest: string } {
  if (raw != null && typeof raw !== "string") throw new ValidationError(`${prefix ? "prefix" : "key"} must be a string`);
  const text = raw ?? "";
  const ownNs = `u/${actorId}/`;
  if (text === "u" || text.startsWith("u/")) {
    // u/ alone, or u/<id> without the slash, as a list prefix: the caller's own space if it is theirs.
    if (prefix && (text === "u" || text === "u/" || text === `u/${actorId}`)) return { namespace: ownNs, bucket: actorId, own: true, rest: "" };
    if (!text.startsWith(ownNs)) {
      throw new ForbiddenError("Keys under u/ belong to one person: use u/<your own id>/, or leave the prefix out and the key goes there.");
    }
    return { namespace: ownNs, bucket: actorId, own: true, rest: text.slice(ownNs.length) };
  }
  if (text === "shared" || text.startsWith("shared/")) {
    const after = text.slice("shared/".length);
    const slash = after.indexOf("/");
    const ns = slash < 0 ? after : after.slice(0, slash);
    if (!ns) throw new ForbiddenError("Name a shared namespace: shared/<name>/... Listing every shared namespace is not offered.");
    if (!config().kv.sharedNamespaces.includes(ns)) throw sharedNamespaceRefusal(ns);
    return { namespace: `shared/${ns}/`, bucket: `shared/${ns}`, own: false, rest: slash < 0 ? "" : after.slice(slash + 1) };
  }
  return { namespace: ownNs, bucket: actorId, own: true, rest: text };
}

export function resolveKey(actorId: string, raw: unknown): ResolvedKey {
  if (raw == null || raw === "") throw new ValidationError("key is required");
  const p = splitKey(actorId, raw, false);
  checkName(p.rest, "key");
  return { key: p.namespace + p.rest, namespace: p.namespace, bucket: p.bucket, own: p.own };
}

/** A list prefix: the namespace plus a start of a name, which may end with "/" or stop mid-segment. */
export function resolvePrefix(actorId: string, raw: unknown): { prefix: string; namespace: string } {
  const p = splitKey(actorId, raw, true);
  if (p.rest) {
    if (p.rest.length > KV_KEY_MAX_CHARS) throw new ValidationError(`prefix must be ${KV_KEY_MAX_CHARS} characters or fewer after the namespace`);
    const trimmed = p.rest.endsWith("/") ? p.rest.slice(0, -1) : p.rest;
    // The last segment may be partial ("build" for build-1, build-2), never . or .. or empty.
    checkName(trimmed, "prefix");
  }
  return { prefix: p.namespace + p.rest, namespace: p.namespace };
}

/** TTL in whole seconds, 1 to the maximum. Required: a key without one would live for ever. */
export function parseTtl(raw: unknown, what = "ttlSeconds"): number {
  const max = config().kv.maxTtlSeconds;
  if (raw == null || raw === "") throw new ValidationError(`${what} is required: whole seconds from 1 to ${max}`);
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ValidationError(`${what} must be whole seconds from 1 to ${max}`);
  return n;
}

function parseBool(raw: unknown, name: string): boolean {
  if (raw == null || raw === "") return false;
  if (raw === true || raw === false) return raw;
  const v = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ValidationError(`${name} must be true or false`);
}

/** JSON text with object keys sorted, so equal values compare equal whatever their key order. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
  }
  const text = JSON.stringify(v);
  if (text === undefined) throw new ValidationError("value must be JSON: a string, number, true, false, null, an array or an object");
  return text;
}

/** A value as stored: canonical JSON within the size cap, refused when it looks like a secret or personal data. */
function encodeValue(raw: unknown, what = "value"): string {
  if (raw === undefined) throw new ValidationError(`${what} is required`);
  if (typeof raw === "number" && !Number.isFinite(raw)) throw new ValidationError(`${what} must be a finite number`);
  const text = canonicalJson(raw);
  const max = config().kv.maxValueBytes;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > max) throw new ValidationError(`${what} is ${bytes} bytes as JSON; the limit is ${max} bytes. Store a pointer (a file id, a url) instead of the data.`);
  const kind = sensitiveKind(typeof raw === "string" ? raw : text);
  if (kind) throw new ValidationError(`This ${what} holds ${kind}, and the key-value store never keeps confidential data. Store a reference to it instead, never the thing itself.`);
  return text;
}

/** Compares a stored value with a caller's expected one, as canonical JSON. No size or secret check: it is never stored. */
function sameValue(stored: string | undefined, expected: unknown): boolean {
  if (stored === undefined || expected === undefined) return false;
  let text: string;
  try {
    text = canonicalJson(expected);
  } catch {
    return false;
  }
  return stored === text;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// The Map, its usage counts and expiry
// ---------------------------------------------------------------------------

function entryBytes(key: string, e: Pick<Entry, "kind" | "value">): number {
  return Buffer.byteLength(key, "utf8") + (e.kind === "value" ? Buffer.byteLength(e.value ?? "", "utf8") : ENTRY_OVERHEAD_BYTES);
}

function usageOf(s: Store, bucket: string): Usage {
  return s.usage.get(bucket) ?? { keys: 0, bytes: 0 };
}

function removeEntry(s: Store, key: string): void {
  const e = s.entries.get(key);
  if (!e) return;
  s.entries.delete(key);
  const u = usageOf(s, e.bucket);
  const next = { keys: u.keys - 1, bytes: u.bytes - e.bytes };
  if (next.keys <= 0) s.usage.delete(e.bucket);
  else s.usage.set(e.bucket, next);
  s.totalBytes -= e.bytes;
  s.dirty = true;
}

/** The live entry under a key; an expired one is removed on the way. */
function live(s: Store, key: string, now: number): Entry | undefined {
  const e = s.entries.get(key);
  if (!e) return undefined;
  if (e.expiresAt <= now) {
    removeEntry(s, key);
    return undefined;
  }
  return e;
}

/**
 * Puts an entry in place of whatever the key held, after the caller's (or namespace's) key and byte
 * limits and the store's total. Synchronous: the check and the write cannot be split by another call.
 */
function writeEntry(s: Store, key: string, entry: Omit<Entry, "bytes">): Entry {
  const k = config().kv;
  const bytes = entryBytes(key, entry);
  const old = s.entries.get(key);
  const u = usageOf(s, entry.bucket);
  const addKeys = old ? 0 : 1;
  const addBytes = bytes - (old?.bytes ?? 0);
  const whose = entry.bucket.startsWith("shared/") ? `The namespace ${entry.bucket}/` : "You";
  if (u.keys + addKeys > k.maxKeysPerUser) {
    throw new KvFullError(`${whose} already hold${whose === "You" ? "" : "s"} ${u.keys} keys, the limit is ${k.maxKeysPerUser}. Delete keys you no longer need, or let them expire.`);
  }
  if (u.bytes + addBytes > k.maxBytesPerUser) {
    throw new KvFullError(`${whose} would hold ${u.bytes + addBytes} bytes, the limit is ${k.maxBytesPerUser}. Delete keys you no longer need, or store smaller values.`);
  }
  if (s.totalBytes + addBytes > k.maxTotalBytes) {
    throw new KvFullError("The key-value store is full on this BAB. Try again later, or tell a BAB maintainer.");
  }
  const full: Entry = { ...entry, bytes };
  s.entries.set(key, full);
  s.usage.set(entry.bucket, { keys: u.keys + addKeys, bytes: u.bytes + addBytes });
  s.totalBytes += addBytes;
  s.dirty = true;
  return full;
}

/** Removes every expired key. Runs every minute; returns how many went. */
export function sweepExpired(now: number = Date.now()): number {
  const s = existingStore();
  if (!s) return 0;
  let n = 0;
  for (const [key, e] of s.entries) {
    if (e.expiresAt <= now) {
      removeEntry(s, key);
      n += 1;
    }
  }
  return n;
}

const ttlLeft = (e: Entry, now: number): number => Math.max(0, Math.ceil((e.expiresAt - now) / 1000));

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface SnapshotFile {
  version: 1;
  savedAt: string;
  entries: [string, Entry][];
}

/**
 * Writes the live keys to DATA_DIR/kv-snapshot.json when anything changed since the last write
 * (or always, with `force`). Synchronous, through a temp file and a rename, so the SIGTERM handler
 * can call it and a crash mid-write never leaves half a file. Never throws: it logs and carries on.
 */
export function saveKvSnapshot(force = false): boolean {
  const s = existingStore();
  if (!s || (!s.dirty && !force)) return false;
  const now = Date.now();
  const entries: [string, Entry][] = [];
  for (const [key, e] of s.entries) if (e.expiresAt > now) entries.push([key, e]);
  const file = snapshotPath();
  const tmp = file + ".tmp";
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body: SnapshotFile = { version: 1, savedAt: new Date(now).toISOString(), entries };
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, file);
    s.dirty = false;
    return true;
  } catch (err) {
    console.warn("bab: could not write the key-value snapshot: " + (err instanceof Error ? err.message : String(err)));
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    return false;
  }
}

/** Saves on shutdown, only when the store was ever used in this process. */
export function flushKvSnapshot(): void {
  if (existingStore()) saveKvSnapshot();
}

function validEntry(key: unknown, e: unknown): e is Entry {
  if (typeof key !== "string" || !e || typeof e !== "object") return false;
  const x = e as Record<string, unknown>;
  if (typeof x.expiresAt !== "number" || typeof x.bucket !== "string") return false;
  if (x.kind === "value") return typeof x.value === "string";
  if (x.kind === "lock") return typeof x.holder === "string" && typeof x.token === "string";
  if (x.kind === "throttle") return typeof x.slotAt === "number";
  return false;
}

/** Reads the snapshot into an empty store, dropping expired and malformed entries. A missing file is a fresh start. */
function loadSnapshotInto(s: Store, now: number): void {
  let raw: string;
  try {
    raw = readFileSync(snapshotPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("bab: could not read the key-value snapshot; starting empty: " + (err as Error).message);
    return;
  }
  let parsed: SnapshotFile;
  try {
    parsed = JSON.parse(raw) as SnapshotFile;
  } catch {
    console.warn("bab: the key-value snapshot is not valid JSON; starting empty.");
    return;
  }
  if (!parsed || !Array.isArray(parsed.entries)) return;
  for (const item of parsed.entries) {
    if (!Array.isArray(item)) continue;
    const [rawKey, e] = item as [unknown, unknown];
    if (typeof rawKey !== "string" || !validEntry(rawKey, e) || e.expiresAt <= now) continue;
    const key = rawKey;
    const bytes = entryBytes(key, e);
    const entry: Entry = { kind: e.kind, expiresAt: e.expiresAt, bucket: e.bucket, bytes };
    if (e.kind === "value") entry.value = e.value;
    if (e.kind === "lock") {
      entry.holder = e.holder;
      entry.token = e.token;
    }
    if (e.kind === "throttle") entry.slotAt = e.slotAt;
    s.entries.set(key, entry);
    const u = usageOf(s, entry.bucket);
    s.usage.set(entry.bucket, { keys: u.keys + 1, bytes: u.bytes + bytes });
    s.totalBytes += bytes;
  }
}

// ---------------------------------------------------------------------------
// Operations. Each is synchronous from its first read to its last write.
// ---------------------------------------------------------------------------

export interface KvActor {
  id: string;
}

function auditWrite(actorId: string, op: string, key: string, result: string, via: AuditVia, extra?: Record<string, unknown>): void {
  audit(getDb(), actorId, `kv_${op}`, "kv", key, via, { details: { result, ...extra } });
}

function wrongKind(key: string, e: Entry, op: string): KvConflictError {
  const how =
    e.kind === "lock"
      ? "release it with unlock and its token, or wait for its TTL"
      : e.kind === "throttle"
        ? "a throttle key only takes throttle calls; wait for its TTL"
        : "a value key takes get, set, cas, incr and delete; use another key";
  return new KvConflictError(`${key} holds a ${e.kind}, so ${op} does not work on it: ${how}`);
}

function decode(text: string | undefined): unknown {
  return text === undefined ? undefined : JSON.parse(text);
}

export interface KvGetResult {
  key: string;
  found: boolean;
  kind?: Kind;
  value?: unknown;
  ttlSeconds?: number;
  holder?: string;
  slotAt?: string;
}

function view(key: string, e: Entry, now: number): KvGetResult {
  const out: KvGetResult = { key, found: true, kind: e.kind, ttlSeconds: ttlLeft(e, now) };
  if (e.kind === "value") out.value = decode(e.value);
  if (e.kind === "lock") out.holder = e.holder;
  if (e.kind === "throttle") out.slotAt = new Date(e.slotAt ?? now).toISOString();
  return out;
}

export function kvGet(actor: KvActor, rawKey: unknown): KvGetResult {
  const k = resolveKey(actor.id, rawKey);
  const now = Date.now();
  const e = live(store(), k.key, now);
  return e ? view(k.key, e, now) : { key: k.key, found: false };
}

export interface SetInput {
  key: unknown;
  value: unknown;
  ttlSeconds: unknown;
  ifAbsent?: unknown;
  ifExists?: unknown;
}

export function kvSet(actor: KvActor, input: SetInput, via: AuditVia): { key: string; set: boolean; reason?: string; ttlSeconds: number } {
  const k = resolveKey(actor.id, input.key);
  const ttl = parseTtl(input.ttlSeconds);
  const ifAbsent = parseBool(input.ifAbsent, "ifAbsent");
  const ifExists = parseBool(input.ifExists, "ifExists");
  if (ifAbsent && ifExists) throw new ValidationError("ifAbsent and ifExists cannot both be true");
  const value = encodeValue(input.value);
  const s = store();
  const now = Date.now();
  const e = live(s, k.key, now);
  if (e && e.kind !== "value") throw wrongKind(k.key, e, "set");
  if (ifAbsent && e) {
    auditWrite(actor.id, "set", k.key, "exists", via);
    return { key: k.key, set: false, reason: "exists", ttlSeconds: ttlLeft(e, now) };
  }
  if (ifExists && !e) {
    auditWrite(actor.id, "set", k.key, "missing", via);
    return { key: k.key, set: false, reason: "missing", ttlSeconds: 0 };
  }
  writeEntry(s, k.key, { kind: "value", value, expiresAt: now + ttl * 1000, bucket: k.bucket });
  auditWrite(actor.id, "set", k.key, "set", via, { ttlSeconds: ttl });
  return { key: k.key, set: true, ttlSeconds: ttl };
}

export interface CasInput {
  key: unknown;
  expected: unknown;
  value: unknown;
  ttlSeconds: unknown;
}

export function kvCas(actor: KvActor, input: CasInput, via: AuditVia): { key: string; swapped: boolean; found: boolean; current?: unknown; ttlSeconds?: number } {
  const k = resolveKey(actor.id, input.key);
  const ttl = parseTtl(input.ttlSeconds);
  if (input.expected === undefined) throw new ValidationError("expected is required: the value you read. To create a key only when it is missing, use set with ifAbsent.");
  const value = encodeValue(input.value);
  const s = store();
  const now = Date.now();
  const e = live(s, k.key, now);
  if (e && e.kind !== "value") throw wrongKind(k.key, e, "cas");
  if (!e || !sameValue(e.value, input.expected)) {
    auditWrite(actor.id, "cas", k.key, e ? "mismatch" : "missing", via);
    return e ? { key: k.key, swapped: false, found: true, current: decode(e.value), ttlSeconds: ttlLeft(e, now) } : { key: k.key, swapped: false, found: false };
  }
  writeEntry(s, k.key, { kind: "value", value, expiresAt: now + ttl * 1000, bucket: k.bucket });
  auditWrite(actor.id, "cas", k.key, "swapped", via, { ttlSeconds: ttl });
  return { key: k.key, swapped: true, found: true, ttlSeconds: ttl };
}

export interface IncrInput {
  key: unknown;
  by?: unknown;
  ttlSeconds?: unknown;
}

export function kvIncr(actor: KvActor, input: IncrInput, via: AuditVia): { key: string; value: number; created: boolean; ttlSeconds: number } {
  const k = resolveKey(actor.id, input.key);
  const by = input.by == null || input.by === "" ? 1 : typeof input.by === "number" ? input.by : Number(input.by);
  if (!Number.isSafeInteger(by)) throw new ValidationError("by must be a whole number");
  const s = store();
  const now = Date.now();
  const e = live(s, k.key, now);
  if (e && e.kind !== "value") throw wrongKind(k.key, e, "incr");
  if (!e) {
    const ttl = parseTtl(input.ttlSeconds, "ttlSeconds (needed when incr creates the key)");
    writeEntry(s, k.key, { kind: "value", value: String(by), expiresAt: now + ttl * 1000, bucket: k.bucket });
    auditWrite(actor.id, "incr", k.key, "created", via, { by });
    return { key: k.key, value: by, created: true, ttlSeconds: ttl };
  }
  const current = decode(e.value);
  if (typeof current !== "number" || !Number.isSafeInteger(current)) throw new KvConflictError(`${k.key} does not hold a whole number, so incr cannot add to it`);
  const next = current + by;
  if (!Number.isSafeInteger(next)) throw new KvConflictError(`${k.key} would leave the range of safe whole numbers`);
  // The TTL stays as it was: a counter is a window, and incr must not keep it alive for ever.
  writeEntry(s, k.key, { kind: "value", value: String(next), expiresAt: e.expiresAt, bucket: k.bucket });
  auditWrite(actor.id, "incr", k.key, "incremented", via, { by });
  return { key: k.key, value: next, created: false, ttlSeconds: ttlLeft(e, now) };
}

export function kvDelete(actor: KvActor, input: { key: unknown; expected?: unknown }, via: AuditVia): { key: string; deleted: boolean; reason?: string } {
  const k = resolveKey(actor.id, input.key);
  const s = store();
  const now = Date.now();
  const e = live(s, k.key, now);
  if (!e) {
    auditWrite(actor.id, "delete", k.key, "missing", via);
    return { key: k.key, deleted: false, reason: "missing" };
  }
  // In a shared namespace a lock or a throttle is everyone's: only its token, or its TTL, ends it.
  if (e.kind !== "value" && (!k.own || input.expected !== undefined)) throw wrongKind(k.key, e, "delete");
  if (input.expected !== undefined && !sameValue(e.value, input.expected)) {
    auditWrite(actor.id, "delete", k.key, "mismatch", via);
    return { key: k.key, deleted: false, reason: "mismatch" };
  }
  removeEntry(s, k.key);
  auditWrite(actor.id, "delete", k.key, "deleted", via);
  return { key: k.key, deleted: true };
}

export function kvList(actor: KvActor, rawPrefix: unknown): { prefix: string; keys: KvGetResult[]; truncated: boolean } {
  const { prefix } = resolvePrefix(actor.id, rawPrefix);
  const s = store();
  const now = Date.now();
  const keys: KvGetResult[] = [];
  const names = [...s.entries.keys()].filter((key) => key.startsWith(prefix)).sort();
  for (const key of names) {
    const e = live(s, key, now);
    if (!e) continue;
    if (keys.length >= KV_LIST_MAX) return { prefix, keys, truncated: true };
    // Keys and TTLs only: read a value with get.
    const v = view(key, e, now);
    delete v.value;
    keys.push(v);
  }
  return { prefix, keys, truncated: false };
}

/**
 * Books the next slot on a pace shared by everyone who calls with this key: slot = max(now, last
 * slot + interval). The caller sleeps waitSeconds, then does its work. Booking is atomic, so N
 * callers at once get N slots `interval` apart. At most KV_THROTTLE_MAX_SECONDS ahead.
 */
export function kvThrottle(actor: KvActor, input: { key: unknown; minIntervalSeconds: unknown }, via: AuditVia): { key: string; waitSeconds: number; slotAt: string } {
  const k = resolveKey(actor.id, input.key);
  const raw = input.minIntervalSeconds;
  const interval = raw == null || raw === "" ? NaN : typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(interval) || interval < 0.1 || interval > KV_THROTTLE_MAX_SECONDS) {
    throw new ValidationError(`minIntervalSeconds is required: seconds from 0.1 to ${KV_THROTTLE_MAX_SECONDS}`);
  }
  const intervalMs = Math.round(interval * 1000);
  const s = store();
  const now = Date.now();
  const e = live(s, k.key, now);
  if (e && e.kind !== "throttle") throw wrongKind(k.key, e, "throttle");
  const slot = e?.slotAt == null ? now : Math.max(now, e.slotAt + intervalMs);
  const waitMs = slot - now;
  if (waitMs > KV_THROTTLE_MAX_SECONDS * 1000) {
    auditWrite(actor.id, "throttle", k.key, "too_far", via, { minIntervalSeconds: interval });
    throw new TooManyRequestsError(`${k.key} is booked more than ${KV_THROTTLE_MAX_SECONDS} seconds ahead: try again later`);
  }
  // Kept until the slot plus one interval: after that the next caller may go at once anyway.
  writeEntry(s, k.key, { kind: "throttle", slotAt: slot, expiresAt: slot + Math.max(intervalMs, 1000), bucket: k.bucket });
  auditWrite(actor.id, "throttle", k.key, waitMs > 0 ? "wait" : "now", via, { minIntervalSeconds: interval, waitMs });
  return { key: k.key, waitSeconds: Math.round(waitMs) / 1000, slotAt: new Date(slot).toISOString() };
}

export type LockResult =
  | { key: string; acquired: true; token: string; ttlSeconds: number }
  | { key: string; acquired: false; holder: string; ttlSeconds: number };

/** Takes a lock that nobody holds: returns a token that releases or renews it. Not re-entrant. */
export function kvLock(actor: KvActor, input: { key: unknown; ttlSeconds: unknown }, via: AuditVia): LockResult {
  const k = resolveKey(actor.id, input.key);
  const ttl = parseTtl(input.ttlSeconds);
  const s = store();
  const now = Date.now();
  const e = live(s, k.key, now);
  if (e && e.kind !== "lock") throw wrongKind(k.key, e, "lock");
  if (e) {
    auditWrite(actor.id, "lock", k.key, "held", via);
    return { key: k.key, acquired: false, holder: e.holder ?? "", ttlSeconds: ttlLeft(e, now) };
  }
  const token = randomBytes(24).toString("base64url");
  writeEntry(s, k.key, { kind: "lock", holder: actor.id, token, expiresAt: now + ttl * 1000, bucket: k.bucket });
  auditWrite(actor.id, "lock", k.key, "acquired", via, { ttlSeconds: ttl });
  return { key: k.key, acquired: true, token, ttlSeconds: ttl };
}

function lockFor(s: Store, key: string, token: unknown, now: number): { e?: Entry; reason?: string } {
  if (typeof token !== "string" || !token) throw new ValidationError("token is required: the one lock returned");
  const e = live(s, key, now);
  if (!e) return { reason: "not_held" };
  if (e.kind !== "lock") throw wrongKind(key, e, "unlock");
  if (!safeEqual(token, e.token ?? "")) return { reason: "token_mismatch" };
  return { e };
}

/** Releases a lock, only with the token that took it. */
export function kvUnlock(actor: KvActor, input: { key: unknown; token: unknown }, via: AuditVia): { key: string; released: boolean; reason?: string } {
  const k = resolveKey(actor.id, input.key);
  const s = store();
  const { e, reason } = lockFor(s, k.key, input.token, Date.now());
  if (!e) {
    auditWrite(actor.id, "unlock", k.key, reason ?? "refused", via);
    return { key: k.key, released: false, reason };
  }
  removeEntry(s, k.key);
  auditWrite(actor.id, "unlock", k.key, "released", via);
  return { key: k.key, released: true };
}

/** Extends a lock to ttlSeconds from now, only with the token that took it. */
export function kvRenew(actor: KvActor, input: { key: unknown; token: unknown; ttlSeconds: unknown }, via: AuditVia): { key: string; renewed: boolean; reason?: string; ttlSeconds?: number } {
  const k = resolveKey(actor.id, input.key);
  const ttl = parseTtl(input.ttlSeconds);
  const s = store();
  const now = Date.now();
  const { e, reason } = lockFor(s, k.key, input.token, now);
  if (!e) {
    auditWrite(actor.id, "renew", k.key, reason ?? "refused", via);
    return { key: k.key, renewed: false, reason };
  }
  writeEntry(s, k.key, { kind: "lock", holder: e.holder, token: e.token, expiresAt: now + ttl * 1000, bucket: e.bucket });
  auditWrite(actor.id, "renew", k.key, "renewed", via, { ttlSeconds: ttl });
  return { key: k.key, renewed: true, ttlSeconds: ttl };
}

/** What the caller holds, for list answers and the docs. */
export function kvUsage(actorId: string): { keys: number; bytes: number; maxKeys: number; maxBytes: number } {
  const u = usageOf(store(), actorId);
  const k = config().kv;
  return { keys: u.keys, bytes: u.bytes, maxKeys: k.maxKeysPerUser, maxBytes: k.maxBytesPerUser };
}

/**
 * The one entry point for the REST route and the MCP tool: switch, identity, pace, then the action.
 * `args` is the tool's arguments or the request's JSON body.
 */
export function runKv(actor: KvActor & BoundCaller, args: Record<string, unknown>, via: AuditVia): unknown {
  const action = typeof args.action === "string" ? args.action : "";
  if (!KV_ACTIONS.includes(action as KvAction)) {
    throw new ValidationError(`action must be one of ${KV_ACTIONS.join(", ")}; required, has no default`);
  }
  assertKvEnabled();
  assertKvIdentity(actor);
  assertKvRate(actor.id);
  switch (action as KvAction) {
    case "get":
      return kvGet(actor, args.key);
    case "set":
      return kvSet(actor, { key: args.key, value: args.value, ttlSeconds: args.ttlSeconds, ifAbsent: args.ifAbsent, ifExists: args.ifExists }, via);
    case "cas":
      return kvCas(actor, { key: args.key, expected: args.expected, value: args.value, ttlSeconds: args.ttlSeconds }, via);
    case "incr":
      return kvIncr(actor, { key: args.key, by: args.by, ttlSeconds: args.ttlSeconds }, via);
    case "delete":
      return kvDelete(actor, { key: args.key, expected: args.expected }, via);
    case "list":
      return { ...kvList(actor, args.prefix), usage: kvUsage(actor.id) };
    case "throttle":
      return kvThrottle(actor, { key: args.key, minIntervalSeconds: args.minIntervalSeconds }, via);
    case "lock":
      return kvLock(actor, { key: args.key, ttlSeconds: args.ttlSeconds }, via);
    case "unlock":
      return kvUnlock(actor, { key: args.key, token: args.token }, via);
    case "renew":
      return kvRenew(actor, { key: args.key, token: args.token, ttlSeconds: args.ttlSeconds }, via);
  }
}
