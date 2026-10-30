/**
 * The key-value store: small, short-lived coordination state that agents share through BAB, such as
 * locks, counters and a pace for bulk work (docs/kv.md). Rules:
 *
 * - Atomic by construction: one Map in one process, and no operation awaits anything, so no other
 *   request runs in the middle of one. That holds only for one BAB process: with BAB_REPLICAS above 1
 *   every call is refused, and a lease file (lib/kv-lease.ts) keeps a second process off the store.
 * - Namespaces: `u/<your id>/...` is the caller's own (a key with no namespace goes there), and
 *   `shared/<name>/...` only for names in BAB_KV_SHARED_NAMESPACES, open to every bound identity.
 *   Anything else is refused. The API never reads or lists another person's u/ keys.
 * - Only a caller whose identity BAB remembers or checks may use it (lib/bound-identity.ts).
 * - Every key has a TTL (1 second to BAB_KV_MAX_TTL_SECONDS, shorter in shared namespaces). Expired
 *   keys go when touched, and a sweep runs every minute. Values are JSON, at most
 *   BAB_KV_MAX_VALUE_BYTES; values that look like a secret or personal data are refused.
 * - In a shared namespace each key counts against whoever wrote it too, so one person cannot fill it
 *   for everyone. Maintainers can force-delete a key and purge one person's keys.
 * - Locks and throttles are their own kinds of key: their token is never shown, and set, cas and incr
 *   cannot overwrite them. A throttle keeps the interval it was created with.
 * - Live keys are written to DATA_DIR/kv-snapshot.json every 30 seconds when something changed and on
 *   SIGTERM, and read back (and checked again) at start. A crash loses at most 30 seconds.
 * - Writes are audited (user, key, operation, result), never values. A write whose audit row fails is
 *   undone. Reads get only the generic request row.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { getDb, resolveDataDir } from "./db";
import { config } from "./config";
import { audit } from "./audit";
import { sensitiveKind } from "./file-checks";
import { redact } from "./redact";
import { isMaintainer } from "./feedback";
import { assertBoundIdentity, type BoundCaller } from "./bound-identity";
import { ensureKvLease, holdsKvLease, releaseKvLease, _resetKvLeaseForTests } from "./kv-lease";
import { checkKvRateLimit, KV_RATE_LIMIT_BURST, KV_RATE_LIMIT_PER_MINUTE } from "./rate-limit";
import { ApiError, ForbiddenError, NotFoundError, TooManyRequestsError, ValidationError } from "./errors";
import type { AuditVia } from "./types";

/** Longest key, counted after the namespace prefix. */
export const KV_KEY_MAX_CHARS = 200;
/** Longest interval a throttle may ask for, and the furthest ahead it may book a slot (shortened by the TTL cap). */
export const KV_THROTTLE_MAX_SECONDS = 3600;
/** Future slots one person may hold on one throttle at once, so nobody can book the pace far ahead. */
export const KV_THROTTLE_SLOTS_PER_PERSON = 4;
/** Most keys one list returns. */
export const KV_LIST_MAX = 1000;
/** Deepest nesting a value may have. */
export const KV_VALUE_MAX_DEPTH = 64;
/** How often changed state is written to disk, and how often expired keys are swept. */
export const KV_SNAPSHOT_INTERVAL_MS = 30_000;
export const KV_SWEEP_INTERVAL_MS = 60_000;
/** Bytes counted for a lock or throttle entry besides its key. */
const ENTRY_OVERHEAD_BYTES = 64;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** What every caller is told about content. Shown in the tool description and the docs. */
export const KV_CONTENT_RULE =
  "Never store secrets, credentials or personal data: short-lived coordination state only (locks, counters, pacing, progress markers).";

export const KV_ACTIONS = ["get", "set", "cas", "incr", "delete", "list", "throttle", "lock", "unlock", "renew", "force_delete", "purge"] as const;
export type KvAction = (typeof KV_ACTIONS)[number];

type Kind = "value" | "lock" | "throttle";

interface Entry {
  kind: Kind;
  /** JSON text of the value (kind value only). */
  value?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Who wrote it last (a value), holds it (a lock) or created it (a throttle). Shared keys count against them. */
  writer: string;
  bytes: number;
  /** lock: who holds it, and the token that releases it (never shown). */
  holder?: string;
  token?: string;
  /** throttle: the last slot handed out, the interval fixed at creation, when it was created, and each person's future slots. */
  slotAt?: number;
  intervalMs?: number;
  createdAt?: number;
  booked?: Record<string, number[]>;
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

/**
 * 503: another BAB process serves the store on this data volume, this process lost the lease to one
 * (it stays off until it restarts), or DATA_DIR cannot take the lease file.
 */
function leaseRefusal(why: "other" | "lost" | "unwritable"): ApiError {
  const messages = {
    other: "The key-value store is off in this BAB process: another BAB process serves it on the same data (DATA_DIR/kv.lease). BAB must run as one replica. Tell a BAB maintainer.",
    lost: "The key-value store is off in this BAB process: another BAB process took it over on the same data (DATA_DIR/kv.lease), and it stays off here until this BAB restarts. BAB must run as one replica. Tell a BAB maintainer.",
    unwritable: "The key-value store is off in this BAB process: it cannot write its lease file, DATA_DIR/kv.lease. Check that DATA_DIR is writable. Tell a BAB maintainer.",
  };
  return new ApiError(messages[why], 503);
}

function store(): Store {
  const g = globalThis as Holder;
  let s = g[GLOBAL_KEY];
  if (!s) {
    // Take the lease before reading the snapshot: a second process must not load, serve or save it.
    const lease = ensureKvLease();
    if (lease !== "held") throw leaseRefusal(lease);
    s = { entries: new Map(), usage: new Map(), totalBytes: 0, dirty: false, timers: [] };
    g[GLOBAL_KEY] = s;
    loadSnapshotInto(s, Date.now());
    const save = setInterval(() => saveKvSnapshot(), KV_SNAPSHOT_INTERVAL_MS);
    const sweep = setInterval(() => sweepExpired(), KV_SWEEP_INTERVAL_MS);
    save.unref?.();
    sweep.unref?.();
    s.timers.push(save, sweep);
  } else if (!holdsKvLease()) {
    // Lost the lease at a heartbeat: another process took over. This process never takes it back.
    throw leaseRefusal("lost");
  }
  return s;
}

/** Test-only: forget the store (without saving), its timers and the lease state. */
export function _resetKvForTests(): void {
  const s = existingStore();
  if (s) for (const t of s.timers) clearInterval(t);
  delete (globalThis as Holder)[GLOBAL_KEY];
  _resetKvLeaseForTests();
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

/** 409: the key holds another kind, a value incr cannot add to, or a throttle with another interval. */
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
  // Keys show in shared lists and in the audit log: refuse one that redaction would change.
  if (redact(name) !== name) {
    throw new ValidationError(`${what} looks like it holds a secret or personal data, such as a long number or a token; name it by what it is for, such as pr/1234 or build/lock`);
  }
}

export interface ResolvedKey {
  /** The key as stored and shown: u/<id>/<name> or shared/<ns>/<name>. */
  key: string;
  /** u/<id>/ or shared/<ns>/. */
  namespace: string;
  /** Whose limits it counts against: the owner's id, or shared/<ns>. */
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

function assertUsableId(actorId: string): void {
  // An id with a slash would make u/<id>/ a prefix of someone else's keys (u/a@x.com/s/ inside u/a@x.com/).
  if (actorId.includes("/") || !actorId) throw new ForbiddenError("The key-value store cannot serve an identity that contains a slash");
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
  assertUsableId(actorId);
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

/**
 * The bucket a stored key counts against, from the key alone, or null when the key is not one this
 * store could have written today (used to check the snapshot).
 */
function bucketOfStoredKey(key: string): string | null {
  const own = /^u\/([^/]+)\/(.+)$/.exec(key);
  const shared = /^shared\/([^/]+)\/(.+)$/.exec(key);
  const m = own ?? shared;
  if (!m) return null;
  if (shared && !config().kv.sharedNamespaces.includes(m[1])) return null;
  try {
    checkName(m[2], "key");
  } catch {
    return null;
  }
  return own ? m[1] : `shared/${m[1]}`;
}

const isShared = (bucket: string): boolean => bucket.startsWith("shared/");

/** The longest TTL a key in this bucket may have: shorter in shared namespaces. */
function maxTtlFor(bucket: string): number {
  const k = config().kv;
  return isShared(bucket) ? k.sharedMaxTtlSeconds : k.maxTtlSeconds;
}

/** TTL in whole seconds, 1 to the maximum for the key's namespace. Required: a key without one would live for ever. */
export function parseTtl(raw: unknown, what = "ttlSeconds", bucket = ""): number {
  const max = maxTtlFor(bucket);
  const where = isShared(bucket) ? " in a shared namespace" : "";
  if (raw == null || raw === "") throw new ValidationError(`${what} is required: whole seconds from 1 to ${max}${where}`);
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ValidationError(`${what} must be whole seconds from 1 to ${max}${where}`);
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
function canonicalJson(v: unknown, depth = 0): string {
  if (depth > KV_VALUE_MAX_DEPTH) throw new ValidationError(`value is nested more than ${KV_VALUE_MAX_DEPTH} levels deep`);
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x, depth + 1)).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k], depth + 1)).join(",") + "}";
  }
  const text = JSON.stringify(v);
  if (text === undefined) throw new ValidationError("value must be JSON: a string, number, true, false, null, an array or an object");
  return text;
}

function refuseSensitive(text: string, what: string): void {
  const kind = sensitiveKind(text);
  if (kind) throw new ValidationError(`This ${what} holds ${kind}, and the key-value store never keeps confidential data. Store a reference to it instead, never the thing itself.`);
}

/** A value as stored: canonical JSON within the size cap, refused when it looks like a secret or personal data. */
function encodeValue(raw: unknown, what = "value"): string {
  if (raw === undefined) throw new ValidationError(`${what} is required`);
  if (typeof raw === "number" && !Number.isFinite(raw)) throw new ValidationError(`${what} must be a finite number`);
  const text = canonicalJson(raw);
  const max = config().kv.maxValueBytes;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > max) throw new ValidationError(`${what} is ${bytes} bytes as JSON; the limit is ${max} bytes. Store a pointer (a file id, a url) instead of the data.`);
  refuseSensitive(typeof raw === "string" ? raw : text, what);
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

function usageOf(s: Store, k: string): Usage {
  return s.usage.get(k) ?? { keys: 0, bytes: 0 };
}

/** The usage counters a key moves: its bucket, and in a shared namespace the writer's share of it. */
function usageKeys(key: string, e: Pick<Entry, "writer">): string[] {
  const b = bucketOfKey(key);
  return isShared(b) ? [b, `${b}\u0000${e.writer}`] : [b];
}

/** The bucket of a key already resolved or validated: u/<id>/... or shared/<ns>/... */
function bucketOfKey(key: string): string {
  const parts = key.split("/");
  return parts[0] === "u" ? parts[1] : `shared/${parts[1]}`;
}

function addUsage(s: Store, key: string, e: Entry, sign: 1 | -1): void {
  for (const k of usageKeys(key, e)) {
    const u = usageOf(s, k);
    const next = { keys: u.keys + sign, bytes: u.bytes + sign * e.bytes };
    if (next.keys <= 0) s.usage.delete(k);
    else s.usage.set(k, next);
  }
  s.totalBytes += sign * e.bytes;
}

/** Puts an entry in, with no limit check: for the snapshot and for undoing a change. */
function insertRaw(s: Store, key: string, e: Entry): void {
  s.entries.set(key, e);
  addUsage(s, key, e, 1);
  s.dirty = true;
}

function removeRaw(s: Store, key: string): Entry | undefined {
  const e = s.entries.get(key);
  if (!e) return undefined;
  s.entries.delete(key);
  addUsage(s, key, e, -1);
  s.dirty = true;
  return e;
}

/** The live entry under a key; an expired one is removed on the way. */
function live(s: Store, key: string, now: number): Entry | undefined {
  const e = s.entries.get(key);
  if (!e) return undefined;
  if (e.expiresAt <= now) {
    removeRaw(s, key);
    return undefined;
  }
  return e;
}

/**
 * Refuses an entry the limits have no room for, counting the entry it would replace as gone: the
 * bucket's keys and bytes, in a shared namespace the writer's share of it, and the store's total.
 * A limit already passed (after a setting was lowered) only blocks growth.
 */
function assertRoom(s: Store, key: string, next: Entry): void {
  const k = config().kv;
  const old = s.entries.get(key);
  const bucket = bucketOfKey(key);
  const projected = (uk: string): { now: Usage; after: Usage } => {
    const now = usageOf(s, uk);
    let after = { ...now };
    if (old && usageKeys(key, old).includes(uk)) after = { keys: after.keys - 1, bytes: after.bytes - old.bytes };
    if (usageKeys(key, next).includes(uk)) after = { keys: after.keys + 1, bytes: after.bytes + next.bytes };
    return { now, after };
  };
  const grows = (p: { now: Usage; after: Usage }, field: "keys" | "bytes", limit: number) => p.after[field] > limit && p.after[field] > p.now[field];
  const b = projected(bucket);
  const whose = isShared(bucket) ? `The namespace ${bucket}/` : "You";
  if (grows(b, "keys", k.maxKeysPerUser)) {
    throw new KvFullError(`${whose} already hold${isShared(bucket) ? "s" : ""} ${b.now.keys} keys, the limit is ${k.maxKeysPerUser}. Delete keys you no longer need, or let them expire.`);
  }
  if (grows(b, "bytes", k.maxBytesPerUser)) {
    throw new KvFullError(`${whose} would hold ${b.after.bytes} bytes, the limit is ${k.maxBytesPerUser}. Delete keys you no longer need, or store smaller values.`);
  }
  if (isShared(bucket)) {
    const w = projected(`${bucket}\u0000${next.writer}`);
    if (grows(w, "keys", k.sharedMaxKeysPerUser)) {
      throw new KvFullError(`You already hold ${w.now.keys} keys in ${bucket}/, the limit per person is ${k.sharedMaxKeysPerUser}. Delete or unlock keys you no longer need, or let them expire.`);
    }
    if (grows(w, "bytes", k.sharedMaxBytesPerUser)) {
      throw new KvFullError(`You would hold ${w.after.bytes} bytes in ${bucket}/, the limit per person is ${k.sharedMaxBytesPerUser}. Store smaller values.`);
    }
  }
  const total = s.totalBytes - (old?.bytes ?? 0) + next.bytes;
  if (total > k.maxTotalBytes && total > s.totalBytes) {
    throw new KvFullError("The key-value store is full on this BAB. Try again later, or tell a BAB maintainer.");
  }
}

type NewEntry = Omit<Entry, "bytes">;

function sized(key: string, e: NewEntry): Entry {
  return { ...e, bytes: entryBytes(key, e) };
}

/**
 * Replaces (or removes, with `next` null) the entry under a key, then writes its audit row. If the
 * audit row cannot be written, the change is undone and the error goes up: a write is never kept
 * without its audit row, and a failed audit never leaves a lock nobody holds the token for.
 */
function commit(s: Store, key: string, next: Entry | null, record: () => void): void {
  if (next) assertRoom(s, key, next);
  const before = removeRaw(s, key);
  if (next) insertRaw(s, key, next);
  try {
    record();
  } catch (err) {
    removeRaw(s, key);
    if (before) insertRaw(s, key, before);
    throw err;
  }
}

/** Removes every expired key. Runs every minute; returns how many went. */
export function sweepExpired(now: number = Date.now()): number {
  const s = existingStore();
  if (!s) return 0;
  let n = 0;
  for (const [key, e] of s.entries) {
    if (e.expiresAt <= now) {
      removeRaw(s, key);
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
 * (or always, with `force`). Synchronous, through a temp file that is flushed to disk and renamed,
 * so the SIGTERM handler can call it and a crash mid-write never leaves half a file. Only the
 * process that holds the lease writes. Never throws: it logs and carries on.
 */
export function saveKvSnapshot(force = false): boolean {
  const s = existingStore();
  if (!s || (!s.dirty && !force) || !holdsKvLease()) return false;
  const now = Date.now();
  const entries: [string, Entry][] = [];
  for (const [key, e] of s.entries) if (e.expiresAt > now) entries.push([key, e]);
  const file = snapshotPath();
  const tmp = file + ".tmp";
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // A temp file left by a crash would otherwise be appended to or fail the exclusive open.
    rmSync(tmp, { force: true });
    const body: SnapshotFile = { version: 1, savedAt: new Date(now).toISOString(), entries };
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(body));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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

/** On shutdown: saves when the store was used in this process, then gives the lease up. */
export function flushKvSnapshot(): void {
  if (existingStore()) saveKvSnapshot();
  releaseKvLease();
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Checks one snapshot entry as strictly as a new write: the key must be one this store could have
 * written (an allowed namespace, a valid name), the expiry finite and within the namespace's TTL
 * from now, each kind's fields well formed. Returns the entry to load, or null to drop it.
 */
function checkedEntry(key: unknown, raw: unknown, now: number): Entry | null {
  if (typeof key !== "string" || !raw || typeof raw !== "object") return null;
  const bucket = bucketOfStoredKey(key);
  if (bucket === null) return null;
  const x = raw as Record<string, unknown>;
  if (!finite(x.expiresAt) || x.expiresAt <= now || x.expiresAt > now + maxTtlFor(bucket) * 1000) return null;
  const owner = isShared(bucket) ? null : bucket;
  const writer = typeof x.writer === "string" && x.writer && !x.writer.includes("/") ? x.writer : owner;
  if (x.kind === "value") {
    if (typeof x.value !== "string" || Buffer.byteLength(x.value, "utf8") > config().kv.maxValueBytes) return null;
    let value: string;
    try {
      // The same checks as a new write: JSON, size, depth, and no secret or personal data.
      value = encodeValue(JSON.parse(x.value));
    } catch {
      return null;
    }
    if (!writer || (owner && writer !== owner)) return null;
    return sized(key, { kind: "value", value, expiresAt: x.expiresAt, writer });
  }
  if (x.kind === "lock") {
    if (typeof x.holder !== "string" || !x.holder || x.holder.includes("/") || typeof x.token !== "string" || !TOKEN_RE.test(x.token)) return null;
    if (owner && x.holder !== owner) return null;
    return sized(key, { kind: "lock", holder: x.holder, token: x.token, expiresAt: x.expiresAt, writer: x.holder });
  }
  if (x.kind === "throttle") {
    const capMs = maxTtlFor(bucket) * 1000;
    const horizon = now + Math.min(KV_THROTTLE_MAX_SECONDS * 1000, capMs);
    if (!finite(x.slotAt) || x.slotAt > horizon || !finite(x.intervalMs) || x.intervalMs < 100 || x.intervalMs > Math.min(KV_THROTTLE_MAX_SECONDS * 1000, capMs)) return null;
    // A snapshot without createdAt gets the earliest one its expiry allows, so it still ends by then.
    const createdAt = x.createdAt === undefined ? x.expiresAt - capMs : x.createdAt;
    if (!finite(createdAt) || createdAt > now || x.expiresAt > createdAt + capMs) return null;
    if (!writer || (owner && writer !== owner)) return null;
    const booked: Record<string, number[]> = {};
    if (x.booked && typeof x.booked === "object") {
      for (const [who, slots] of Object.entries(x.booked as Record<string, unknown>)) {
        if (!Array.isArray(slots) || who.includes("/")) continue;
        const kept = slots.filter((t): t is number => finite(t) && t > now && t <= horizon).slice(-KV_THROTTLE_SLOTS_PER_PERSON);
        if (kept.length) booked[who] = kept;
      }
    }
    return sized(key, { kind: "throttle", slotAt: x.slotAt, intervalMs: x.intervalMs, booked, createdAt, expiresAt: x.expiresAt, writer });
  }
  return null;
}

/**
 * Reads the snapshot into an empty store. Every entry is checked again (checkedEntry), duplicates
 * keep the first, and the limits apply as to new writes. A missing file is a fresh start.
 */
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
  let dropped = 0;
  for (const item of parsed.entries) {
    if (!Array.isArray(item)) {
      dropped += 1;
      continue;
    }
    const [key, e] = item as [unknown, unknown];
    const entry = checkedEntry(key, e, now);
    if (!entry || s.entries.has(key as string)) {
      dropped += 1;
      continue;
    }
    try {
      assertRoom(s, key as string, entry);
    } catch {
      dropped += 1;
      continue;
    }
    insertRaw(s, key as string, entry);
  }
  s.dirty = false;
  if (dropped) console.warn(`bab: dropped ${dropped} key-value snapshot entries (expired, malformed, duplicated or over a limit).`);
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
  minIntervalSeconds?: number;
}

function view(key: string, e: Entry, now: number): KvGetResult {
  const out: KvGetResult = { key, found: true, kind: e.kind, ttlSeconds: ttlLeft(e, now) };
  if (e.kind === "value") out.value = decode(e.value);
  if (e.kind === "lock") out.holder = e.holder;
  if (e.kind === "throttle") {
    out.slotAt = new Date(e.slotAt ?? now).toISOString();
    out.minIntervalSeconds = (e.intervalMs ?? 0) / 1000;
  }
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
  const ttl = parseTtl(input.ttlSeconds, "ttlSeconds", k.bucket);
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
  commit(s, k.key, sized(k.key, { kind: "value", value, expiresAt: now + ttl * 1000, writer: actor.id }), () =>
    auditWrite(actor.id, "set", k.key, "set", via, { ttlSeconds: ttl }),
  );
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
  const ttl = parseTtl(input.ttlSeconds, "ttlSeconds", k.bucket);
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
  commit(s, k.key, sized(k.key, { kind: "value", value, expiresAt: now + ttl * 1000, writer: actor.id }), () =>
    auditWrite(actor.id, "cas", k.key, "swapped", via, { ttlSeconds: ttl }),
  );
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
  refuseSensitive(String(by), "number");
  const s = store();
  const now = Date.now();
  const e = live(s, k.key, now);
  if (e && e.kind !== "value") throw wrongKind(k.key, e, "incr");
  if (!e) {
    const ttl = parseTtl(input.ttlSeconds, "ttlSeconds (needed when incr creates the key)", k.bucket);
    commit(s, k.key, sized(k.key, { kind: "value", value: String(by), expiresAt: now + ttl * 1000, writer: actor.id }), () =>
      auditWrite(actor.id, "incr", k.key, "created", via, { by }),
    );
    return { key: k.key, value: by, created: true, ttlSeconds: ttl };
  }
  const current = decode(e.value);
  if (typeof current !== "number" || !Number.isSafeInteger(current)) throw new KvConflictError(`${k.key} does not hold a whole number, so incr cannot add to it`);
  const next = current + by;
  if (!Number.isSafeInteger(next)) throw new KvConflictError(`${k.key} would leave the range of safe whole numbers`);
  refuseSensitive(String(next), "number");
  // The TTL stays as it was: a counter is a window, and incr must not keep it alive for ever.
  commit(s, k.key, sized(k.key, { kind: "value", value: String(next), expiresAt: e.expiresAt, writer: actor.id }), () =>
    auditWrite(actor.id, "incr", k.key, "incremented", via, { by }),
  );
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
  // In a shared namespace a lock or a throttle is everyone's: only its token, its TTL or a maintainer ends it.
  if (e.kind !== "value" && (!k.own || input.expected !== undefined)) throw wrongKind(k.key, e, "delete");
  if (input.expected !== undefined && !sameValue(e.value, input.expected)) {
    auditWrite(actor.id, "delete", k.key, "mismatch", via);
    return { key: k.key, deleted: false, reason: "mismatch" };
  }
  commit(s, k.key, null, () => auditWrite(actor.id, "delete", k.key, "deleted", via));
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
 * callers at once get N slots `interval` apart. The interval is fixed by whoever created the key; a
 * different one is refused, so nobody can stretch or shrink the pace for others. One person holds
 * at most KV_THROTTLE_SLOTS_PER_PERSON future slots, and no slot is booked further ahead than
 * KV_THROTTLE_MAX_SECONDS (or the namespace's TTL cap, when shorter). The interval may not exceed
 * that TTL cap, and the key ends at most one TTL cap after it was created. No slot is handed out
 * whose interval would run past that end, so a key never expires before its last slot.
 */
export function kvThrottle(actor: KvActor, input: { key: unknown; minIntervalSeconds: unknown }, via: AuditVia): { key: string; waitSeconds: number; slotAt: string; minIntervalSeconds: number } {
  const k = resolveKey(actor.id, input.key);
  const raw = input.minIntervalSeconds;
  const interval = raw == null || raw === "" ? NaN : typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(interval) || interval < 0.1 || interval > KV_THROTTLE_MAX_SECONDS) {
    throw new ValidationError(`minIntervalSeconds is required: seconds from 0.1 to ${KV_THROTTLE_MAX_SECONDS}`);
  }
  const capSeconds = maxTtlFor(k.bucket);
  if (interval > capSeconds) {
    throw new ValidationError(`minIntervalSeconds must be at most ${capSeconds}${isShared(k.bucket) ? " in a shared namespace" : ""}: the longest TTL a key there may have`);
  }
  const intervalMs = Math.round(interval * 1000);
  const capMs = capSeconds * 1000;
  const aheadMs = Math.min(KV_THROTTLE_MAX_SECONDS * 1000, capMs);
  const s = store();
  const now = Date.now();
  const e = live(s, k.key, now);
  if (e && e.kind !== "throttle") throw wrongKind(k.key, e, "throttle");
  if (e && e.intervalMs !== intervalMs) {
    auditWrite(actor.id, "throttle", k.key, "interval_mismatch", via, { minIntervalSeconds: interval });
    throw new KvConflictError(
      `${k.key} paces at ${(e.intervalMs ?? 0) / 1000} seconds, set when it was created; call it with minIntervalSeconds ${(e.intervalMs ?? 0) / 1000}, or use another key. It expires in ${ttlLeft(e, now)} seconds.`,
    );
  }
  const booked: Record<string, number[]> = {};
  for (const [who, slots] of Object.entries(e?.booked ?? {})) {
    const future = slots.filter((t) => t > now);
    if (future.length) booked[who] = future;
  }
  const mine = booked[actor.id] ?? [];
  if (mine.length >= KV_THROTTLE_SLOTS_PER_PERSON) {
    auditWrite(actor.id, "throttle", k.key, "too_many_slots", via, { minIntervalSeconds: interval });
    throw new TooManyRequestsError(
      `You already hold ${mine.length} future slots on ${k.key} (at most ${KV_THROTTLE_SLOTS_PER_PERSON}): use them first. The next is at ${new Date(mine[0]).toISOString()}.`,
    );
  }
  const slot = e?.slotAt == null ? now : Math.max(now, e.slotAt + intervalMs);
  const waitMs = slot - now;
  if (waitMs > aheadMs) {
    auditWrite(actor.id, "throttle", k.key, "too_far", via, { minIntervalSeconds: interval });
    throw new TooManyRequestsError(`${k.key} is booked more than ${aheadMs / 1000} seconds ahead: try again later`);
  }
  // The key ends one TTL cap after its creation, so calls cannot keep a pinned pace alive for ever.
  // A slot whose interval would run past that end is refused: the key must outlive every slot it
  // handed out, or the next caller would start a fresh pace while old slots are still pending.
  const createdAt = e?.createdAt ?? now;
  const hardEnd = createdAt + capMs;
  if (slot + intervalMs > hardEnd) {
    auditWrite(actor.id, "throttle", k.key, "past_end", via, { minIntervalSeconds: interval });
    throw new TooManyRequestsError(
      `${k.key} is booked up to its end at ${new Date(hardEnd).toISOString()} (a throttle key lasts at most ${capSeconds} seconds from its creation): try again after that`,
    );
  }
  booked[actor.id] = [...mine, slot].filter((t) => t > now);
  // Kept until one interval after the last slot handed out, which never passes the hard end.
  const expiresAt = Math.max(slot + intervalMs, Math.min(now + 1000, hardEnd));
  commit(s, k.key, sized(k.key, { kind: "throttle", slotAt: slot, intervalMs, booked, createdAt, expiresAt, writer: e?.writer ?? actor.id }), () =>
    auditWrite(actor.id, "throttle", k.key, waitMs > 0 ? "wait" : "now", via, { minIntervalSeconds: interval, waitMs }),
  );
  return { key: k.key, waitSeconds: Math.round(waitMs) / 1000, slotAt: new Date(slot).toISOString(), minIntervalSeconds: interval };
}

export type LockResult =
  | { key: string; acquired: true; token: string; ttlSeconds: number }
  | { key: string; acquired: false; holder: string; ttlSeconds: number };

/** Takes a lock that nobody holds: returns a token that releases or renews it. Not re-entrant. */
export function kvLock(actor: KvActor, input: { key: unknown; ttlSeconds: unknown }, via: AuditVia): LockResult {
  const k = resolveKey(actor.id, input.key);
  const ttl = parseTtl(input.ttlSeconds, "ttlSeconds", k.bucket);
  const s = store();
  const now = Date.now();
  const e = live(s, k.key, now);
  if (e && e.kind !== "lock") throw wrongKind(k.key, e, "lock");
  if (e) {
    auditWrite(actor.id, "lock", k.key, "held", via);
    return { key: k.key, acquired: false, holder: e.holder ?? "", ttlSeconds: ttlLeft(e, now) };
  }
  const token = randomBytes(24).toString("base64url");
  commit(s, k.key, sized(k.key, { kind: "lock", holder: actor.id, token, expiresAt: now + ttl * 1000, writer: actor.id }), () =>
    auditWrite(actor.id, "lock", k.key, "acquired", via, { ttlSeconds: ttl }),
  );
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
  commit(s, k.key, null, () => auditWrite(actor.id, "unlock", k.key, "released", via));
  return { key: k.key, released: true };
}

/** Extends a lock to ttlSeconds from now, only with the token that took it. */
export function kvRenew(actor: KvActor, input: { key: unknown; token: unknown; ttlSeconds: unknown }, via: AuditVia): { key: string; renewed: boolean; reason?: string; ttlSeconds?: number } {
  const k = resolveKey(actor.id, input.key);
  const ttl = parseTtl(input.ttlSeconds, "ttlSeconds", k.bucket);
  const s = store();
  const now = Date.now();
  const { e, reason } = lockFor(s, k.key, input.token, now);
  if (!e) {
    auditWrite(actor.id, "renew", k.key, reason ?? "refused", via);
    return { key: k.key, renewed: false, reason };
  }
  commit(s, k.key, sized(k.key, { kind: "lock", holder: e.holder, token: e.token, expiresAt: now + ttl * 1000, writer: e.writer }), () =>
    auditWrite(actor.id, "renew", k.key, "renewed", via, { ttlSeconds: ttl }),
  );
  return { key: k.key, renewed: true, ttlSeconds: ttl };
}

// ---------------------------------------------------------------------------
// Maintainer actions: clear a squatted shared namespace.
// ---------------------------------------------------------------------------

function assertMaintainer(actorId: string, action: string): void {
  if (!isMaintainer(actorId)) throw new ForbiddenError(`${action} is for BAB maintainers only (BAB_MAINTAINERS)`);
}

/** Maintainers only: deletes any key in a shared namespace or their own space, a lock or throttle included. */
export function kvForceDelete(actor: KvActor, input: { key: unknown }, via: AuditVia): { key: string; deleted: boolean; kind?: Kind; writer?: string } {
  assertMaintainer(actor.id, "force_delete");
  const k = resolveKey(actor.id, input.key);
  const s = store();
  const e = live(s, k.key, Date.now());
  if (!e) {
    auditWrite(actor.id, "force_delete", k.key, "missing", via);
    return { key: k.key, deleted: false };
  }
  commit(s, k.key, null, () => auditWrite(actor.id, "force_delete", k.key, "deleted", via, { kind: e.kind, writer: e.writer }));
  return { key: k.key, deleted: true, kind: e.kind, writer: e.writer };
}

/**
 * Maintainers only: removes every key one person wrote or holds in the shared namespaces, and
 * every key in their own space. A shared throttle they created goes too; slots they booked on
 * someone else's throttle stay until they pass.
 */
export function kvPurge(actor: KvActor, input: { user: unknown }, via: AuditVia): { user: string; deleted: number } {
  assertMaintainer(actor.id, "purge");
  const user = typeof input.user === "string" ? input.user.trim().toLowerCase() : "";
  if (!user) throw new ValidationError("user is required: the id whose keys to remove");
  assertUsableId(user);
  const s = store();
  const removed: [string, Entry][] = [];
  for (const [key, e] of s.entries) {
    if (bucketOfKey(key) === user || (isShared(bucketOfKey(key)) && e.writer === user)) removed.push([key, e]);
  }
  for (const [key] of removed) removeRaw(s, key);
  try {
    auditWrite(actor.id, "purge", user, "deleted", via, { deleted: removed.length });
  } catch (err) {
    for (const [key, e] of removed) insertRaw(s, key, e);
    throw err;
  }
  return { user, deleted: removed.length };
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
    case "force_delete":
      return kvForceDelete(actor, { key: args.key }, via);
    case "purge":
      return kvPurge(actor, { user: args.user }, via);
  }
}
