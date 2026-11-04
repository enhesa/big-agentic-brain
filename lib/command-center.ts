/**
 * Command Center: a private page where a person sees what their own agent sessions are doing
 * (docs/command-center.md). Agents push whole initiative records; the page only shows them.
 *
 * - Opt-in is the plugin: a person who installs the command-center plugin opts in, and their
 *   agent's first publish creates their Command Center. There is no switch on the page. Deleting,
 *   exporting and export-app consent are tool actions, owner only (delete_all, export,
 *   grant_export, revoke_export). The old users.command_center_enabled_at/disabled_at columns
 *   are no longer read; existing rows stay.
 * - One record per initiative, owned by the caller's resolved identity, never by a body field.
 *   A publish is an upsert by `id`: a replay changes nothing.
 * - Strict: unknown fields, bad values and text that is too long are refused with one sentence
 *   naming the field. Nothing is truncated or masked. Text that redact() would change is refused.
 * - The server owns every timestamp except health.checkedAt, so clock skew between machines
 *   never shows.
 * - One store: SQLite (migration v54). Live records in command_center_initiatives, the work log
 *   in command_center_log, export consent in command_center_export_grants. Every query is keyed
 *   by owner_id. A v2 snapshot file is imported once and never changed, so a rollback to v2 can
 *   still read it; it is deleted 30 days after its import, only while its sha256 is the imported one.
 * - The log: a publish may carry `worked` (one line) and `size`; the server adds entries for
 *   task, question, health and state changes it sees. Entry ids are stable, so a retry is a no-op.
 * - Writes are audited (person, initiative id, result), never bodies.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { getDb, inTransaction, resolveDataDir } from "./db";
import { config } from "./config";
import { audit } from "./audit";
import { sensitiveKind } from "./file-checks";
import { assertBoundIdentity, type BoundCaller } from "./bound-identity";
import { checkCommandCenterRateLimit, CC_RATE_LIMIT_BURST, CC_RATE_LIMIT_PER_MINUTE } from "./rate-limit";
import { ApiError, NotFoundError, TooManyRequestsError, ValidationError } from "./errors";
import { ownerIdFor } from "./reminders-view";
import { CC_LINK_MAX, isSessionLink } from "./command-center-link";
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
export const CC_MAX_LINKS = 20;
/** Cleared questions kept per initiative (newest first), on top of the open ones. */
export const CC_MAX_CLEARED_QUESTIONS = 20;
/** Longest `worked` line. */
export const CC_MAX_WORKED = 200;
/** Log entries the page shows per initiative. */
export const CC_PAGE_LOG_ENTRIES = 5;
/** How often one process runs the retention sweep, at most. */
export const CC_SWEEP_INTERVAL_MS = 60_000;

/** Backfill: entries and bytes per upload, link lifetime, unused links per person, backfill entries per person. */
export const CC_BACKFILL_MAX_ENTRIES = 2000;
export const CC_BACKFILL_MAX_BYTES = 1024 * 1024;
export const CC_BACKFILL_LINK_TTL_MINUTES = 15;
export const CC_BACKFILL_LINKS_PER_OWNER = 20;
export const CC_BACKFILL_MAX_PER_PERSON = 20000;
/** Initiatives one backfill upload may create; entries for further unknown initiatives go under "unassigned". */
export const CC_BACKFILL_MAX_CREATED = 20;
/** Current-state records one backfill upload may carry (`current`). */
export const CC_BACKFILL_MAX_CURRENT = 100;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A question older than this is flagged "possibly stale" on the page. */
export const CC_STALE_QUESTION_MS = 3 * DAY_MS;
/** Cleared questions stay visible this long, then go. */
export const CC_CLEARED_KEEP_MS = 7 * DAY_MS;
/** An active initiative with no write for this long is "silent": it leaves the page. */
export const CC_SILENT_MS = 14 * DAY_MS;
/** The one live rule: a record with no write for this long is deleted. Its log entries stay. */
export const CC_LIVE_KEEP_MS = 30 * DAY_MS;
/** How long an imported v2 snapshot file stays in place, so a rollback can still read it. */
export const CC_SNAPSHOT_KEEP_MS = 30 * DAY_MS;
/** Two sessions publishing one initiative within this window are flagged on the card. */
export const CC_TWO_WRITERS_MS = HOUR_MS;
/** How late a recurring initiative's health may be, by cadence. No cadence counts as daily. */
export const CC_OVERDUE_MS: Record<Cadence, number> = { daily: 26 * HOUR_MS, weekly: 8 * DAY_MS, drain: 2 * HOUR_MS };

export const CC_ACTIONS = ["publish", "list", "remove", "backfill_link", "delete_all", "export", "grant_export", "revoke_export"] as const;
export type CcAction = (typeof CC_ACTIONS)[number];
/** v2 actions and what replaced them, so an agent on an old skill text is told the fix. */
export const CC_RETIRED_ACTIONS: Record<string, string> = {
  comment: 'comment is gone: publish the record with "worked", one line on what this turn did',
  health: 'health is gone as an action: publish the recurring record with its "health" field',
  clear_question: "clear_question is gone: publish the record without that question and it is cleared",
};
export const CC_STATES = ["active", "done", "parked"] as const;
export const CC_KINDS = ["project", "recurring"] as const;
export const CC_CADENCES = ["daily", "weekly", "drain"] as const;
export const CC_PRIORITIES = ["urgent", "high", "low", "paused"] as const;
export const CC_TASK_STATUSES = ["pending", "in_progress", "done"] as const;
export const CC_HEALTH_LEVELS = ["green", "amber", "red", "unknown"] as const;
export const CC_SIZES = ["small", "medium", "large"] as const;
export const CC_LOG_KINDS = ["worked", "note", "task_started", "task_done", "question_asked", "question_cleared", "health", "state", "synced"] as const;
export const CC_EXPORT_LEVELS = ["aggregate", "entries"] as const;

type State = (typeof CC_STATES)[number];
type Kind = (typeof CC_KINDS)[number];
type Cadence = (typeof CC_CADENCES)[number];
type Priority = (typeof CC_PRIORITIES)[number];
type TaskStatus = (typeof CC_TASK_STATUSES)[number];
type HealthLevel = (typeof CC_HEALTH_LEVELS)[number];
export type CcSize = (typeof CC_SIZES)[number];
export type CcLogKind = (typeof CC_LOG_KINDS)[number];
export type CcExportLevel = (typeof CC_EXPORT_LEVELS)[number];

/** What every caller is told about content. */
export const CC_CONTENT_RULE = "Never put secrets, client names or customer data in any field.";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Ids that are a route of their own (/api/command-center/export, /api/command-center/backfill/<token>). */
const CC_RESERVED_IDS = ["export", "backfill"];
/** Line breaks and control characters (tab allowed): a log line stays one line wherever it is shown. */
const NOT_ONE_LINE_RE = /[\n\r\u2028\u2029\u0085\v\f\x00-\x08\x0e-\x1f\x7f]/;
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

export interface CcLink {
  label: string;
  url: string;
}

export interface CcSource {
  machine: string | null;
  session: string | null;
  /** The link that opens this session (lib/command-center-link.ts); absent on older records. */
  link?: string | null;
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
  links: CcLink[];
  source: CcSource | null;
}

/** One log entry, as stored and exported. */
export interface CcLogEntry {
  id: string;
  initiative: string;
  title: string | null;
  key: string | null;
  kind: CcLogKind;
  text: string | null;
  size: CcSize | null;
  session: string | null;
  machine: string | null;
  source: "live" | "import" | "backfill";
  at: string;
}

const RECORD_FIELDS = ["v", "id", "title", "area", "key", "state", "kind", "cadence", "deadline", "priority", "tasks", "questions", "health", "links", "source", "expectSeq", "worked", "size"];
const TASK_FIELDS = ["id", "text", "status"];
const QUESTION_FIELDS = ["id", "text", "options"];
const HEALTH_FIELDS = ["level", "reason", "checkedAt"];
const LINK_FIELDS = ["label", "url"];
const SOURCE_FIELDS = ["machine", "session", "link"];

// ---------------------------------------------------------------------------
// Validation. Every refusal names the field and the fix.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function onlyFields(o: Record<string, unknown>, allowed: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!where && k === "comments") throw new ValidationError('comments is gone: send "worked", one line on what this turn did, with the publish');
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

function checkLink(raw: unknown, field: string): CcLink {
  if (!isObject(raw)) throw new ValidationError(`${field} must be an object { label, url }`);
  onlyFields(raw, LINK_FIELDS, `${field}.`);
  return { label: text(raw.label, `${field}.label`, 60)!, url: httpsUrl(raw.url, `${field}.url`) };
}

/** source.link: optional; https:// or claude://claude.ai/ and a plain path only (isSessionLink). */
function sessionLink(raw: unknown, field: string): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") throw new ValidationError(`${field} must be a string`);
  if (raw.length > CC_LINK_MAX) throw new ValidationError(`${field} is ${raw.length} characters; at most ${CC_LINK_MAX}`);
  if (!isSessionLink(raw)) {
    throw new ValidationError(`${field} must be https://host/path (lowercase host) or claude://claude.ai/path, with only letters, digits and / _ - . after the host (no query, fragment, port, empty, . or .. segment, or other scheme)`);
  }
  refuseSensitive(raw, field);
  return raw;
}

function checkSource(raw: unknown): CcSource | null {
  if (raw == null) return null;
  if (!isObject(raw)) throw new ValidationError("source must be an object { machine, session, link }");
  onlyFields(raw, SOURCE_FIELDS, "source.");
  const link = sessionLink(raw.link, "source.link");
  return { machine: text(raw.machine, "source.machine", 20, false), session: text(raw.session, "source.session", 60, false), ...(link ? { link } : {}) };
}

/** Checks a publish body (the whole record) and returns it normalized. `v` is required. */
export function validateRecord(raw: unknown): RecordInput {
  if (!isObject(raw)) throw new ValidationError("The record must be a JSON object with v: 1, id and title");
  onlyFields(raw, RECORD_FIELDS, "");
  if (raw.v === undefined) throw new ValidationError('v is required: add "v": 1 to the record');
  if (raw.v !== 1) throw new ValidationError("v must be 1; this server reads version 1 records only");
  const id = slug(raw.id, "id");
  if (CC_RESERVED_IDS.includes(id)) throw new ValidationError(`id '${id}' is reserved; pick another id`);
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
    throw new ValidationError(`questions: at most ${CC_MAX_OPEN_QUESTIONS} open; leave an answered one out to clear it`);
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
  const links = list(raw.links, "links", CC_MAX_LINKS, "links").map((l, i) => checkLink(l, `links[${i}]`));
  const source = checkSource(raw.source);
  return { id, title, area, key, state, kind, cadence, deadline, priority, tasks, questions, health, links, source };
}

/** The `worked` line and `size` of a publish: one line, no line breaks. */
export function validateWorked(raw: Record<string, unknown>): { worked: string | null; size: CcSize | null } {
  const worked = text(raw.worked, "worked", CC_MAX_WORKED, false);
  if (worked !== null && NOT_ONE_LINE_RE.test(worked)) throw new ValidationError("worked must be one line: what this turn did, without line breaks or control characters");
  let size: CcSize | null = null;
  if (raw.size != null) {
    if (worked === null) throw new ValidationError("size goes with worked: send worked, or leave size out");
    size = oneOf(raw.size, CC_SIZES, "size");
  }
  return { worked: worked === null ? null : worked.trim(), size };
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
// The store: SQLite. Every statement names owner_id.
// ---------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (isoText: string | null | undefined): number => (isoText ? Date.parse(isoText) : NaN);
const bytesOf = (r: CcRecord): number => Buffer.byteLength(JSON.stringify(r), "utf8");

/** A stable entry id: the same facts always give the same id, so a retried write is a no-op. */
export function ccEntryId(...parts: (string | number | null)[]): string {
  return createHash("sha256")
    .update(parts.map((p) => String(p ?? "")).join("\u0000"))
    .digest("hex")
    .slice(0, 32);
}

interface ProcessState {
  imported: boolean;
  lastSweep: number;
  /** Set once the missing command_center_imports table was logged, so it is logged once. */
  warnedNoImports?: boolean;
  /** The snapshot's last hash, by size and mtime, so the sweep re-reads it only when it changed. */
  snapshotHash?: { size: number; mtimeMs: number; sha256: string };
}
const STATE_KEY = "__babCommandCenterState";
type Holder = { [STATE_KEY]?: ProcessState };

function processState(): ProcessState {
  const g = globalThis as Holder;
  return (g[STATE_KEY] ??= { imported: false, lastSweep: 0 });
}

/** Test-only: forget this process's import and sweep memory. The data stays in SQLite. */
export function _resetCommandCenterForTests(): void {
  delete (globalThis as Holder)[STATE_KEY];
}

/** Opens the store: imports a v2 snapshot once, then sweeps at most once a minute. */
function ready(now: number): void {
  const st = processState();
  if (!st.imported) {
    importCommandCenterSnapshot(now);
    st.imported = true;
  }
  if (now - st.lastSweep >= CC_SWEEP_INTERVAL_MS) {
    st.lastSweep = now;
    sweepCommandCenter(now);
  }
}

function loadRecords(owner: string): Map<string, CcRecord> {
  const rows = getDb().prepare("SELECT record FROM command_center_initiatives WHERE owner_id = ? ORDER BY id").all(owner) as { record: string }[];
  const map = new Map<string, CcRecord>();
  for (const row of rows) {
    const r = JSON.parse(row.record) as CcRecord;
    map.set(r.id, r);
  }
  return map;
}

function loadRecord(owner: string, id: string): CcRecord | null {
  const row = getDb().prepare("SELECT record FROM command_center_initiatives WHERE owner_id = ? AND id = ?").get(owner, id) as { record: string } | undefined;
  return row ? (JSON.parse(row.record) as CcRecord) : null;
}

function saveRecord(owner: string, r: CcRecord): void {
  getDb()
    .prepare(
      `INSERT INTO command_center_initiatives (owner_id, id, record, seq, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, id) DO UPDATE SET record = excluded.record, seq = excluded.seq, bytes = excluded.bytes, updated_at = excluded.updated_at`,
    )
    .run(owner, r.id, JSON.stringify(r), r.seq, bytesOf(r), r.updatedAt);
}

function personUsage(owner: string): { initiatives: number; bytes: number } {
  const row = getDb().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM command_center_initiatives WHERE owner_id = ?").get(owner) as { n: number; b: number };
  return { initiatives: Number(row.n), bytes: Number(row.b) };
}

/** Writes log entries; an id already there is left as it is. Returns how many were new. */
function writeLog(owner: string, entries: CcLogEntry[]): number {
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO command_center_log (owner_id, entry_id, initiative_id, title, key, kind, text, size, session, machine, source, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const e of entries) {
    const res = stmt.run(owner, e.id, e.initiative, e.title, e.key, e.kind, e.text, e.size, e.session, e.machine, e.source, e.at);
    n += Number(res.changes);
  }
  return n;
}

interface LogRow {
  entry_id: string;
  initiative_id: string;
  title: string | null;
  key: string | null;
  kind: CcLogKind;
  text: string | null;
  size: CcSize | null;
  session: string | null;
  machine: string | null;
  source: CcLogEntry["source"];
  at: string;
}

function entryOf(r: LogRow): CcLogEntry {
  return { id: r.entry_id, initiative: r.initiative_id, title: r.title, key: r.key, kind: r.kind, text: r.text, size: r.size, session: r.session, machine: r.machine, source: r.source, at: r.at };
}

const LOG_COLUMNS = "entry_id, initiative_id, title, key, kind, text, size, session, machine, source, at";

/** The person's log, oldest first, optionally within [from, to). */
export function ccLogOf(owner: string, range: { from?: string; to?: string } = {}): CcLogEntry[] {
  const rows = getDb()
    .prepare(`SELECT ${LOG_COLUMNS} FROM command_center_log WHERE owner_id = ? AND at >= ? AND at < ? ORDER BY at, entry_id`)
    .all(owner, range.from ?? "", range.to ?? "9999") as unknown as LogRow[];
  return rows.map(entryOf);
}

/** The newest entries of one initiative, newest first. */
export function ccRecentLog(owner: string, initiative: string, limit: number = CC_PAGE_LOG_ENTRIES): CcLogEntry[] {
  const rows = getDb()
    .prepare(`SELECT ${LOG_COLUMNS} FROM command_center_log WHERE owner_id = ? AND initiative_id = ? ORDER BY at DESC, entry_id DESC LIMIT ?`)
    .all(owner, initiative, limit) as unknown as LogRow[];
  return rows.map(entryOf);
}

/** Deletes every Command Center row of one person: records, log and grants. */
function deleteEverything(owner: string): { records: number; entries: number } {
  const db = getDb();
  const records = Number(db.prepare("DELETE FROM command_center_initiatives WHERE owner_id = ?").run(owner).changes);
  const entries = Number(db.prepare("DELETE FROM command_center_log WHERE owner_id = ?").run(owner).changes);
  db.prepare("DELETE FROM command_center_export_grants WHERE owner_id = ?").run(owner);
  db.prepare("DELETE FROM command_center_backfill_links WHERE owner_id = ?").run(owner);
  return { records, entries };
}

// ---------------------------------------------------------------------------
// Retention: one rule each for the live view and the log.
// ---------------------------------------------------------------------------

/** On the page: active and not silent. Done, parked and silent ones stay in list and in the log. */
export function onPage(r: CcRecord, now: number): boolean {
  return r.state === "active" && (r.priority === "paused" || now - ms(r.updatedAt) < CC_SILENT_MS);
}

/** Drops cleared questions past CC_CLEARED_KEEP_MS. True when anything changed. */
function pruneQuestions(r: CcRecord, now: number): boolean {
  const before = r.questions.length;
  r.questions = r.questions.filter((q) => !q.clearedAt || now - ms(q.clearedAt) < CC_CLEARED_KEEP_MS);
  return r.questions.length !== before;
}

export interface CcSweepResult {
  records: number;
  entries: number;
  people: number;
}

/**
 * Retention for everyone: live records with no write for CC_LIVE_KEEP_MS and log entries older
 * than BAB_COMMAND_CENTER_LOG_DAYS. `people` stays 0: a person's data goes as a whole only by
 * their own delete_all.
 */
export function sweepCommandCenter(now: number = Date.now()): CcSweepResult {
  const db = getDb();
  const out: CcSweepResult = { records: 0, entries: 0, people: 0 };
  out.records += Number(db.prepare("DELETE FROM command_center_initiatives WHERE updated_at < ?").run(iso(now - CC_LIVE_KEEP_MS)).changes);
  retireImportedSnapshot(now);
  out.entries += Number(db.prepare("DELETE FROM command_center_log WHERE at < ?").run(iso(now - config().commandCenterLogDays * DAY_MS)).changes);
  db.prepare("DELETE FROM command_center_backfill_links WHERE used_at IS NOT NULL OR expires_at <= ?").run(iso(now));
  return out;
}

// ---------------------------------------------------------------------------
// The one-time import of a v2 snapshot
// ---------------------------------------------------------------------------

export function ccSnapshotPath(): string {
  return path.join(resolveDataDir(), "command-center-snapshot.json");
}

/** The sha256 of a file's bytes. */
function fileSha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The snapshot's sha256, re-read only when its size or mtime changed since the last call. */
function snapshotSha256(file: string): string {
  const st = statSync(file);
  const cached = processState().snapshotHash;
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.sha256;
  const sha256 = fileSha256(file);
  processState().snapshotHash = { size: st.size, mtimeMs: st.mtimeMs, sha256 };
  return sha256;
}

function deleteSnapshotFile(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch (err) {
    console.warn(`bab: could not delete ${path.basename(file)}: ` + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * The v2 snapshot stays untouched CC_SNAPSHOT_KEEP_MS after its import, so a rollback to v2.19 still
 * reads it, and is then deleted: it holds v2 records that Delete now and retention no longer reach.
 * It is deleted only while its sha256 is an imported one that is past the window. A file that a
 * rolled-back v2.19 rewrote has a new sha256, so it is kept; the next v3 start imports it and its
 * own window starts then. A command-center-snapshot.imported.json left by an earlier v3 build is
 * deleted once the latest import is past the window.
 */
function retireImportedSnapshot(now: number): void {
  const file = ccSnapshotPath();
  const legacy = ccImportedSnapshotPath();
  const hasFile = existsSync(file);
  const hasLegacy = existsSync(legacy);
  if (!hasFile && !hasLegacy) return;
  const cutoff = iso(now - CC_SNAPSHOT_KEEP_MS);
  try {
    const db = getDb();
    if (hasLegacy) {
      const row = db.prepare("SELECT MAX(imported_at) AS at FROM command_center_imports").get() as { at: string | null };
      if (row.at && row.at <= cutoff) deleteSnapshotFile(legacy);
    }
    if (hasFile) {
      let sha256: string;
      try {
        sha256 = snapshotSha256(file);
      } catch {
        return; // Gone or unreadable right now: the next sweep looks again.
      }
      const row = db.prepare("SELECT imported_at AS at FROM command_center_imports WHERE sha256 = ?").get(sha256) as { at: string } | undefined;
      if (row && row.at <= cutoff) {
        deleteSnapshotFile(file);
        delete processState().snapshotHash;
      }
    }
  } catch (err) {
    // A database that ran an early v54 without command_center_imports: keep the files, never fail
    // a Command Center call over it. Any other error is a real one.
    if (!/no such table/i.test(err instanceof Error ? err.message : String(err))) throw err;
    if (!processState().warnedNoImports) {
      processState().warnedNoImports = true;
      console.warn("bab: cannot read command_center_imports, so the Command Center snapshot is kept: " + (err instanceof Error ? err.message : String(err)));
    }
  }
}

/** Where an earlier v3 build renamed an imported snapshot. Only deleted now, never written. */
export function ccImportedSnapshotPath(): string {
  return path.join(resolveDataDir(), "command-center-snapshot.imported.json");
}

function isoOrNull(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string" || !ISO_TIME_RE.test(raw) || Number.isNaN(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

/** An imported time as a UTC ISO string, or null when it is not one or lies in the future. */
function normalTime(raw: unknown, now: number): string | null {
  const t = isoOrNull(raw);
  return t && Date.parse(t) <= now + HOUR_MS ? t : null;
}

/** A v2 comment, kept as a "note" log entry at its own time. */
interface OldComment {
  id: string;
  text: string;
  at: string;
}

/**
 * Checks one v2 snapshot record as strictly as a new publish, plus the server fields. Returns the
 * record and its old comments, or null to drop it.
 */
function checkedRecord(raw: unknown, now: number): { record: CcRecord; comments: OldComment[] } | null {
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
      links: raw.links,
      source: raw.source,
    });
    const updatedAt = isoOrNull(raw.updatedAt);
    if (!updatedAt || Date.parse(updatedAt) > now + HOUR_MS) return null;
    if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 1) return null;
    if (typeof raw.publishedBy !== "string" || raw.publishedBy.length > 100) return null;
    const questions: CcQuestion[] = [];
    for (const [i, q] of ([...openQs, ...clearedQs] as Record<string, unknown>[]).entries()) {
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
    const comments: OldComment[] = [];
    for (const c of Array.isArray(raw.comments) ? raw.comments.slice(-20) : []) {
      if (!isObject(c) || typeof c.id !== "string" || !SLUG_RE.test(c.id)) continue;
      try {
        const joined = typeof c.text === "string" ? c.text.replace(/[\r\n\u2028\u2029\u0085\v\f]+/g, " ") : c.text;
        const body = text(joined, "comment", 500)!;
        if (NOT_ONE_LINE_RE.test(body)) continue;
        comments.push({ id: c.id, text: body, at: normalTime(c.at, now) ?? updatedAt });
      } catch {
        // A comment that would be refused today is left out; the record still loads.
      }
    }
    const record: CcRecord = { v: 1, ...input, tasks, questions, health, updatedAt, seq: raw.seq, publishedBy: raw.publishedBy, writers };
    if (bytesOf(record) > CC_MAX_RECORD_BYTES) return null;
    return { record, comments };
  } catch {
    return null;
  }
}

export interface CcImportResult {
  imported: number;
  skipped: number;
  dropped: number;
  notes: number;
}

/**
 * Moves a v2 snapshot into SQLite: every record is checked again, broken ones are dropped and
 * counted, a record already in SQLite is never overwritten, and old comments become "note" log
 * entries with stable ids. The file itself is never renamed or rewritten, so a rollback to v2.19
 * still reads it. Its sha256 is recorded, and a later start skips a file with a recorded sha256
 * quietly (a person may have removed or deleted records since). A file with a new sha256 (rewritten
 * by a rolled-back v2.19) is imported again: only initiatives not in SQLite are added. Never throws.
 */
export function importCommandCenterSnapshot(now: number = Date.now()): CcImportResult | null {
  const file = ccSnapshotPath();
  if (!existsSync(file)) return null;
  const out: CcImportResult = { imported: 0, skipped: 0, dropped: 0, notes: 0 };
  let raw: Buffer;
  let sha256: string;
  try {
    raw = readFileSync(file);
    sha256 = createHash("sha256").update(raw).digest("hex");
  } catch (err) {
    console.warn("bab: the Command Center snapshot is not readable; it is left in place and not imported: " + (err instanceof Error ? err.message : String(err)));
    return null;
  }
  try {
    const db = getDb();
    if (db.prepare("SELECT 1 FROM command_center_imports WHERE sha256 = ?").get(sha256)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      console.warn("bab: the Command Center snapshot is not readable JSON; it is left in place and not imported: " + (err instanceof Error ? err.message : String(err)));
      return null;
    }
    const owners = isObject(parsed) && isObject(parsed.owners) ? parsed.owners : {};
    const won = inTransaction(db, () => {
      // Another replica may have imported the same file since the check above: then it owns the
      // import, and this one does nothing.
      if (!Number(db.prepare("INSERT OR IGNORE INTO command_center_imports (sha256, imported_at) VALUES (?, ?)").run(sha256, iso(now)).changes)) return false;
      for (const [owner, records] of Object.entries(owners)) {
        if (!owner || owner.includes("/") || owner.length > 320 || !Array.isArray(records)) {
          out.dropped += Array.isArray(records) ? records.length : 1;
          continue;
        }
        const seen = new Set<string>();
        for (const item of records) {
          const checked = checkedRecord(item, now);
          if (!checked || seen.has(checked.record.id)) {
            out.dropped += 1;
            continue;
          }
          seen.add(checked.record.id);
          const r = checked.record;
          const usage = personUsage(owner);
          if (loadRecord(owner, r.id)) {
            // SQLite holds this initiative already: its record and log stay as they are, so
            // changes made to it on a rolled-back v2.19 are not imported (agents republish).
            out.skipped += 1;
            continue;
          } else if (usage.initiatives >= CC_MAX_INITIATIVES || usage.bytes + bytesOf(r) > CC_MAX_BYTES_PER_PERSON) {
            out.dropped += 1;
            continue;
          } else {
            saveRecord(owner, r);
            out.imported += 1;
          }
          out.notes += writeLog(
            owner,
            checked.comments.map((c) => ({
              id: ccEntryId("note", r.id, c.id, c.at),
              initiative: r.id,
              title: r.title,
              key: r.key,
              kind: "note" as const,
              text: c.text,
              size: null,
              session: null,
              machine: null,
              source: "import" as const,
              at: c.at,
            })),
          );
        }
      }
      return true;
    });
    if (!won) {
      console.log("bab: the Command Center snapshot was imported by another process; not imported again.");
      return null;
    }
  } catch (err) {
    console.warn("bab: could not import the Command Center snapshot; it is left in place and tried again at the next start: " + (err instanceof Error ? err.message : String(err)));
    return null;
  }
  console.log(
    `bab: imported the Command Center snapshot: ${out.imported} records, ${out.notes} notes; ${out.skipped} already there, ${out.dropped} dropped. ` +
      "The file is left untouched for a rollback to v2.19 and deleted 30 days after this import.",
  );
  return out;
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

/** A publish this recent makes an initiative ACTIVE on the page; older is IDLE. */
export const CC_ACTIVE_MS = 2 * HOUR_MS;
export const CC_STATUSES = ["needs_you", "active", "idle", "finished"] as const;
export type CcStatus = (typeof CC_STATUSES)[number];

/**
 * The one status badge a card shows. An open question wins, then finished (state done or every
 * task done), then active (a publish under CC_ACTIVE_MS ago), else idle. Paused and parked are idle.
 */
export function ccStatusOf(r: CcRecord, f: Pick<CcFlags, "openQuestions">, now: number): CcStatus {
  if (f.openQuestions > 0) return "needs_you";
  if (r.state === "done" || (r.tasks.length > 0 && r.tasks.every((t) => t.status === "done"))) return "finished";
  if (r.state === "parked" || r.priority === "paused") return "idle";
  return now - ms(r.updatedAt) < CC_ACTIVE_MS ? "active" : "idle";
}

const STATUS_ORDER: Record<CcStatus, number> = { needs_you: 0, active: 1, idle: 2, finished: 3 };
const rank = (r: { kind: CcRecord["kind"]; status: CcStatus }): number => (r.kind === "recurring" ? 9 : STATUS_ORDER[r.status]);
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

/** 404 when switched off on this BAB. */
export function assertCommandCenterEnabled(): void {
  if (!config().commandCenter) throw new NotFoundError("Command Center is switched off on this BAB");
}

export function assertCommandCenterIdentity(caller: BoundCaller): void {
  assertBoundIdentity(caller, false, "Command Center");
}

function assertRate(owner: string): void {
  if (!checkCommandCenterRateLimit(owner)) {
    throw new TooManyRequestsError(`Too many Command Center calls: at most ${CC_RATE_LIMIT_PER_MINUTE} a minute, ${CC_RATE_LIMIT_BURST} at once. Wait a few seconds, then publish the whole record once.`);
  }
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
// Operations. Each runs in one SQLite transaction from its first read to its last write.
// ---------------------------------------------------------------------------

function usageAnswer(owner: string): { initiatives: number; bytes: number; maxInitiatives: number; maxBytes: number } {
  return { ...personUsage(owner), maxInitiatives: CC_MAX_INITIATIVES, maxBytes: CC_MAX_BYTES_PER_PERSON };
}

/** Checks the size limits for `next` replacing `prev`. */
function assertFits(owner: string, next: CcRecord, prev: CcRecord | null): void {
  const size = bytesOf(next);
  if (size > CC_MAX_RECORD_BYTES) {
    const cleared = next.questions.filter((q) => q.clearedAt).length;
    throw new CcTooLargeError(
      `The record is ${Math.ceil(size / 1024)} KB; at most ${CC_MAX_RECORD_BYTES / 1024} KB per initiative. Send fewer or shorter tasks or links` +
        (cleared ? ` (it also keeps ${cleared} cleared questions for 7 days).` : "."),
    );
  }
  const usage = personUsage(owner);
  if (!prev && usage.initiatives >= CC_MAX_INITIATIVES) {
    throw new ValidationError(`You have ${CC_MAX_INITIATIVES} initiatives, the most Command Center keeps. Remove one first.`);
  }
  const total = usage.bytes - (prev ? bytesOf(prev) : 0) + size;
  if (total > CC_MAX_BYTES_PER_PERSON) {
    throw new CcTooLargeError(`Your initiatives would take ${Math.ceil(total / 1024)} KB; at most ${CC_MAX_BYTES_PER_PERSON / 1024} KB per person. Remove or shorten one first.`);
  }
}

export interface PublishResult {
  id: string;
  seq: number;
  questions: { id: string; askedAt: string; clearedAt: string | null }[];
  /** Open questions you sent that the person already dismissed on the page: they stay cleared. */
  dismissed?: string[];
  /** True when the record was already exactly this: nothing in it changed. */
  unchanged?: true;
  /** The id of the `worked` entry, when one was sent. A retry answers the same id. */
  logged?: string;
}

/** The record without the fields the server changes on every write, to spot a replay. */
function contentOf(r: CcRecord): string {
  return JSON.stringify({ ...r, updatedAt: null, seq: null, publishedBy: null, writers: null });
}

/** The log entries the server sees by itself between two versions of a record. */
function derivedEntries(prev: CcRecord | null, next: CcRecord, base: Omit<CcLogEntry, "id" | "kind" | "text" | "at" | "size">): CcLogEntry[] {
  const out: CcLogEntry[] = [];
  const add = (kind: CcLogKind, idParts: (string | number | null)[], textValue: string | null, at: string) =>
    out.push({ ...base, id: ccEntryId(kind, next.id, ...idParts), kind, text: textValue, size: null, at });
  for (const t of next.tasks) {
    const old = prev?.tasks.find((p) => p.id === t.id);
    if (t.startedAt && t.status === "in_progress" && old?.startedAt !== t.startedAt) add("task_started", [t.id, t.startedAt], t.text, t.startedAt);
    if (t.finishedAt && old?.finishedAt !== t.finishedAt) add("task_done", [t.id, t.finishedAt], t.text, t.finishedAt);
  }
  for (const q of next.questions) {
    const old = prev?.questions.find((p) => p.id === q.id);
    if (!old || old.askedAt !== q.askedAt) add("question_asked", [q.id, q.askedAt], q.text, q.askedAt);
    if (q.clearedAt && old?.clearedAt !== q.clearedAt) add("question_cleared", [q.id, q.clearedAt], q.text, q.clearedAt);
  }
  if (next.health && (!prev?.health || prev.health.level !== next.health.level)) {
    add("health", [next.health.level, next.health.receivedAt], next.health.reason ? `${next.health.level}: ${next.health.reason}` : next.health.level, next.health.receivedAt);
  }
  if (prev && prev.state !== next.state) add("state", [next.state, next.seq, next.updatedAt], next.state, next.updatedAt);
  return out;
}

export function ccPublish(actor: CcActor, owner: string, body: Record<string, unknown>, via: AuditVia, now: number = Date.now()): PublishResult {
  const expectSeq = parseExpectSeq(body.expectSeq);
  const input = validateRecord(body);
  const { worked, size } = validateWorked(body);
  ready(now);
  const db = getDb();
  return inTransaction(db, () => {
    const prev = loadRecord(owner, input.id);
    if (prev) pruneQuestions(prev, now);
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
    // Health is a field: left out on a recurring initiative, it stays; an explicit null clears it.
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
      updatedAt: at,
      seq: (prev?.seq ?? 0) + 1,
      publishedBy: publisherOf(actor),
      writers: writers.slice(-5),
    };
    const base = { initiative: input.id, title: input.title, key: input.key, session, machine: input.source?.machine ?? null, source: "live" as const };
    const answer = (r: CcRecord, logged: string | null): PublishResult => ({
      id: r.id,
      seq: r.seq,
      questions: r.questions.map((q) => ({ id: q.id, askedAt: q.askedAt, clearedAt: q.clearedAt })),
      ...(dismissed.length ? { dismissed } : {}),
      ...(logged ? { logged } : {}),
    });
    // A replay of the same record changes nothing: no new seq, no audit row. That holds for a
    // retried PUT whose expectSeq the first try already moved past, so a replay is never a 409.
    // A `worked` line on it is still logged, unless it repeats this session's newest line here.
    if (prev && contentOf(prev) === contentOf(next)) {
      let logged: string | null = null;
      if (worked) {
        const last = db
          .prepare("SELECT entry_id, text FROM command_center_log WHERE owner_id = ? AND initiative_id = ? AND kind = 'worked' AND COALESCE(session, '') = ? ORDER BY at DESC, entry_id DESC LIMIT 1")
          .get(owner, input.id, session ?? "") as { entry_id: string; text: string } | undefined;
        if (last && last.text === worked) logged = last.entry_id;
        else {
          logged = ccEntryId("worked", input.id, prev.seq, session, worked, at);
          writeLog(owner, [{ ...base, id: logged, kind: "worked", text: worked, size, at }]);
          // Logged work is activity: the record is not silent, but its seq stays.
          const touched = { ...prev, updatedAt: at };
          saveRecord(owner, touched);
          auditCc(owner, "publish", input.id, "worked", via);
        }
      }
      return { ...answer(prev, logged), unchanged: true };
    }
    if (conflict) {
      throw new CcConflictError(
        `expectSeq is ${expectSeq} but '${input.id}' is at seq ${prev?.seq ?? 0}. Merge your change into the current record (in current) and publish again with expectSeq ${prev?.seq ?? 0}.`,
        prev ?? null,
      );
    }
    assertFits(owner, next, prev);
    auditCc(owner, "publish", input.id, prev ? "updated" : "created", via);
    saveRecord(owner, next);
    const entries = derivedEntries(prev, next, base);
    let logged: string | null = null;
    if (worked) {
      // One publish, one seq: the id is fixed by the seq it produced.
      logged = ccEntryId("worked", input.id, next.seq, session, worked, at);
      entries.push({ ...base, id: logged, kind: "worked", text: worked, size, at });
    }
    writeLog(owner, entries);
    return answer(next, logged);
  });
}

export function ccClearQuestion(owner: string, input: { id: unknown; questionId: unknown }, via: AuditVia, now: number = Date.now()): { cleared: boolean; reason?: string } {
  const id = slug(input.id, "id");
  const questionId = slug(input.questionId, "questionId");
  ready(now);
  return inTransaction(getDb(), () => {
    const r = loadRecord(owner, id);
    const q = r?.questions.find((x) => x.id === questionId && !x.clearedAt);
    if (!r || !q) return { cleared: false, reason: "unknown" };
    // From the page ("ui") neither seq nor updatedAt moves: a dismissal is not the agent's work, so it
    // must not hide silence or break the agent's next expectSeq.
    const clearedAt = iso(now);
    const questions = r.questions.map((x) => (x === q ? { ...x, clearedAt } : x));
    const next: CcRecord = via === "ui" ? { ...r, questions } : { ...r, questions, seq: r.seq + 1, updatedAt: clearedAt };
    auditCc(owner, "clear", id, "cleared", via);
    saveRecord(owner, next);
    writeLog(owner, [
      {
        id: ccEntryId("question_cleared", id, q.id, clearedAt),
        initiative: id,
        title: r.title,
        key: r.key,
        kind: "question_cleared",
        text: q.text,
        size: null,
        session: null,
        machine: null,
        source: "live",
        at: clearedAt,
      },
    ]);
    return { cleared: true };
  });
}

export function ccRemove(owner: string, input: { id: unknown }, via: AuditVia, now: number = Date.now()): { removed: boolean } {
  const id = slug(input.id, "id");
  ready(now);
  return inTransaction(getDb(), () => {
    if (!loadRecord(owner, id)) return { removed: false };
    auditCc(owner, "remove", id, "removed", via);
    // The log stays: removing an initiative takes it off the page, not out of the person's history.
    getDb().prepare("DELETE FROM command_center_initiatives WHERE owner_id = ? AND id = ?").run(owner, id);
    return { removed: true };
  });
}

export function ccGet(owner: string, id: unknown, now: number = Date.now()): CcRecord & CcFlags {
  const key = slug(id, "id");
  ready(now);
  const r = loadRecord(owner, key);
  if (!r) throw new NotFoundError(`No initiative '${key}' in your Command Center. Publish the whole record first.`);
  pruneQuestions(r, now);
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

export function ccList(owner: string, now: number = Date.now()): { initiatives: CcListItem[]; dataHealth: CcDataHealth; usage: ReturnType<typeof usageAnswer>; lastPush: string | null } {
  ready(now);
  const all = sortRecords([...loadRecords(owner).values()]);
  const initiatives = all.map((r) => {
    pruneQuestions(r, now);
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
  return { initiatives, dataHealth: dataHealthOf(all, now), usage: usageAnswer(owner), lastPush };
}

/**
 * The MCP path only: merges a `record` argument over the other fields, so a client can send the
 * whole record as one declared object. `action` and `id` count only at the top level; the ones
 * inside `record` are ignored.
 */
function mergeRecordArg(args: Record<string, unknown>): Record<string, unknown> {
  if (!("record" in args) || args.record === undefined) return args;
  const { record, ...top } = args;
  if (!isObject(record)) {
    throw new ValidationError('record must be a JSON object, such as "record": { "v": 1, "title": "Billing export" }, with action and id beside it; send it as an object, not text or a list');
  }
  const { action: _action, id: _id, ...fields } = record;
  void _action;
  void _id;
  return { ...top, ...fields };
}

const CC_MCP_NUMBERS = ["v", "expectSeq"];
const CC_MCP_JSON = ["record", "tasks", "questions", "links", "options", "health", "source"];

/** Fields where JSON null is a real value: it clears them. */
const CC_MCP_NULLABLE = ["health"];

function parseJsonArg(value: string, field: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (parsed === null && CC_MCP_NULLABLE.includes(field)) return null;
  if (parsed === null || typeof parsed !== "object") {
    throw new ValidationError(`${field} came as text that is not a JSON array or object; send it as an array or object, or put the whole record in "record"`);
  }
  return parsed;
}

/** How deep `record` may nest inside `record` on the MCP path. */
const CC_MCP_MAX_DEPTH = 4;

/**
 * The MCP path only: some clients send fields the slim tool schema does not declare as strings.
 * Reads a numeric string for v and expectSeq, and JSON text for the array and object fields. REST stays strict.
 */
export function ccMcpArgs(args: Record<string, unknown>, depth: number = 0): Record<string, unknown> {
  if (depth > CC_MCP_MAX_DEPTH) {
    throw new ValidationError('record is nested too deep: send one record object, such as "record": { "v": 1, "title": "Billing export" }, not a record inside a record');
  }
  const out: Record<string, unknown> = { ...args };
  for (const k of CC_MCP_NUMBERS) {
    const v = out[k];
    if (typeof v === "string" && /^\d+$/.test(v.trim())) out[k] = Number(v.trim());
  }
  for (const k of CC_MCP_JSON) {
    if (typeof out[k] === "string") out[k] = parseJsonArg(out[k] as string, k);
  }
  if (Array.isArray(out.questions)) {
    out.questions = out.questions.map((q, i) =>
      isObject(q) && typeof q.options === "string" ? { ...q, options: parseJsonArg(q.options, `questions[${i}].options`) } : q,
    );
  }
  // A record sent as JSON text can carry the same string-typed fields.
  if (isObject(out.record)) out.record = ccMcpArgs(out.record, depth + 1);
  return out;
}

/** The gates every call passes, in order: switch, identity, pace. Returns the owner. */
function passGates(actor: CcActor, origin: string): string {
  assertCommandCenterEnabled();
  assertCommandCenterIdentity(actor);
  const owner = ownerOf(actor);
  assertRate(owner);
  return owner;
}

/**
 * The one entry point for the REST routes and the MCP tool: switch, identity, pace, then the
 * action. The owner is always the caller's resolved identity, so every action, delete_all and the
 * export ones too, acts on the caller's own data only. `prepare` reshapes the args after the gates
 * (the MCP path), so a caller who fails a gate gets the gate answer, not a 400 about the args.
 */
export function runCommandCenter(
  actor: CcActor,
  rawArgs: Record<string, unknown>,
  via: AuditVia,
  origin: string,
  prepare?: (args: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  const action = typeof rawArgs.action === "string" ? rawArgs.action : "";
  if (Object.hasOwn(CC_RETIRED_ACTIONS, action)) throw new ValidationError(CC_RETIRED_ACTIONS[action]);
  if (!CC_ACTIONS.includes(action as CcAction)) {
    throw new ValidationError(`action must be one of ${CC_ACTIONS.join(", ")}; required, has no default`);
  }
  const owner = passGates(actor, origin);
  const args = prepare ? prepare(rawArgs) : rawArgs;
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
    case "list":
      // With an id: that one initiative, whole (the same answer as GET /api/command-center/<id>).
      pick(["id"]);
      return args.id === undefined ? ccList(owner) : ccGet(owner, args.id);
    case "remove":
      pick(["id"]);
      return ccRemove(owner, { id: args.id }, via);
    case "backfill_link":
      pick([]);
      return createBackfillLink(owner, origin, via);
    case "delete_all":
      // Every record, log entry, export grant and backfill link of the caller. Only on the
      // person's own ask; the tool is marked destructive, so the client confirms the call too.
      pick([]);
      return ccDeleteAll(owner, via);
    case "export":
      pick([]);
      return ccExportOwn(owner, via);
    case "grant_export":
      // id is the export app; level (aggregate, the default, or entries) may also come in record.
      pick(["id", "level"]);
      return ccGrantExport(owner, args.id, args.level, via);
    case "revoke_export":
      pick(["id"]);
      return ccRevokeExport(owner, args.id, via);
  }
}

/**
 * The MCP tool: string-typed fields read as in ccMcpArgs, and a 409 that carries the current record
 * in its text, because an MCP error is text only. REST keeps `current` as a field.
 */
export function runCommandCenterMcp(actor: CcActor, args: Record<string, unknown>, origin: string): unknown {
  try {
    return runCommandCenter(actor, args, "mcp", origin, (a) => mergeRecordArg(ccMcpArgs(a)));
  } catch (err) {
    if (err instanceof CcConflictError) {
      throw new CcConflictError(`${err.message}\ncurrent: ${JSON.stringify(err.current)}`, err.current);
    }
    throw err;
  }
}

/** GET of one record, for the REST route: the same gates as runCommandCenter. */
export function runCommandCenterGet(actor: CcActor, id: unknown, origin: string): CcRecord & CcFlags {
  return ccGet(passGates(actor, origin), id);
}

// ---------------------------------------------------------------------------
// Backfill: historic worked lines from a person's local tool, through a single-use link.
// ---------------------------------------------------------------------------

/** What bab_command_center action=backfill_link answers. */
export interface CcBackfillLink {
  /** POST the upload body here. Works once, within CC_BACKFILL_LINK_TTL_MINUTES. */
  url: string;
  expiresAt: string;
  maxEntries: number;
  /** Current-state records (`current`) per upload. */
  maxCurrent: number;
  maxBytes: number;
  how: string;
}

const BACKFILL_TOKEN_RE = /^[0-9a-f]{64}$/;
const BACKFILL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const BACKFILL_FIELDS = ["id", "initiative", "title", "key", "worked", "size", "at", "session", "machine"];
const BACKFILL_FUTURE_MS = 5 * 60_000;
const UNASSIGNED = "unassigned";

const hashBackfillToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * A single-use backfill link for the caller, who passed every gate. The owner is fixed now; the
 * upload route takes no identity from the request. Only the sha256 of the token is stored.
 */
export function createBackfillLink(owner: string, origin: string, via: AuditVia, now: number = Date.now()): CcBackfillLink {
  ready(now);
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const expiresAt = iso(now + CC_BACKFILL_LINK_TTL_MINUTES * 60_000);
  inTransaction(db, () => {
    const open = db.prepare("SELECT COUNT(*) AS n FROM command_center_backfill_links WHERE owner_id = ? AND used_at IS NULL AND expires_at > ?").get(owner, iso(now)) as { n: number };
    if (Number(open.n) >= CC_BACKFILL_LINKS_PER_OWNER) {
      throw new TooManyRequestsError(`You have ${CC_BACKFILL_LINKS_PER_OWNER} unused backfill links: use one, or wait ${CC_BACKFILL_LINK_TTL_MINUTES} minutes for them to expire`);
    }
    db.prepare("INSERT INTO command_center_backfill_links (token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hashBackfillToken(token), owner, iso(now), expiresAt);
    audit(db, owner, "cc_backfill_link", "command_center", "-", via, { details: { open: Number(open.n) + 1 } });
  });
  return {
    url: `${origin}/api/command-center/backfill/${token}`,
    expiresAt,
    maxEntries: CC_BACKFILL_MAX_ENTRIES,
    maxCurrent: CC_BACKFILL_MAX_CURRENT,
    maxBytes: CC_BACKFILL_MAX_BYTES,
    how: `Run the backfill tool's upload mode with this url; it takes one upload, within ${CC_BACKFILL_LINK_TTL_MINUTES} minutes.`,
  };
}

/**
 * Spends a backfill link in one conditional statement, so two uploads racing on one link cannot
 * both get it. Returns its owner, or null for an unknown, used, expired or malformed token, and
 * while Command Center is switched off (then nothing is spent).
 */
export function consumeBackfillLink(token: string, now: number = Date.now()): { ownerId: string } | null {
  if (!config().commandCenter) return null;
  if (!BACKFILL_TOKEN_RE.test(token)) return null;
  const db = getDb();
  const hash = hashBackfillToken(token);
  const at = iso(now);
  const row = db
    .prepare("UPDATE command_center_backfill_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING owner_id")
    .get(at, hash, at) as { owner_id: string } | undefined;
  return row ? { ownerId: row.owner_id } : null;
}

export interface CcBackfillResult {
  accepted: number;
  duplicate: number;
  refused: { index: number; id: string | null; reason: string }[];
  /** Initiatives this upload created, parked, for entries with an unknown initiative and a title. */
  created: string[];
  /** Entries logged under "unassigned" instead of the initiative they named. */
  reassigned: { index: number; id: string; reason: string }[];
  /** `current` records created as new active initiatives. */
  syncCreated: number;
  /** `current` records whose id the person has or had (logged or removed before): nothing written. */
  syncSkipped: number;
  /** `current` records that were valid but not created (initiative or size limits), with the reason. */
  syncRefused: { index: number; id: string; reason: string }[];
}

/** One checked `current` record: the person's open work on another machine, to create if absent. */
interface CurrentRecord {
  index: number;
  id: string;
  title: string;
  area: string | null;
  key: string | null;
  tasks: RecordInput["tasks"];
  questions: RecordInput["questions"];
}

const CURRENT_FIELDS = ["id", "title", "area", "key", "state", "tasks", "questions"];

/**
 * Checks one `current` record with the same rules, limits and secret checks as publish. Only
 * state "active" is taken. Throws a ValidationError naming the field.
 */
function checkCurrentRecord(raw: unknown, index: number): CurrentRecord {
  const where = `current[${index}]`;
  if (!isObject(raw)) throw new ValidationError(`${where} must be an object { id, title, state, tasks, questions }`);
  onlyFields(raw, CURRENT_FIELDS, `${where}.`);
  const id = slug(raw.id, `${where}.id`);
  if (CC_RESERVED_IDS.includes(id)) throw new ValidationError(`${where}.id '${id}' is reserved; pick another id`);
  // Entries without an initiative are logged under it; a record by that name would claim them.
  if (id === UNASSIGNED) throw new ValidationError(`${where}.id '${UNASSIGNED}' is reserved for entries without an initiative; pick another id`);
  const title = text(raw.title, `${where}.title`, 120)!;
  const area = text(raw.area, `${where}.area`, 40, false);
  let key: string | null = null;
  if (raw.key != null && raw.key !== "") {
    if (typeof raw.key !== "string" || !KEY_RE.test(raw.key)) throw new ValidationError(`${where}.key must be a ticket key such as KEY-1, or null`);
    key = raw.key;
  }
  if (raw.state !== "active") throw new ValidationError(`${where}.state must be "active": only open work is synced`);
  const tasks = list(raw.tasks, `${where}.tasks`, CC_MAX_TASKS, "tasks").map((t, i) => checkTask(t, `${where}.tasks[${i}]`));
  uniqueIds(tasks, `${where}.tasks`);
  if (Array.isArray(raw.questions) && raw.questions.length > CC_MAX_OPEN_QUESTIONS) {
    throw new ValidationError(`${where}.questions: at most ${CC_MAX_OPEN_QUESTIONS} open; leave an answered one out`);
  }
  const questions = list(raw.questions, `${where}.questions`, CC_MAX_OPEN_QUESTIONS, "open questions").map((q, i) => checkQuestion(q, `${where}.questions[${i}]`));
  uniqueIds(questions, `${where}.questions`);
  return { index, id, title, area, key, tasks, questions };
}

/**
 * True when the person had an initiative with this id before: it has log entries, or a removal
 * was audited. `current` then skips it, so a stale session cannot bring back a removed one.
 */
function hadInitiative(owner: string, id: string): boolean {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM command_center_log WHERE owner_id = ? AND initiative_id = ? LIMIT 1").get(owner, id)) return true;
  return !!db
    .prepare("SELECT 1 FROM audit_log WHERE actor_id = ? AND action = 'cc_remove' AND entity = 'command_center' AND entity_id = ? LIMIT 1")
    .get(owner, id);
}

/** Writes a record only when the person has none with that id. True when it was written. */
function insertRecordIfAbsent(owner: string, r: CcRecord): boolean {
  const res = getDb()
    .prepare("INSERT INTO command_center_initiatives (owner_id, id, record, seq, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, id) DO NOTHING")
    .run(owner, r.id, JSON.stringify(r), r.seq, bytesOf(r), r.updatedAt);
  return Number(res.changes) > 0;
}

interface BackfillEntry {
  index: number;
  id: string;
  initiative: string;
  title: string | null;
  key: string | null;
  worked: string;
  size: CcSize | null;
  at: string;
  session: string | null;
  machine: string | null;
}

/** Checks one upload entry. Throws a ValidationError naming the field. */
function checkBackfillEntry(raw: unknown, index: number, now: number): BackfillEntry {
  const where = `entries[${index}]`;
  if (!isObject(raw)) throw new ValidationError(`${where} must be an object { id, initiative, worked, at, ... }`);
  onlyFields(raw, BACKFILL_FIELDS, `${where}.`);
  if (typeof raw.id !== "string" || !BACKFILL_ID_RE.test(raw.id)) throw new ValidationError(`${where}.id must be 1 to 128 characters: A-Z, a-z, 0-9 and . _ : -`);
  const initiative = slug(raw.initiative, `${where}.initiative`);
  const title = text(raw.title, `${where}.title`, 120, false);
  if (title !== null && NOT_ONE_LINE_RE.test(title)) throw new ValidationError(`${where}.title must be one line`);
  let key: string | null = null;
  if (raw.key != null && raw.key !== "") {
    if (typeof raw.key !== "string" || !KEY_RE.test(raw.key)) throw new ValidationError(`${where}.key must be a ticket key such as KEY-1, or left out`);
    key = raw.key;
  }
  const { worked, size } = validateWorked(raw);
  if (worked === null) throw new ValidationError(`${where}.worked is required: one line on what was done, at most ${CC_MAX_WORKED} characters`);
  const at = raw.at;
  if (typeof at !== "string" || !ISO_TIME_RE.test(at) || Number.isNaN(Date.parse(at))) {
    throw new ValidationError(`${where}.at must be an ISO date and time with a zone, such as 2026-01-31T09:30:00Z`);
  }
  const t = Date.parse(at);
  if (t > now + BACKFILL_FUTURE_MS) throw new ValidationError(`${where}.at is in the future; send when the work happened`);
  if (t < now - config().commandCenterLogDays * DAY_MS) throw new ValidationError(`${where}.at is older than the ${config().commandCenterLogDays} days the log keeps`);
  const session = text(raw.session, `${where}.session`, 60, false);
  const machine = text(raw.machine, `${where}.machine`, 20, false);
  return { index, id: raw.id, initiative, title, key, worked, size, at: new Date(t).toISOString(), session, machine };
}

/**
 * One backfill upload for `owner` (fixed when the link was made). Whole-upload problems throw;
 * a bad entry is refused on its own and the rest still land. Every entry is a "worked" entry with
 * source "backfill" and a stable id, so a second upload of the same entries changes nothing. An
 * unknown initiative with a title gets a parked record; without one, the entry goes under
 * "unassigned". One transaction, one audit row with counts.
 *
 * `current` carries the person's open initiatives from another machine. It is create-only: a
 * record whose id the person has, or had (log entries, or an audited removal), is skipped and
 * counted, never changed; a new one is an
 * active record with server times and one "synced" log entry. Any invalid record refuses the whole
 * upload, as a publish would. New records count toward CC_BACKFILL_MAX_CREATED with the entries'.
 */
export function ccBackfill(owner: string, body: unknown, via: AuditVia, origin: string, now: number = Date.now()): CcBackfillResult {
  assertCommandCenterEnabled();
  if (!isObject(body)) throw new ValidationError('The upload must be a JSON object { "v": 1, "entries": [...], "current": [...] }');
  for (const k of Object.keys(body)) {
    if (k !== "v" && k !== "entries" && k !== "current") throw new ValidationError(`unknown field '${k}'; allowed: v, entries, current`);
  }
  if (body.v !== 1) throw new ValidationError("v must be 1; this server reads version 1 uploads only");
  if (body.entries !== undefined && !Array.isArray(body.entries)) throw new ValidationError("entries must be an array");
  if (body.current !== undefined && !Array.isArray(body.current)) throw new ValidationError("current must be an array");
  const rawEntries: unknown[] = (body.entries as unknown[] | undefined) ?? [];
  const rawCurrent: unknown[] = (body.current as unknown[] | undefined) ?? [];
  if (rawEntries.length === 0 && rawCurrent.length === 0) throw new ValidationError("entries or current must be a non-empty array");
  if (rawEntries.length > CC_BACKFILL_MAX_ENTRIES) {
    throw new CcTooLargeError(`entries: at most ${CC_BACKFILL_MAX_ENTRIES} per upload; you sent ${rawEntries.length}. Upload the rest with a new link.`);
  }
  if (rawCurrent.length > CC_BACKFILL_MAX_CURRENT) {
    throw new CcTooLargeError(`current: at most ${CC_BACKFILL_MAX_CURRENT} records per upload; you sent ${rawCurrent.length}. Upload the rest with a new link.`);
  }
  const current = rawCurrent.map((raw, i) => checkCurrentRecord(raw, i));
  uniqueIds(current, "current");
  const out: CcBackfillResult = { accepted: 0, duplicate: 0, refused: [], created: [], reassigned: [], syncCreated: 0, syncSkipped: 0, syncRefused: [] };
  const checked: BackfillEntry[] = [];
  for (const [i, raw] of rawEntries.entries()) {
    try {
      checked.push(checkBackfillEntry(raw, i, now));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const id = isObject(raw) && typeof raw.id === "string" && BACKFILL_ID_RE.test(raw.id) ? raw.id : null;
      out.refused.push({ index: i, id, reason: err.message });
    }
  }
  ready(now);
  const db = getDb();
  inTransaction(db, () => {
    const records = loadRecords(owner);
    const at = iso(now);
    // Current records first, so an entry for one of them lands under it with its title and key.
    for (const c of current) {
      if (records.has(c.id) || hadInitiative(owner, c.id)) {
        out.syncSkipped += 1;
        continue;
      }
      if (out.created.length + out.syncCreated >= CC_BACKFILL_MAX_CREATED) {
        out.syncRefused.push({ index: c.index, id: c.id, reason: `initiative '${c.id}' was not created: one upload creates at most ${CC_BACKFILL_MAX_CREATED} initiatives` });
        continue;
      }
      const rec: CcRecord = {
        v: 1,
        id: c.id,
        title: c.title,
        area: c.area,
        key: c.key,
        state: "active",
        kind: "project",
        cadence: null,
        deadline: null,
        priority: null,
        tasks: c.tasks.map((t) => ({ ...t, startedAt: t.status !== "pending" ? at : null, finishedAt: t.status === "done" ? at : null })),
        questions: c.questions.map((q) => ({ ...q, askedAt: at, clearedAt: null, session: null })),
        health: null,
        links: [],
        source: null,
        updatedAt: at,
        seq: 1,
        publishedBy: "backfill",
        writers: [],
      };
      try {
        assertFits(owner, rec, null);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        out.syncRefused.push({ index: c.index, id: c.id, reason: `initiative '${c.id}' could not be created: ${err.message}` });
        continue;
      }
      // Insert-if-absent inside this BEGIN IMMEDIATE transaction: a live record is never overwritten.
      if (!insertRecordIfAbsent(owner, rec)) {
        out.syncSkipped += 1;
        continue;
      }
      records.set(rec.id, rec);
      out.syncCreated += 1;
      writeLog(owner, [
        { id: ccEntryId("synced", rec.id, at), initiative: rec.id, title: rec.title, key: rec.key, kind: "synced", text: null, size: null, session: null, machine: null, source: "backfill", at },
      ]);
    }
    const counted = db.prepare("SELECT COUNT(*) AS n FROM command_center_log WHERE owner_id = ? AND source = 'backfill'").get(owner) as { n: number };
    let total = Number(counted.n);
    const exists = db.prepare("SELECT 1 FROM command_center_log WHERE owner_id = ? AND entry_id = ?");
    for (const e of checked) {
      const entryId = ccEntryId("backfill", e.id);
      if (exists.get(owner, entryId)) {
        out.duplicate += 1;
        continue;
      }
      if (total >= CC_BACKFILL_MAX_PER_PERSON) {
        out.refused.push({ index: e.index, id: e.id, reason: `Command Center keeps at most ${CC_BACKFILL_MAX_PER_PERSON} backfilled entries per person; this one was not stored` });
        continue;
      }
      let initiative = e.initiative;
      let title: string;
      let key: string | null;
      const known = records.get(initiative);
      if (known) {
        title = known.title;
        key = known.key;
      } else if (initiative === UNASSIGNED) {
        title = "Unassigned";
        key = e.key;
      } else if (CC_RESERVED_IDS.includes(initiative)) {
        out.refused.push({ index: e.index, id: e.id, reason: `entries[${e.index}].initiative '${initiative}' is reserved; pick another id` });
        continue;
      } else if (e.title && out.created.length + out.syncCreated >= CC_BACKFILL_MAX_CREATED) {
        out.reassigned.push({ index: e.index, id: e.id, reason: `initiative '${initiative}' was not created: one upload creates at most ${CC_BACKFILL_MAX_CREATED} initiatives` });
        initiative = UNASSIGNED;
        title = "Unassigned";
        key = e.key;
      } else if (e.title) {
        const rec: CcRecord = {
          v: 1,
          id: initiative,
          title: e.title,
          area: null,
          key: e.key,
          state: "parked",
          kind: "project",
          cadence: null,
          deadline: null,
          priority: null,
          tasks: [],
          questions: [],
          health: null,
          links: [],
          source: null,
          updatedAt: iso(now),
          seq: 1,
          publishedBy: "backfill",
          writers: [],
        };
        try {
          assertFits(owner, rec, null);
          // records was read in this transaction, so the id is absent; never overwrite one anyway.
          if (!insertRecordIfAbsent(owner, rec)) throw new ApiError(`initiative '${initiative}' already exists`, 409);
          records.set(rec.id, rec);
          out.created.push(rec.id);
          title = rec.title;
          key = rec.key;
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          out.reassigned.push({ index: e.index, id: e.id, reason: `initiative '${initiative}' could not be created: ${err.message}` });
          initiative = UNASSIGNED;
          title = "Unassigned";
          key = e.key;
        }
      } else {
        out.reassigned.push({ index: e.index, id: e.id, reason: `no initiative '${initiative}' and no title to create it` });
        initiative = UNASSIGNED;
        title = "Unassigned";
        key = e.key;
      }
      const n = writeLog(owner, [
        { id: entryId, initiative, title, key, kind: "worked", text: e.worked, size: e.size, session: e.session, machine: e.machine, source: "backfill", at: e.at },
      ]);
      if (n) {
        out.accepted += 1;
        total += 1;
      } else out.duplicate += 1;
    }
    audit(db, owner, "cc_backfill", "command_center", "-", via, {
      details: {
        accepted: out.accepted,
        duplicate: out.duplicate,
        refused: out.refused.length,
        created: out.created.length,
        reassigned: out.reassigned.length,
        syncCreated: out.syncCreated,
        syncSkipped: out.syncSkipped,
        syncRefused: out.syncRefused.length,
      },
    });
  });
  out.refused.sort((a, b) => a.index - b.index);
  return out;
}

// ---------------------------------------------------------------------------
// The page's own operations: the SSO viewer only (getViewer), never an agent.
// ---------------------------------------------------------------------------

export interface CcExportGrant {
  app: string;
  level: CcExportLevel;
  grantedAt: string;
}

export interface CcView {
  /** On the page, active initiatives that are not silent, in page order: needs you, active, idle, finished, then priority, then newest. */
  records: (CcRecord & CcFlags & { status: CcStatus; questionViews: CcQuestionView[]; log: CcLogEntry[] })[];
  /** Done, parked and silent initiatives: off the page, still in the log. */
  offPage: number;
  needsYou: { initiative: CcRecord; question: CcQuestionView }[];
  dataHealth: CcDataHealth;
  lastPush: string | null;
  /** The configured export apps and what this person granted each. */
  exportApps: { app: string; grant: CcExportGrant | null }[];
  /** Changes whenever anything the page shows changes; the page polls it. */
  stamp: string;
}

export function ccGrantsOf(ownerId: string): CcExportGrant[] {
  const rows = getDb().prepare("SELECT app, level, granted_at AS grantedAt FROM command_center_export_grants WHERE owner_id = ? ORDER BY app").all(ownerId) as unknown as CcExportGrant[];
  return rows.map((r) => ({ app: r.app, level: r.level, grantedAt: r.grantedAt }));
}

export function ccView(ownerId: string, now: number = Date.now()): CcView {
  ready(now);
  const all = sortRecords([...loadRecords(ownerId).values()]);
  for (const r of all) pruneQuestions(r, now);
  const shown = all.filter((r) => onPage(r, now));
  const records = shown
    .map((r) => {
      const flags = flagsOf(r, now);
      return {
        ...r,
        ...flags,
        status: ccStatusOf(r, flags, now),
        questionViews: r.questions.map((q) => ({ ...q, stale: questionStale(r, q, now) })),
        // Paused hides its questions, in the log too.
        log: ccRecentLog(ownerId, r.id).filter((e) => r.priority !== "paused" || !e.kind.startsWith("question")),
      };
    })
    // Projects: needs you, active, idle, finished; within each, the sortRecords order (priority,
    // then newest). Stable. Recurring upkeep keeps the sortRecords order, after the projects.
    .sort((a, b) => rank(a) - rank(b));
  const statusOf = new Map(records.map((r) => [r.id, r.status]));
  const needsYou = records
    .filter((r) => r.priority !== "paused")
    .flatMap((r) => r.questionViews.filter((q) => !q.clearedAt).map((question) => ({ initiative: r as CcRecord, question })))
    .sort((a, b) => a.question.askedAt.localeCompare(b.question.askedAt));
  const lastPush = all.reduce<string | null>((m, r) => (m === null || r.updatedAt > m ? r.updatedAt : m), null);
  const exportApps = exportAppsOf(ownerId);
  const logStamp = getDb().prepare("SELECT COUNT(*) AS n, MAX(at) AS m FROM command_center_log WHERE owner_id = ?").get(ownerId) as { n: number; m: string | null };
  const stamp = [
    `log:${logStamp.n}:${logStamp.m ?? ""}`,
    ...exportApps.map((a) => `${a.app}:${a.grant?.level ?? "-"}`),
    // The status rides along so a card crossing the 2 h active line refreshes the page.
    ...all.map((r) => `${r.id}:${r.seq}:${r.questions.filter((q) => !q.clearedAt).length}:${onPage(r, now) ? 1 : 0}:${statusOf.get(r.id) ?? "-"}`),
  ].join("|");
  return {
    records,
    offPage: all.length - shown.length,
    needsYou,
    dataHealth: dataHealthOf(all, now),
    lastPush,
    exportApps,
    stamp,
  };
}

/** delete_all: every record, log entry, export grant and backfill link of the caller, at once. */
export function ccDeleteAll(ownerId: string, via: AuditVia = "mcp"): { deleted: number; entries: number } {
  const gone = inTransaction(getDb(), () => {
    auditCc(ownerId, "delete_all", ownerId, "deleted", via);
    return deleteEverything(ownerId);
  });
  return { deleted: gone.records, entries: gone.entries };
}

// ---------------------------------------------------------------------------
// Export: the person's own download, and export apps the person granted.
// ---------------------------------------------------------------------------

/**
 * export: the caller's own log, every entry, and the configured export apps with what the caller
 * granted each. Audited.
 */
export function ccExportOwn(
  ownerId: string,
  via: AuditVia = "mcp",
  now: number = Date.now(),
): { exportedAt: string; person: string; entries: CcLogEntry[]; exportApps: { app: string; grant: CcExportGrant | null }[] } {
  if (!config().commandCenter) throw new NotFoundError("Command Center is switched off on this BAB");
  ready(now);
  auditCc(ownerId, "export_own", ownerId, "exported", via);
  return { exportedAt: iso(now), person: ownerId, entries: ccLogOf(ownerId), exportApps: exportAppsOf(ownerId) };
}

/** The configured export apps and what this person granted each, by app name. */
function exportAppsOf(ownerId: string): { app: string; grant: CcExportGrant | null }[] {
  const grants = new Map(ccGrantsOf(ownerId).map((g) => [g.app, g]));
  return [...config().commandCenterExportApps.keys()].sort().map((app) => ({ app, grant: grants.get(app) ?? null }));
}

/** grant_export: the caller grants (or changes) one configured export app. Audited. */
export function ccGrantExport(ownerId: string, appRaw: unknown, levelRaw: unknown, via: AuditVia = "mcp", now: number = Date.now()): CcExportGrant {
  const app = slug(appRaw, "app");
  if (!config().commandCenterExportApps.has(app)) throw new NotFoundError(`No export app '${app}' on this BAB`);
  const level = levelRaw == null || levelRaw === "" ? "aggregate" : oneOf(levelRaw, CC_EXPORT_LEVELS, "level");
  const at = iso(now);
  inTransaction(getDb(), () => {
    auditCc(ownerId, "export_grant", app, level, via);
    getDb()
      .prepare(
        `INSERT INTO command_center_export_grants (owner_id, app, level, granted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner_id, app) DO UPDATE SET level = excluded.level, granted_at = excluded.granted_at`,
      )
      .run(ownerId, app, level, at);
  });
  return { app, level, grantedAt: at };
}

/** revoke_export: the caller revokes one export app. Audited, also when there was nothing to revoke. */
export function ccRevokeExport(ownerId: string, appRaw: unknown, via: AuditVia = "mcp"): { revoked: boolean } {
  const app = slug(appRaw, "app");
  return inTransaction(getDb(), () => {
    const n = Number(getDb().prepare("DELETE FROM command_center_export_grants WHERE owner_id = ? AND app = ?").run(ownerId, app).changes);
    auditCc(ownerId, "export_revoke", app, n ? "revoked" : "none", via);
    return { revoked: n > 0 };
  });
}

/** The export app a bearer token belongs to, compared in constant time over every app. */
export function exportAppFor(presented: string | null, compare: (a: string, b: string) => boolean): string | null {
  if (!presented) return null;
  let found: string | null = null;
  for (const [app, token] of config().commandCenterExportApps) if (compare(presented, token)) found = app;
  return found;
}

export interface CcAggregateRow {
  initiative: string;
  title: string | null;
  key: string | null;
  day: string;
  entries: number;
  worked: number;
  /** Entries that came from a backfill upload (source "backfill"), not from a live publish. */
  backfilled: number;
  sizes: Record<CcSize, number>;
}

export interface CcAppExport {
  app: string;
  from: string;
  to: string;
  exportedAt: string;
  people: { person: string; level: CcExportLevel; rows?: CcAggregateRow[]; entries?: CcLogEntry[] }[];
}

/**
 * Counts per initiative and day, with the initiative's title and key: no worked lines, no session.
 * `entries` counts every log entry; `worked` only the agents' worked lines (not imported notes);
 * `backfilled` the entries that came from a backfill upload.
 */
export function aggregate(entries: CcLogEntry[]): CcAggregateRow[] {
  const rows = new Map<string, CcAggregateRow>();
  for (const e of entries) {
    const day = e.at.slice(0, 10);
    const k = `${e.initiative}\u0000${day}`;
    let row = rows.get(k);
    if (!row) {
      row = { initiative: e.initiative, title: e.title, key: e.key, day, entries: 0, worked: 0, backfilled: 0, sizes: { small: 0, medium: 0, large: 0 } };
      rows.set(k, row);
    }
    row.entries += 1;
    if (e.kind === "worked") row.worked += 1;
    if (e.source === "backfill") row.backfilled += 1;
    if (e.size) row.sizes[e.size] += 1;
    if (e.title) row.title = e.title;
    if (e.key) row.key = e.key;
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.initiative.localeCompare(b.initiative));
}

/**
 * GET /api/command-center/export for an export app: only people who granted this app (their agent
 * called grant_export at their ask). Aggregated, unless the person allowed entries and the app asks for
 * them (`detail=entries`). Range [from, to) in whole UTC days, at most 400 days. Audited per call.
 */
export function ccExportForApp(app: string, query: { from?: string | null; to?: string | null; detail?: string | null }, now: number = Date.now()): CcAppExport {
  if (!config().commandCenter) throw new NotFoundError("Command Center is switched off on this BAB");
  const day = (raw: string | null | undefined, field: string, fallback: string): string => {
    if (raw == null || raw === "") return fallback;
    if (!validDate(raw)) throw new ValidationError(`${field} must be a date YYYY-MM-DD`);
    return raw;
  };
  const to = day(query.to, "to", iso(now + DAY_MS).slice(0, 10));
  const from = day(query.from, "from", iso(Date.parse(`${to}T00:00:00Z`) - 92 * DAY_MS).slice(0, 10));
  if (from >= to) throw new ValidationError("from must be before to");
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 400 * DAY_MS) throw new ValidationError("from and to may be at most 400 days apart");
  const detail = query.detail == null || query.detail === "" ? "aggregate" : oneOf(query.detail, CC_EXPORT_LEVELS, "detail");
  ready(now);
  const grants = getDb()
    .prepare(
      `SELECT g.owner_id AS owner, g.level AS level FROM command_center_export_grants g JOIN users u ON u.id = g.owner_id
       WHERE g.app = ? ORDER BY g.owner_id`,
    )
    .all(app) as { owner: string; level: CcExportLevel }[];
  const people = grants.map((g) => {
    const entries = ccLogOf(g.owner, { from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z` });
    if (detail === "entries" && g.level === "entries") return { person: g.owner, level: g.level, entries };
    return { person: g.owner, level: g.level, rows: aggregate(entries) };
  });
  // "mcp" is the via every non-browser REST route records (AuditVia has only "ui" and "mcp").
  audit(getDb(), `app:${app}`, "cc_export_app", "command_center", app, "mcp", { details: { people: people.length, detail, from, to } });
  return { app, from, to, exportedAt: iso(now), people };
}
