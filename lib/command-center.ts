/**
 * Command Center: a private page where a person sees what their own agent sessions are doing
 * (docs/command-center.md). Agents push whole initiative records; the page only shows them.
 *
 * - Opt-in on both sides. The server stores nothing for a person whose switch is off
 *   (users.command_center_enabled_at), and only the person, signed in on the page, can flip it.
 * - One record per initiative, owned by the caller's resolved identity, never by a body field.
 *   A publish is an upsert by `id`: a replay after a restart changes nothing.
 * - Strict: unknown fields, bad values and text that is too long are refused with one sentence
 *   naming the field. Nothing is truncated or masked. Text that redact() would change is refused.
 * - The server owns every timestamp except health.checkedAt, so clock skew between machines
 *   never shows.
 * - In memory, one Map per person, written to DATA_DIR/command-center-snapshot.json every 30
 *   seconds when something changed and on SIGTERM (temp file, fsync, rename). Only the process
 *   that holds the key-value lease (lib/kv-lease.ts) loads, serves or saves it. A crash loses at
 *   most 30 seconds; agents republish.
 * - Writes are audited (person, initiative id, result), never bodies.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { getDb, resolveDataDir } from "./db";
import { config } from "./config";
import { audit } from "./audit";
import { sensitiveKind } from "./file-checks";
import { assertBoundIdentity, type BoundCaller } from "./bound-identity";
import { ensureKvLease, holdsKvLease, _resetKvLeaseForTests } from "./kv-lease";
import { checkCommandCenterRateLimit, CC_RATE_LIMIT_BURST, CC_RATE_LIMIT_PER_MINUTE } from "./rate-limit";
import { ApiError, ForbiddenError, NotFoundError, TooManyRequestsError, ValidationError } from "./errors";
import { ownerIdFor } from "./reminders-view";
import { getUser } from "./users";
import type { AuditVia } from "./types";

// ---------------------------------------------------------------------------
// Limits and vocabularies
// ---------------------------------------------------------------------------

export const CC_MAX_INITIATIVES = 100;
export const CC_MAX_BYTES_PER_PERSON = 256 * 1024;
export const CC_MAX_RECORD_BYTES = 32 * 1024;
/** Largest request body the Command Center routes accept. */
export const CC_MAX_BODY_BYTES = 256 * 1024;
export const CC_MAX_TASKS = 50;
export const CC_MAX_OPEN_QUESTIONS = 5;
export const CC_MAX_OPTIONS = 4;
export const CC_MAX_COMMENTS = 20;
export const CC_MAX_LINKS = 20;
/** Cleared questions kept per initiative (newest first), on top of the open ones. */
export const CC_MAX_CLEARED_QUESTIONS = 20;
export const CC_SNAPSHOT_INTERVAL_MS = 30_000;
export const CC_SWEEP_INTERVAL_MS = 60_000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A question older than this is flagged "possibly stale" on the page. */
export const CC_STALE_QUESTION_MS = 3 * DAY_MS;
/** Cleared questions stay visible this long, then go. */
export const CC_CLEARED_KEEP_MS = 7 * DAY_MS;
/** An active initiative with no write for this long is "silent"; after CC_ACTIVE_DROP_MS it is dropped. */
export const CC_SILENT_MS = 14 * DAY_MS;
export const CC_ACTIVE_DROP_MS = 60 * DAY_MS;
/** A done or parked initiative with no write for this long is dropped. */
export const CC_CLOSED_DROP_MS = 30 * DAY_MS;
/** After the switch is turned off, data stays this long (restorable), then it is deleted. */
export const CC_OFF_KEEP_MS = 30 * DAY_MS;
/** Two sessions publishing one initiative within this window are flagged on the card. */
export const CC_TWO_WRITERS_MS = HOUR_MS;
/** How late a recurring initiative's health may be, by cadence. No cadence counts as daily. */
export const CC_OVERDUE_MS: Record<Cadence, number> = { daily: 26 * HOUR_MS, weekly: 8 * DAY_MS, drain: 2 * HOUR_MS };

export const CC_ACTIONS = ["publish", "clear_question", "comment", "health", "list", "remove"] as const;
export type CcAction = (typeof CC_ACTIONS)[number];
export const CC_STATES = ["active", "done", "parked"] as const;
export const CC_KINDS = ["project", "recurring"] as const;
export const CC_CADENCES = ["daily", "weekly", "drain"] as const;
export const CC_PRIORITIES = ["urgent", "high", "low", "paused"] as const;
export const CC_TASK_STATUSES = ["pending", "in_progress", "done"] as const;
export const CC_HEALTH_LEVELS = ["green", "amber", "red", "unknown"] as const;

type State = (typeof CC_STATES)[number];
type Kind = (typeof CC_KINDS)[number];
type Cadence = (typeof CC_CADENCES)[number];
type Priority = (typeof CC_PRIORITIES)[number];
type TaskStatus = (typeof CC_TASK_STATUSES)[number];
type HealthLevel = (typeof CC_HEALTH_LEVELS)[number];

/** What every caller is told about content. */
export const CC_CONTENT_RULE = "Never put secrets, client names or customer data in any field.";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export interface CcTask {
  id: string;
  text: string;
  status: TaskStatus;
  /** Server time the task was first seen in_progress, and first seen done. */
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CcQuestion {
  id: string;
  text: string;
  options: string[];
  /** Server time of first sight of this id on this initiative. Kept while the id stays. */
  askedAt: string;
  clearedAt: string | null;
  /** source.session of the publish that first asked it, if any. */
  session: string | null;
}

export interface CcHealth {
  level: HealthLevel;
  reason: string;
  /** The agent's own time, shown as text only. */
  checkedAt: string;
  receivedAt: string;
}

export interface CcComment {
  id: string;
  text: string;
  at: string;
}

export interface CcLink {
  label: string;
  url: string;
}

export interface CcSource {
  machine: string | null;
  session: string | null;
}

export interface CcRecord {
  v: 1;
  id: string;
  title: string;
  area: string | null;
  key: string | null;
  state: State;
  kind: Kind;
  cadence: Cadence | null;
  deadline: string | null;
  priority: Priority | null;
  tasks: CcTask[];
  questions: CcQuestion[];
  health: CcHealth | null;
  comments: CcComment[];
  links: CcLink[];
  source: CcSource | null;
  updatedAt: string;
  seq: number;
  /** A device id, "token" or "web": who wrote it last, never a secret. */
  publishedBy: string;
  /** The last few sessions that published, with server times, for the "two writers" flag. */
  writers: { session: string; at: string }[];
}

/** The fields an agent sends on publish. */
interface RecordInput {
  id: string;
  title: string;
  area: string | null;
  key: string | null;
  state: State;
  kind: Kind;
  cadence: Cadence | null;
  deadline: string | null;
  priority: Priority | null;
  tasks: { id: string; text: string; status: TaskStatus }[];
  questions: { id: string; text: string; options: string[] }[];
  health: { level: HealthLevel; reason: string; checkedAt: string } | null;
  comments: { id: string; text: string }[];
  links: CcLink[];
  source: CcSource | null;
}

const RECORD_FIELDS = ["v", "id", "title", "area", "key", "state", "kind", "cadence", "deadline", "priority", "tasks", "questions", "health", "comments", "links", "source", "expectSeq"];
const TASK_FIELDS = ["id", "text", "status"];
const QUESTION_FIELDS = ["id", "text", "options"];
const HEALTH_FIELDS = ["level", "reason", "checkedAt"];
const COMMENT_FIELDS = ["id", "text"];
const LINK_FIELDS = ["label", "url"];
const SOURCE_FIELDS = ["machine", "session"];

// ---------------------------------------------------------------------------
// Validation. Every refusal names the field and the fix.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function onlyFields(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new ValidationError(`unknown field '${where}${k}'; allowed: ${allowed.join(", ")}`);
  }
}

function refuseSensitive(text: string, field: string): void {
  const kind = sensitiveKind(text);
  if (kind) throw new ValidationError(`${field} holds ${kind}, and Command Center never keeps confidential data. Remove it and publish again.`);
}

function text(raw: unknown, field: string, max: number, required = true): string | null {
  if (raw == null || raw === "") {
    if (required) throw new ValidationError(`${field} is required: plain text, 1 to ${max} characters`);
    return null;
  }
  if (typeof raw !== "string") throw new ValidationError(`${field} must be a string`);
  if (!raw.trim()) throw new ValidationError(`${field} must not be blank`);
  if (raw.length > max) throw new ValidationError(`${field} is ${raw.length} characters; at most ${max}. Shorten it.`);
  refuseSensitive(raw, field);
  return raw;
}

function slug(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !SLUG_RE.test(raw)) {
    throw new ValidationError(`${field} must be a slug: a-z, 0-9 and -, starting with a letter or digit, at most 40 characters`);
  }
  return raw;
}

function oneOf<T extends string>(raw: unknown, values: readonly T[], field: string): T {
  if (typeof raw !== "string" || !values.includes(raw as T)) {
    throw new ValidationError(`${field} must be ${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`);
  }
  return raw as T;
}

function list(raw: unknown, field: string, max: number, what: string): unknown[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ValidationError(`${field} must be an array`);
  if (raw.length > max) throw new ValidationError(`${field}: at most ${max} ${what}; you sent ${raw.length}`);
  return raw;
}

function uniqueIds(items: { id: string }[], field: string): void {
  const seen = new Set<string>();
  for (const [i, it] of items.entries()) {
    if (seen.has(it.id)) throw new ValidationError(`${field}[${i}].id '${it.id}' is used twice; ids must be unique`);
    seen.add(it.id);
  }
}

function validDate(raw: string): boolean {
  if (!DATE_RE.test(raw)) return false;
  const d = new Date(raw + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}

function httpsUrl(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.startsWith("https://")) throw new ValidationError(`${field} must start with https://`);
  if (raw.length > 500) throw new ValidationError(`${field} is ${raw.length} characters; at most 500`);
  try {
    new URL(raw);
  } catch {
    throw new ValidationError(`${field} is not a valid URL`);
  }
  refuseSensitive(raw, field);
  return raw;
}

function checkTask(raw: unknown, field: string): RecordInput["tasks"][number] {
  if (!isObject(raw)) throw new ValidationError(`${field} must be an object { id, text, status }`);
  onlyFields(raw, TASK_FIELDS, `${field}.`);
  return { id: slug(raw.id, `${field}.id`), text: text(raw.text, `${field}.text`, 120)!, status: oneOf(raw.status, CC_TASK_STATUSES, `${field}.status`) };
}

function checkQuestion(raw: unknown, field: string): RecordInput["questions"][number] {
  if (!isObject(raw)) throw new ValidationError(`${field} must be an object { id, text, options }`);
  onlyFields(raw, QUESTION_FIELDS, `${field}.`);
  const options = list(raw.options, `${field}.options`, CC_MAX_OPTIONS, "options").map((o, i) => text(o, `${field}.options[${i}]`, 60)!);
  return { id: slug(raw.id, `${field}.id`), text: text(raw.text, `${field}.text`, 500)!, options };
}

function checkHealthFields(raw: Record<string, unknown>, field: string): { level: HealthLevel; reason: string; checkedAt: string } {
  const level = oneOf(raw.level, CC_HEALTH_LEVELS, `${field}level`);
  const reason = text(raw.reason, `${field}reason`, 200, false) ?? "";
  const checkedAt = raw.checkedAt;
  if (typeof checkedAt !== "string" || !ISO_TIME_RE.test(checkedAt) || Number.isNaN(Date.parse(checkedAt))) {
    throw new ValidationError(`${field}checkedAt must be an ISO date and time, such as 2026-01-31T09:30:00Z`);
  }
  return { level, reason, checkedAt };
}

function checkComment(raw: unknown, field: string): { id: string; text: string } {
  if (!isObject(raw)) throw new ValidationError(`${field} must be an object { id, text }`);
  onlyFields(raw, COMMENT_FIELDS, `${field}.`);
  return { id: slug(raw.id, `${field}.id`), text: text(raw.text, `${field}.text`, 500)! };
}

function checkLink(raw: unknown, field: string): CcLink {
  if (!isObject(raw)) throw new ValidationError(`${field} must be an object { label, url }`);
  onlyFields(raw, LINK_FIELDS, `${field}.`);
  return { label: text(raw.label, `${field}.label`, 60)!, url: httpsUrl(raw.url, `${field}.url`) };
}

function checkSource(raw: unknown): CcSource | null {
  if (raw == null) return null;
  if (!isObject(raw)) throw new ValidationError("source must be an object { machine, session }");
  onlyFields(raw, SOURCE_FIELDS, "source.");
  return { machine: text(raw.machine, "source.machine", 20, false), session: text(raw.session, "source.session", 60, false) };
}

/** Checks a publish body (the whole record) and returns it normalized. `v` is required. */
export function validateRecord(raw: unknown): RecordInput {
  if (!isObject(raw)) throw new ValidationError("The record must be a JSON object with v: 1, id and title");
  onlyFields(raw, RECORD_FIELDS, "");
  if (raw.v === undefined) throw new ValidationError('v is required: add "v": 1 to the record');
  if (raw.v !== 1) throw new ValidationError("v must be 1; this server reads version 1 records only");
  const id = slug(raw.id, "id");
  const title = text(raw.title, "title", 120)!;
  const area = text(raw.area, "area", 40, false);
  let key: string | null = null;
  if (raw.key != null && raw.key !== "") {
    if (typeof raw.key !== "string" || !KEY_RE.test(raw.key)) throw new ValidationError("key must be a ticket key such as KEY-1, or null");
    key = raw.key;
  }
  const state = raw.state == null ? "active" : oneOf(raw.state, CC_STATES, "state");
  const kind = raw.kind == null ? "project" : oneOf(raw.kind, CC_KINDS, "kind");
  let cadence: Cadence | null = null;
  if (raw.cadence != null) {
    if (kind !== "recurring") throw new ValidationError('cadence is for kind "recurring" only; remove it or set kind');
    cadence = oneOf(raw.cadence, CC_CADENCES, "cadence");
  }
  let deadline: string | null = null;
  if (raw.deadline != null) {
    if (typeof raw.deadline !== "string" || !validDate(raw.deadline)) throw new ValidationError("deadline must be a date YYYY-MM-DD, or null");
    deadline = raw.deadline;
  }
  const priority = raw.priority == null ? null : oneOf(raw.priority, CC_PRIORITIES, "priority");
  const tasks = list(raw.tasks, "tasks", CC_MAX_TASKS, "tasks").map((t, i) => checkTask(t, `tasks[${i}]`));
  if (kind === "recurring" && tasks.length) throw new ValidationError('tasks: a kind "recurring" initiative has no tasks; send health instead');
  uniqueIds(tasks, "tasks");
  if (Array.isArray(raw.questions) && raw.questions.length > CC_MAX_OPEN_QUESTIONS) {
    throw new ValidationError(`questions: at most ${CC_MAX_OPEN_QUESTIONS} open; clear one first`);
  }
  const questions = list(raw.questions, "questions", CC_MAX_OPEN_QUESTIONS, "open questions").map((q, i) => checkQuestion(q, `questions[${i}]`));
  uniqueIds(questions, "questions");
  let health: RecordInput["health"] = null;
  if (raw.health != null) {
    if (kind !== "recurring") throw new ValidationError('health is for kind "recurring" only; remove it or set kind');
    if (!isObject(raw.health)) throw new ValidationError("health must be an object { level, reason, checkedAt }");
    onlyFields(raw.health, HEALTH_FIELDS, "health.");
    health = checkHealthFields(raw.health, "health.");
  }
  const comments = list(raw.comments, "comments", CC_MAX_COMMENTS, "comments").map((c, i) => checkComment(c, `comments[${i}]`));
  uniqueIds(comments, "comments");
  const links = list(raw.links, "links", CC_MAX_LINKS, "links").map((l, i) => checkLink(l, `links[${i}]`));
  const source = checkSource(raw.source);
  return { id, title, area, key, state, kind, cadence, deadline, priority, tasks, questions, health, comments, links, source };
}

function parseExpectSeq(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) throw new ValidationError("expectSeq must be a whole number, the seq of the record you last read (0 for a new one)");
  return raw;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** 409: expectSeq does not match. Carries the current record so the agent can merge. */
export class CcConflictError extends ApiError {
  current: CcRecord | null;
  constructor(message: string, current: CcRecord | null) {
    super(message, 409);
    this.name = "CcConflictError";
    this.current = current;
  }
}

/** 413: a record or a person's total is too big. */
export class CcTooLargeError extends ApiError {
  constructor(message: string) {
    super(message, 413);
    this.name = "CcTooLargeError";
  }
}

/** Maps a thrown error to a REST answer, keeping the current record of a 409. */
export function ccApiError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof CcConflictError) return { status: 409, body: { error: err.message, current: err.current } };
  if (err instanceof ApiError) return { status: err.status, body: { error: err.message } };
  if (err instanceof Error) return { status: 400, body: { error: err.message } };
  return { status: 400, body: { error: "Something went wrong" } };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

interface Store {
  owners: Map<string, Map<string, CcRecord>>;
  dirty: boolean;
  /** Set once this process saw the lease gone: it never serves or saves this map again. */
  lost?: boolean;
  timers: ReturnType<typeof setInterval>[];
}

const GLOBAL_KEY = "__babCommandCenterStore";
type Holder = { [GLOBAL_KEY]?: Store };

function existingStore(): Store | undefined {
  return (globalThis as Holder)[GLOBAL_KEY];
}

function leaseRefusal(why: "other" | "lost" | "unwritable"): ApiError {
  const messages = {
    other: "Command Center is off in this BAB process: another BAB process serves it on the same data (DATA_DIR/kv.lease). BAB must run as one replica. Tell a BAB maintainer.",
    lost: "Command Center is off in this BAB process: another BAB process took it over on the same data (DATA_DIR/kv.lease), and it stays off here until this BAB restarts. Tell a BAB maintainer.",
    unwritable: "Command Center is off in this BAB process: it cannot write its lease file, DATA_DIR/kv.lease. Check that DATA_DIR is writable. Tell a BAB maintainer.",
  };
  return new ApiError(messages[why], 503);
}

function store(): Store {
  const g = globalThis as Holder;
  let s = g[GLOBAL_KEY];
  if (!s) {
    // The key-value store's lease: one process serves both, a second one answers 503 for both.
    const lease = ensureKvLease();
    if (lease !== "held") throw leaseRefusal(lease);
    s = { owners: new Map(), dirty: false, timers: [] };
    g[GLOBAL_KEY] = s;
    loadSnapshotInto(s, Date.now());
    const save = setInterval(() => saveCommandCenterSnapshot(), CC_SNAPSHOT_INTERVAL_MS);
    const sweep = setInterval(() => sweepCommandCenter(), CC_SWEEP_INTERVAL_MS);
    save.unref?.();
    sweep.unref?.();
    s.timers.push(save, sweep);
  } else if (s.lost || !holdsKvLease()) {
    // Lost the lease once: never serve this map again, even if this process takes the lease back
    // later, because the other process may have written a newer snapshot meanwhile.
    s.lost = true;
    throw leaseRefusal("lost");
  }
  return s;
}

/** Test-only: forget the store (without saving), its timers and the lease state. */
export function _resetCommandCenterForTests(): void {
  const s = existingStore();
  if (s) for (const t of s.timers) clearInterval(t);
  delete (globalThis as Holder)[GLOBAL_KEY];
  _resetKvLeaseForTests();
}

export function ccSnapshotPath(): string {
  return path.join(resolveDataDir(), "command-center-snapshot.json");
}

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (isoText: string | null | undefined): number => (isoText ? Date.parse(isoText) : NaN);
const bytesOf = (r: CcRecord): number => Buffer.byteLength(JSON.stringify(r), "utf8");

// ---------------------------------------------------------------------------
// The opt-in switch (SQLite: a decision, not state)
// ---------------------------------------------------------------------------

export interface CcSwitch {
  enabledAt: string | null;
  disabledAt: string | null;
}

export function ccSwitch(ownerId: string): CcSwitch {
  const row = getDb().prepare("SELECT command_center_enabled_at AS e, command_center_disabled_at AS d FROM users WHERE id = ?").get(ownerId) as
    | { e: string | null; d: string | null }
    | undefined;
  return { enabledAt: row?.e ?? null, disabledAt: row?.d ?? null };
}

/** The exact refusal for a person whose switch is off. Nothing is stored before it. */
export function ccOffMessage(ownerId: string, origin: string): string {
  const name = getUser(ownerId)?.name || ownerId;
  return `Command Center is off for ${name}. Ask them to open ${origin}/command-center and switch it on, then publish again. Nothing was stored.`;
}

/** Whether a person's records are still kept: on, or off for less than CC_OFF_KEEP_MS. */
function kept(sw: CcSwitch, now: number): boolean {
  if (sw.enabledAt) return true;
  const off = ms(sw.disabledAt);
  return Number.isFinite(off) && now - off < CC_OFF_KEEP_MS;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Drops what retention says is gone, for one person. True when anything changed. */
function prune(records: Map<string, CcRecord>, now: number): boolean {
  let changed = false;
  for (const [id, r] of records) {
    const age = now - ms(r.updatedAt);
    if ((r.state === "active" && age >= CC_ACTIVE_DROP_MS) || (r.state !== "active" && age >= CC_CLOSED_DROP_MS)) {
      records.delete(id);
      changed = true;
      continue;
    }
    const before = r.questions.length;
    r.questions = r.questions.filter((q) => !q.clearedAt || now - ms(q.clearedAt) < CC_CLEARED_KEEP_MS);
    if (r.questions.length !== before) changed = true;
  }
  return changed;
}

/**
 * Runs retention for everyone: old records and cleared questions, and the records of people who
 * switched off more than 30 days ago (or never switched on). Called every minute.
 */
export function sweepCommandCenter(now: number = Date.now()): number {
  const s = existingStore();
  if (!s) return 0;
  let dropped = 0;
  for (const [owner, records] of s.owners) {
    if (!kept(ccSwitch(owner), now)) {
      dropped += records.size;
      s.owners.delete(owner);
      s.dirty = true;
      continue;
    }
    const size = records.size;
    if (prune(records, now)) s.dirty = true;
    dropped += size - records.size;
    if (!records.size) s.owners.delete(owner);
  }
  return dropped;
}

function recordsOf(s: Store, owner: string, now: number): Map<string, CcRecord> {
  const records = s.owners.get(owner);
  if (!records) return new Map();
  if (prune(records, now)) s.dirty = true;
  return records;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface SnapshotFile {
  version: 1;
  savedAt: string;
  owners: Record<string, CcRecord[]>;
}

/**
 * Writes every person's records to DATA_DIR/command-center-snapshot.json when anything changed
 * (or always, with `force`): temp file, fsync, rename, so a crash never leaves half a file. Only
 * the lease holder writes. Never throws.
 */
export function saveCommandCenterSnapshot(force = false): boolean {
  const s = existingStore();
  if (!s || s.lost) return false;
  if (!holdsKvLease()) {
    s.lost = true;
    return false;
  }
  if (!s.dirty && !force) return false;
  const now = Date.now();
  const owners: Record<string, CcRecord[]> = {};
  for (const [owner, records] of s.owners) if (records.size) owners[owner] = [...records.values()];
  const file = ccSnapshotPath();
  const tmp = file + ".tmp";
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    rmSync(tmp, { force: true });
    const body: SnapshotFile = { version: 1, savedAt: iso(now), owners };
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
    console.warn("bab: could not write the Command Center snapshot: " + (err instanceof Error ? err.message : String(err)));
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    return false;
  }
}

/** On shutdown, before the key-value store gives the lease up (instrumentation-node.ts). */
export function flushCommandCenterSnapshot(): void {
  if (existingStore()) saveCommandCenterSnapshot();
}

function isoOrNull(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) return undefined;
  return raw;
}

/**
 * Checks one stored record as strictly as a new publish, plus the server fields. Returns the
 * record to load, or null to drop it.
 */
function checkedRecord(raw: unknown, now: number): CcRecord | null {
  if (!isObject(raw)) return null;
  try {
    const openQs = Array.isArray(raw.questions) ? raw.questions.filter((q) => isObject(q) && q.clearedAt == null) : [];
    const clearedQs = Array.isArray(raw.questions) ? raw.questions.filter((q) => isObject(q) && q.clearedAt != null) : [];
    const strip = (o: unknown, keep: string[]) => (isObject(o) ? Object.fromEntries(Object.entries(o).filter(([k]) => keep.includes(k))) : o);
    const input = validateRecord({
      v: raw.v,
      id: raw.id,
      title: raw.title,
      area: raw.area,
      key: raw.key,
      state: raw.state,
      kind: raw.kind,
      cadence: raw.cadence,
      deadline: raw.deadline,
      priority: raw.priority,
      tasks: Array.isArray(raw.tasks) ? raw.tasks.map((t) => strip(t, TASK_FIELDS)) : raw.tasks,
      questions: openQs.map((q) => strip(q, QUESTION_FIELDS)),
      health: raw.health == null ? null : strip(raw.health, HEALTH_FIELDS),
      comments: Array.isArray(raw.comments) ? raw.comments.map((c) => strip(c, COMMENT_FIELDS)) : raw.comments,
      links: raw.links,
      source: raw.source,
    });
    const updatedAt = isoOrNull(raw.updatedAt);
    if (!updatedAt || Date.parse(updatedAt) > now + HOUR_MS) return null;
    if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 1) return null;
    if (typeof raw.publishedBy !== "string" || raw.publishedBy.length > 100) return null;
    const qsIn = [...openQs, ...clearedQs] as Record<string, unknown>[];
    const questions: CcQuestion[] = [];
    for (const [i, q] of qsIn.entries()) {
      const base = checkQuestion(strip(q, QUESTION_FIELDS), `questions[${i}]`);
      const askedAt = isoOrNull(q.askedAt);
      const clearedAt = q.clearedAt == null ? null : isoOrNull(q.clearedAt);
      if (!askedAt || clearedAt === undefined) return null;
      const session = typeof q.session === "string" && q.session.length <= 60 ? q.session : null;
      questions.push({ ...base, askedAt, clearedAt, session });
    }
    if (new Set(questions.map((q) => q.id)).size !== questions.length) return null;
    const rawTasks = (Array.isArray(raw.tasks) ? raw.tasks : []) as Record<string, unknown>[];
    const tasks: CcTask[] = input.tasks.map((t, i) => ({ ...t, startedAt: isoOrNull(rawTasks[i]?.startedAt) ?? null, finishedAt: isoOrNull(rawTasks[i]?.finishedAt) ?? null }));
    const rawComments = (Array.isArray(raw.comments) ? raw.comments : []) as Record<string, unknown>[];
    const comments: CcComment[] = input.comments.map((c, i) => ({ ...c, at: isoOrNull(rawComments[i]?.at) ?? updatedAt }));
    let health: CcHealth | null = null;
    if (input.health) {
      const receivedAt = isoOrNull((raw.health as Record<string, unknown>).receivedAt);
      if (!receivedAt) return null;
      health = { ...input.health, receivedAt };
    }
    const writers = (Array.isArray(raw.writers) ? raw.writers : [])
      .filter((w): w is { session: string; at: string } => isObject(w) && typeof w.session === "string" && w.session.length <= 60 && !!isoOrNull(w.at))
      .slice(-5)
      .map((w) => ({ session: w.session, at: w.at }));
    const record: CcRecord = {
      v: 1,
      ...input,
      tasks,
      questions,
      health,
      comments,
      updatedAt,
      seq: raw.seq,
      publishedBy: raw.publishedBy,
      writers,
    };
    if (bytesOf(record) > CC_MAX_RECORD_BYTES) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Reads the snapshot into an empty store. Every record is checked again; broken ones are dropped
 * and counted. A broken file is an empty store. People whose switch is off past the keep window
 * are dropped by the first sweep.
 */
function loadSnapshotInto(s: Store, now: number): void {
  let raw: string;
  try {
    raw = readFileSync(ccSnapshotPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn("bab: could not read the Command Center snapshot; starting empty: " + (err as Error).message);
    return;
  }
  let parsed: SnapshotFile;
  try {
    parsed = JSON.parse(raw) as SnapshotFile;
  } catch {
    console.warn("bab: the Command Center snapshot is not valid JSON; starting empty.");
    return;
  }
  if (!isObject(parsed) || !isObject(parsed.owners)) {
    console.warn("bab: the Command Center snapshot has no owners; starting empty.");
    return;
  }
  let dropped = 0;
  for (const [owner, records] of Object.entries(parsed.owners)) {
    if (!owner || owner.includes("/") || owner.length > 320 || !Array.isArray(records)) {
      dropped += Array.isArray(records) ? records.length : 1;
      continue;
    }
    if (!kept(ccSwitch(owner), now)) {
      // Switched off past the keep window, or never on: these records are due for deletion.
      dropped += records.length;
      continue;
    }
    const map = new Map<string, CcRecord>();
    let bytes = 0;
    for (const item of records) {
      const r = checkedRecord(item, now);
      if (!r || map.has(r.id) || map.size >= CC_MAX_INITIATIVES || bytes + bytesOf(r) > CC_MAX_BYTES_PER_PERSON) {
        dropped += 1;
        continue;
      }
      bytes += bytesOf(r);
      map.set(r.id, r);
    }
    if (map.size) s.owners.set(owner, map);
  }
  // Anything dropped is written back at the next save, so the file forgets it too.
  s.dirty = dropped > 0;
  if (dropped) console.warn(`bab: dropped ${dropped} Command Center snapshot entries (malformed, duplicated or over a limit).`);
}

// ---------------------------------------------------------------------------
// Derived flags, for the list answer and the page
// ---------------------------------------------------------------------------

export interface CcQuestionView extends CcQuestion {
  stale: boolean;
}

export interface CcFlags {
  silent: boolean;
  overdue: boolean;
  twoWriters: boolean;
  openQuestions: number;
  progress: number | null;
}

export interface CcDataHealth {
  staleQuestions: number;
  silentInitiatives: number;
  recurringWithoutHealth: number;
  overdueRecurring: number;
}

/** A question is possibly stale when old, when its initiative is closed, or when another session kept it. */
export function questionStale(r: CcRecord, q: CcQuestion, now: number): boolean {
  if (q.clearedAt) return false;
  if (now - ms(q.askedAt) > CC_STALE_QUESTION_MS) return true;
  if (r.state !== "active") return true;
  return !!(q.session && r.source?.session && r.source.session !== q.session);
}

export function flagsOf(r: CcRecord, now: number): CcFlags {
  const paused = r.priority === "paused";
  const silent = !paused && r.state === "active" && now - ms(r.updatedAt) >= CC_SILENT_MS;
  let overdue = false;
  if (!paused && r.kind === "recurring" && r.state === "active" && r.health && r.health.level !== "unknown") {
    overdue = now - ms(r.health.receivedAt) > CC_OVERDUE_MS[r.cadence ?? "daily"];
  }
  const recent = new Set(r.writers.filter((w) => now - ms(w.at) <= CC_TWO_WRITERS_MS).map((w) => w.session));
  const open = paused ? 0 : r.questions.filter((q) => !q.clearedAt).length;
  const progress = r.kind === "recurring" ? null : r.state === "done" ? 100 : r.tasks.length ? Math.round((100 * r.tasks.filter((t) => t.status === "done").length) / r.tasks.length) : null;
  return { silent, overdue, twoWriters: recent.size >= 2, openQuestions: open, progress };
}

export function dataHealthOf(records: Iterable<CcRecord>, now: number): CcDataHealth {
  const h: CcDataHealth = { staleQuestions: 0, silentInitiatives: 0, recurringWithoutHealth: 0, overdueRecurring: 0 };
  for (const r of records) {
    if (r.priority === "paused") continue;
    const f = flagsOf(r, now);
    h.staleQuestions += r.questions.filter((q) => questionStale(r, q, now)).length;
    if (f.silent) h.silentInitiatives += 1;
    if (r.kind === "recurring" && r.state === "active" && !r.health) h.recurringWithoutHealth += 1;
    if (f.overdue) h.overdueRecurring += 1;
  }
  return h;
}

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, none: 2, low: 3, paused: 4 };
const STATE_ORDER: Record<State, number> = { active: 0, parked: 1, done: 2 };

/** Page order: active before parked before done; within, urgent, high, none, low, paused; then newest first. */
export function sortRecords(records: CcRecord[]): CcRecord[] {
  return [...records].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      PRIORITY_ORDER[a.priority ?? "none"] - PRIORITY_ORDER[b.priority ?? "none"] ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export interface CcActor extends BoundCaller {
  id: string;
  email?: string | null;
  deviceId?: string;
}

function ownerOf(actor: CcActor): string {
  return ownerIdFor({ id: actor.id, email: actor.email ?? null, source: actor.source }) ?? actor.id;
}

/** 404 when switched off on this BAB; 503 with more than one replica. */
export function assertCommandCenterEnabled(): void {
  const c = config();
  if (!c.commandCenter) throw new NotFoundError("Command Center is switched off on this BAB");
  if (c.replicas > 1) {
    throw new ApiError(`Command Center is off: BAB_REPLICAS is ${c.replicas}, and it keeps its state in one BAB process. Tell a BAB maintainer.`, 503);
  }
}

export function assertCommandCenterIdentity(caller: BoundCaller): void {
  assertBoundIdentity(caller, false, "Command Center");
}

function assertRate(owner: string): void {
  if (!checkCommandCenterRateLimit(owner)) {
    throw new TooManyRequestsError(`Too many Command Center calls: at most ${CC_RATE_LIMIT_PER_MINUTE} a minute, ${CC_RATE_LIMIT_BURST} at once. Wait a few seconds, then publish the whole record once.`);
  }
}

function assertOptedIn(owner: string, origin: string): void {
  if (!ccSwitch(owner).enabledAt) throw new ForbiddenError(ccOffMessage(owner, origin));
}

function auditCc(actor: string, op: string, id: string, result: string, via: AuditVia): void {
  audit(getDb(), actor, `cc_${op}`, "command_center", id, via, { details: { result } });
}

function publisherOf(actor: CcActor): string {
  if (actor.source === "device" && actor.deviceId) return `device:${actor.deviceId}`;
  if (actor.tokenBound) return "token";
  return actor.source === "proxy" ? "web" : actor.source;
}

// ---------------------------------------------------------------------------
// Operations. Each is synchronous from its first read to its last write.
// ---------------------------------------------------------------------------

function usage(records: Map<string, CcRecord>): { initiatives: number; bytes: number; maxInitiatives: number; maxBytes: number } {
  let bytes = 0;
  for (const r of records.values()) bytes += bytesOf(r);
  return { initiatives: records.size, bytes, maxInitiatives: CC_MAX_INITIATIVES, maxBytes: CC_MAX_BYTES_PER_PERSON };
}

/** Puts a record in after the size checks; the audit row is written first, so a failed audit stores nothing. */
function commit(s: Store, owner: string, next: CcRecord, audited: () => void): void {
  const records = s.owners.get(owner) ?? new Map<string, CcRecord>();
  const size = bytesOf(next);
  if (size > CC_MAX_RECORD_BYTES) {
    const cleared = next.questions.filter((q) => q.clearedAt).length;
    throw new CcTooLargeError(
      `The record is ${Math.ceil(size / 1024)} KB; at most ${CC_MAX_RECORD_BYTES / 1024} KB per initiative. Send fewer or shorter tasks, comments or links` +
        (cleared ? ` (it also keeps ${cleared} cleared questions for 7 days).` : "."),
    );
  }
  const prev = records.get(next.id);
  if (!prev && records.size >= CC_MAX_INITIATIVES) {
    throw new ValidationError(`You have ${CC_MAX_INITIATIVES} initiatives, the most Command Center keeps. Remove one first.`);
  }
  const total = usage(records).bytes - (prev ? bytesOf(prev) : 0) + size;
  if (total > CC_MAX_BYTES_PER_PERSON) {
    throw new CcTooLargeError(`Your initiatives would take ${Math.ceil(total / 1024)} KB; at most ${CC_MAX_BYTES_PER_PERSON / 1024} KB per person. Remove or shorten one first.`);
  }
  audited();
  records.set(next.id, next);
  s.owners.set(owner, records);
  s.dirty = true;
}

export interface PublishResult {
  id: string;
  seq: number;
  questions: { id: string; askedAt: string; clearedAt: string | null }[];
  /** Open questions you sent that the person already dismissed on the page: they stay cleared. */
  dismissed?: string[];
  /** True when the record was already exactly this: nothing was written. */
  unchanged?: true;
}

/** The record without the fields the server changes on every write, to spot a replay. */
function contentOf(r: CcRecord): string {
  return JSON.stringify({ ...r, updatedAt: null, seq: null, publishedBy: null, writers: null });
}

export function ccPublish(actor: CcActor, owner: string, body: Record<string, unknown>, via: AuditVia, now: number = Date.now()): PublishResult {
  const expectSeq = parseExpectSeq(body.expectSeq);
  const input = validateRecord(body);
  const s = store();
  const prev = recordsOf(s, owner, now).get(input.id);
  const conflict = expectSeq !== null && expectSeq !== (prev?.seq ?? 0);
  const at = iso(now);
  const session = input.source?.session ?? null;
  // Questions: keep askedAt while the id stays; an open id missing from this publish is cleared now.
  // One the person dismissed stays cleared while its text is the same; reworded, it is asked anew.
  const questions: CcQuestion[] = [];
  const dismissed: string[] = [];
  const sent = new Set(input.questions.map((q) => q.id));
  for (const q of input.questions) {
    const old = prev?.questions.find((p) => p.id === q.id);
    if (old?.clearedAt && old.text === q.text) {
      questions.push(old);
      dismissed.push(q.id);
      continue;
    }
    const open = old && !old.clearedAt ? old : undefined;
    questions.push({ ...q, askedAt: open?.askedAt ?? at, clearedAt: null, session: open ? open.session : session });
  }
  const cleared: CcQuestion[] = [];
  for (const p of prev?.questions ?? []) {
    if (sent.has(p.id)) continue;
    cleared.push(p.clearedAt ? p : { ...p, clearedAt: at });
  }
  // Keep the newest cleared ones only, so they cannot fill the record.
  cleared.sort((x, y) => (y.clearedAt ?? "").localeCompare(x.clearedAt ?? ""));
  questions.push(...cleared.slice(0, CC_MAX_CLEARED_QUESTIONS));
  const tasks: CcTask[] = input.tasks.map((t) => {
    const old = prev?.tasks.find((p) => p.id === t.id);
    const startedAt = old?.startedAt ?? (t.status !== "pending" ? at : null);
    const finishedAt = t.status === "done" ? (old?.finishedAt ?? at) : null;
    return { ...t, startedAt, finishedAt };
  });
  // Comments and health have their own actions too: a publish that leaves the field out keeps
  // them; only an explicit [] or null clears them.
  const comments: CcComment[] =
    body.comments === undefined && prev
      ? prev.comments
      : input.comments.map((c) => ({ ...c, at: prev?.comments.find((p) => p.id === c.id && p.text === c.text)?.at ?? at }));
  let health: CcHealth | null = null;
  if (input.health) {
    const same = prev?.health && prev.health.level === input.health.level && prev.health.reason === input.health.reason && prev.health.checkedAt === input.health.checkedAt;
    health = { ...input.health, receivedAt: same ? prev!.health!.receivedAt : at };
  } else if (body.health === undefined && prev && input.kind === "recurring") {
    health = prev.health;
  }
  const writers = [...(prev?.writers ?? [])];
  if (session) writers.push({ session, at });
  const next: CcRecord = {
    v: 1,
    ...input,
    tasks,
    questions,
    health,
    comments,
    updatedAt: at,
    seq: (prev?.seq ?? 0) + 1,
    publishedBy: publisherOf(actor),
    writers: writers.slice(-5),
  };
  const answer = (r: CcRecord): PublishResult => ({
    id: r.id,
    seq: r.seq,
    questions: r.questions.map((q) => ({ id: q.id, askedAt: q.askedAt, clearedAt: q.clearedAt })),
    ...(dismissed.length ? { dismissed } : {}),
  });
  // A replay of the same record changes nothing: no new seq or time, no audit row. That holds for
  // a retried PUT whose expectSeq the first try already moved past, so a replay is never a 409.
  if (prev && contentOf(prev) === contentOf(next)) return { ...answer(prev), unchanged: true };
  if (conflict) {
    throw new CcConflictError(
      `expectSeq is ${expectSeq} but '${input.id}' is at seq ${prev?.seq ?? 0}. Merge your change into the current record (in current) and publish again with expectSeq ${prev?.seq ?? 0}.`,
      prev ?? null,
    );
  }
  commit(s, owner, next, () => auditCc(owner, "publish", input.id, prev ? "updated" : "created", via));
  return answer(next);
}

function existing(s: Store, owner: string, id: unknown, now: number): CcRecord {
  const key = slug(id, "id");
  const r = recordsOf(s, owner, now).get(key);
  if (!r) throw new NotFoundError(`No initiative '${key}' in your Command Center. Publish the whole record first.`);
  return r;
}

export function ccClearQuestion(owner: string, input: { id: unknown; questionId: unknown }, via: AuditVia, now: number = Date.now()): { cleared: boolean; reason?: string } {
  const id = slug(input.id, "id");
  const questionId = slug(input.questionId, "questionId");
  const s = store();
  const r = recordsOf(s, owner, now).get(id);
  const q = r?.questions.find((x) => x.id === questionId && !x.clearedAt);
  if (!r || !q) return { cleared: false, reason: "unknown" };
  // From the page ("ui") neither seq nor updatedAt moves: a dismissal is not the agent's work, so it
  // must not hide silence or break the agent's next expectSeq.
  const questions = r.questions.map((x) => (x === q ? { ...x, clearedAt: iso(now) } : x));
  const next: CcRecord = via === "ui" ? { ...r, questions } : { ...r, questions, seq: r.seq + 1, updatedAt: iso(now) };
  commit(s, owner, next, () => auditCc(owner, "clear", id, "cleared", via));
  return { cleared: true };
}

export function ccComment(actor: CcActor, owner: string, input: { id: unknown; text: unknown; commentId?: unknown }, via: AuditVia, now: number = Date.now()): { seq: number; dropped?: string } {
  const s = store();
  const r = existing(s, owner, input.id, now);
  const body = text(input.text, "text", 500)!;
  const commentId = input.commentId == null ? `n${r.seq + 1}` : slug(input.commentId, "commentId");
  if (r.comments.some((c) => c.id === commentId)) throw new ValidationError(`commentId '${commentId}' is already on this initiative; use another`);
  // Comments keep the last CC_MAX_COMMENTS: appending to a full list drops the oldest one, by design.
  const all = [...r.comments, { id: commentId, text: body, at: iso(now) }];
  const comments = all.slice(-CC_MAX_COMMENTS);
  const next: CcRecord = { ...r, comments, seq: r.seq + 1, updatedAt: iso(now), publishedBy: publisherOf(actor) };
  commit(s, owner, next, () => auditCc(owner, "comment", r.id, "added", via));
  // The answer names the comment that made room, so nothing goes unsaid.
  return all.length > CC_MAX_COMMENTS ? { seq: next.seq, dropped: all[0].id } : { seq: next.seq };
}

export function ccHealth(actor: CcActor, owner: string, input: Record<string, unknown>, via: AuditVia, now: number = Date.now()): { seq: number } {
  const s = store();
  const r = existing(s, owner, input.id, now);
  if (r.kind !== "recurring") throw new ValidationError(`health is for kind "recurring" only, and '${r.id}' is a project. Publish it with kind "recurring" first.`);
  const h = checkHealthFields(input, "");
  const next: CcRecord = { ...r, health: { ...h, receivedAt: iso(now) }, seq: r.seq + 1, updatedAt: iso(now), publishedBy: publisherOf(actor) };
  commit(s, owner, next, () => auditCc(owner, "health", r.id, h.level, via));
  return { seq: next.seq };
}

export function ccRemove(owner: string, input: { id: unknown }, via: AuditVia, now: number = Date.now()): { removed: boolean } {
  const id = slug(input.id, "id");
  const s = store();
  const records = recordsOf(s, owner, now);
  if (!records.has(id)) return { removed: false };
  auditCc(owner, "remove", id, "removed", via);
  records.delete(id);
  s.dirty = true;
  // Written at once, so a crash within the save interval cannot bring it back.
  saveCommandCenterSnapshot();
  return { removed: true };
}

export function ccGet(owner: string, id: unknown, now: number = Date.now()): CcRecord & CcFlags {
  const r = existing(store(), owner, id, now);
  return { ...r, ...flagsOf(r, now) };
}

export interface CcListItem {
  id: string;
  title: string;
  area: string | null;
  state: State;
  kind: Kind;
  priority: Priority | null;
  seq: number;
  updatedAt: string;
  openQuestions: number;
  staleQuestions: number;
  silent: boolean;
  overdue: boolean;
}

export function ccList(owner: string, now: number = Date.now()): { initiatives: CcListItem[]; dataHealth: CcDataHealth; usage: ReturnType<typeof usage>; lastPush: string | null } {
  const records = recordsOf(store(), owner, now);
  const all = sortRecords([...records.values()]);
  const initiatives = all.map((r) => {
    const f = flagsOf(r, now);
    return {
      id: r.id,
      title: r.title,
      area: r.area,
      state: r.state,
      kind: r.kind,
      priority: r.priority,
      seq: r.seq,
      updatedAt: r.updatedAt,
      openQuestions: f.openQuestions,
      staleQuestions: r.priority === "paused" ? 0 : r.questions.filter((q) => questionStale(r, q, now)).length,
      silent: f.silent,
      overdue: f.overdue,
    };
  });
  const lastPush = all.reduce<string | null>((m, r) => (m === null || r.updatedAt > m ? r.updatedAt : m), null);
  return { initiatives, dataHealth: dataHealthOf(all, now), usage: usage(records), lastPush };
}

/**
 * The one entry point for the REST routes and the MCP tool: switch, identity, pace, opt-in, then
 * the action. The owner is always the caller's resolved identity.
 */
export function runCommandCenter(actor: CcActor, args: Record<string, unknown>, via: AuditVia, origin: string): unknown {
  const action = typeof args.action === "string" ? args.action : "";
  if (!CC_ACTIONS.includes(action as CcAction)) {
    throw new ValidationError(`action must be one of ${CC_ACTIONS.join(", ")}; required, has no default`);
  }
  assertCommandCenterEnabled();
  assertCommandCenterIdentity(actor);
  const owner = ownerOf(actor);
  assertRate(owner);
  assertOptedIn(owner, origin);
  const pick = (allowed: string[]) => {
    for (const k of Object.keys(args)) {
      if (k !== "action" && !allowed.includes(k)) throw new ValidationError(`unknown field '${k}' for ${action}; allowed: ${allowed.join(", ")}`);
    }
  };
  switch (action as CcAction) {
    case "publish": {
      const { action: _drop, ...record } = args;
      void _drop;
      return ccPublish(actor, owner, record, via);
    }
    case "clear_question":
      pick(["id", "questionId"]);
      return ccClearQuestion(owner, { id: args.id, questionId: args.questionId }, via);
    case "comment":
      pick(["id", "text", "commentId"]);
      return ccComment(actor, owner, { id: args.id, text: args.text, commentId: args.commentId }, via);
    case "health":
      pick(["id", "level", "reason", "checkedAt"]);
      return ccHealth(actor, owner, args, via);
    case "list":
      pick([]);
      return ccList(owner);
    case "remove":
      pick(["id"]);
      return ccRemove(owner, { id: args.id }, via);
  }
}

/** GET of one record, for the REST route: the same gates as runCommandCenter. */
export function runCommandCenterGet(actor: CcActor, id: unknown, origin: string): CcRecord & CcFlags {
  assertCommandCenterEnabled();
  assertCommandCenterIdentity(actor);
  const owner = ownerOf(actor);
  assertRate(owner);
  assertOptedIn(owner, origin);
  return ccGet(owner, id);
}

// ---------------------------------------------------------------------------
// The page's own operations: the SSO viewer only (getViewer), never an agent.
// ---------------------------------------------------------------------------

export interface CcView {
  enabledAt: string | null;
  disabledAt: string | null;
  /** When off with data left: the day it is deleted. */
  keptUntil: string | null;
  records: (CcRecord & CcFlags & { questionViews: CcQuestionView[] })[];
  needsYou: { initiative: CcRecord; question: CcQuestionView }[];
  dataHealth: CcDataHealth;
  lastPush: string | null;
  /** Changes whenever anything the page shows changes; the page polls it. */
  stamp: string;
}

export function ccView(ownerId: string, now: number = Date.now()): CcView {
  const sw = ccSwitch(ownerId);
  const s = store();
  const all = kept(sw, now) ? sortRecords([...recordsOf(s, ownerId, now).values()]) : [];
  const records = all.map((r) => ({
    ...r,
    ...flagsOf(r, now),
    questionViews: r.questions.map((q) => ({ ...q, stale: questionStale(r, q, now) })),
  }));
  const needsYou = records
    .filter((r) => r.priority !== "paused")
    .flatMap((r) => r.questionViews.filter((q) => !q.clearedAt).map((question) => ({ initiative: r as CcRecord, question })))
    .sort((a, b) => a.question.askedAt.localeCompare(b.question.askedAt));
  const lastPush = all.reduce<string | null>((m, r) => (m === null || r.updatedAt > m ? r.updatedAt : m), null);
  const off = ms(sw.disabledAt);
  const keptUntil = !sw.enabledAt && all.length && Number.isFinite(off) ? iso(off + CC_OFF_KEEP_MS).slice(0, 10) : null;
  const stamp = [sw.enabledAt ?? "", sw.disabledAt ?? "", ...all.map((r) => `${r.id}:${r.seq}:${r.questions.filter((q) => !q.clearedAt).length}`)].join("|");
  return { enabledAt: sw.enabledAt, disabledAt: sw.disabledAt, keptUntil, records, needsYou, dataHealth: dataHealthOf(all, now), lastPush, stamp };
}

/** The viewer's switch. On keeps or restores their records; off keeps them CC_OFF_KEEP_MS. */
export function ccSetSwitch(ownerId: string, on: boolean, now: number = Date.now()): CcSwitch {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(ownerId)) throw new NotFoundError("BAB does not know you yet");
  const at = iso(now);
  if (on) db.prepare("UPDATE users SET command_center_enabled_at = COALESCE(command_center_enabled_at, ?), command_center_disabled_at = NULL WHERE id = ?").run(at, ownerId);
  else db.prepare("UPDATE users SET command_center_enabled_at = NULL, command_center_disabled_at = COALESCE(command_center_disabled_at, ?) WHERE id = ?").run(at, ownerId);
  auditCc(ownerId, on ? "enable" : "disable", ownerId, on ? "on" : "off", "ui");
  return ccSwitch(ownerId);
}

/** Delete now: every record of the viewer, at once. */
export function ccDeleteAll(ownerId: string): { deleted: number } {
  const s = store();
  const n = s.owners.get(ownerId)?.size ?? 0;
  auditCc(ownerId, "delete_all", ownerId, `deleted ${n}`, "ui");
  s.owners.delete(ownerId);
  s.dirty = true;
  // Written at once, so a crash within the save interval cannot bring the records back.
  saveCommandCenterSnapshot();
  return { deleted: n };
}
