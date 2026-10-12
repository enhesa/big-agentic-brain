import { randomUUID } from "node:crypto";
import { getDb, inTransaction } from "./db";
import { audit } from "./audit";
import { emit } from "./events";
import { redact, assertMaxLength, assertRawLength } from "./redact";
import { config } from "./config";
import { toCalendarDate, todayUtc, parseDbTime } from "./dates";
import { NotFoundError, ForbiddenError, ValidationError, ConflictError } from "./errors";
import { carryOver, computeStanding } from "./standing";
import type { Standing, StandingLevel } from "./standing";
import { isMaintainer, maintainerIdList } from "./feedback";
import { appliesToFields, appliesToFilterSql, mergeAppliesTo, parseAppliesTo, readAppliesTo, stackRankSql } from "./applies-to";
import { downvotedLive, verifyDueIds } from "./swarm-gc";
import { normalizeProjectKey, deriveProjectFromRepo, projectKeyFromCwd, GENERAL_PROJECT_KEY } from "./project-key";
export { normalizeProjectKey, GENERAL_PROJECT_KEY } from "./project-key";
import {
  normalizeTokens,
  jaccard,
  similarityScore,
  quoteFtsToken,
  DUPLICATE_THRESHOLD,
  SIMILAR_THRESHOLD,
} from "./similarity";
import type {
  AuditVia,
  LearningConfidence,
  LearningKind,
  LearningRow,
  LearningSource,
  LearningStatus,
} from "./types";

const TITLE_MAX = 160;
const BODY_MAX = 8000;
const TAGS_MAX = 10;
const TAG_MAX = 40;
const REPO_MAX = 120;
export const MODEL_MAX = 64;
const MODEL_RE = /^[a-z0-9.-]+$/;
/** Whatever survives normalization: lowercase letters, digits, dot, hyphen. */
const FLAG_THRESHOLD = 2;
/**
 * How long a memory can go without an agent reading it before the hourly sweep archives it
 * (sweepInactive in lib/maintenance.ts, docs/spec.md "Garbage collection"). Archived is reversible:
 * any agent can restore it with bab_react keep.
 */
export const INACTIVITY_ARCHIVE_DAYS = 365;
/**
 * Reads were not recorded before this day (migration v40), so no memory's inactivity clock starts
 * earlier: nothing is archived for inactivity until INACTIVITY_ARCHIVE_DAYS after it. The same idea
 * as USAGE_COLLECTING_SINCE in lib/usage.ts. A UTC calendar day.
 */
export const INACTIVITY_CLOCK_START = "2026-10-07";
/** Max `limit` for a plain (unfiltered/tag/repo/author) learnings list. */
export const LEARNINGS_LIST_LIMIT_MAX = 50;
/** Max `limit` for a full-text learnings search (snippets are heavier). */
export const LEARNINGS_SEARCH_LIMIT_MAX = 20;
/** Tag-overlap floor for the tag-only findSimilar fallback (no usable title/body tokens). */
const TAG_ONLY_SIMILAR_THRESHOLD = 0.5;

export const LEARNING_KINDS: readonly LearningKind[] = ["learning", "practice", "standard", "decision"];
export const LEARNING_SOURCES: readonly LearningSource[] = ["native", "confluence"];
export const SOURCE_URL_MAX = 300;
/** Cap on the raw text handed to `new URL`, so a huge string is refused before it is parsed. */
const SOURCE_URL_RAW_MAX = 2000;

/**
 * A model id as the author declares it (honour system, owner 2026-10-02: no server check that it
 * is true): trimmed, lowercased, letters, digits, dot and dash only, 64 characters at most.
 * Absent, null or blank is null (not an error: the field is optional). Anything else that is not
 * a short id is refused loudly, never silently trimmed to something else. One normaliser for
 * the write (create) and the filter (parseModelFilter), so a stored value and a filter for it
 * always spell the same.
 */
export function normalizeModel(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ValidationError("model must be a string");
  if (raw.length > MODEL_MAX * 4) throw new ValidationError(`model must be ${MODEL_MAX} characters or fewer`);
  const model = raw.trim().toLowerCase();
  if (!model) return null;
  if (model.length > MODEL_MAX || !MODEL_RE.test(model)) {
    throw new ValidationError(
      `model must be a short model id (lowercase letters, digits, dot, dash; ${MODEL_MAX} characters or fewer), for example claude-opus-5-5`,
    );
  }
  return model;
}

/** The `model` search filter, for every surface: blank or absent is no filter; a bad id is refused. */
export function parseModelFilter(raw: unknown): string | undefined {
  return normalizeModel(raw) ?? undefined;
}

export function parseKind(raw: unknown): LearningKind {
  if (typeof raw === "string" && (LEARNING_KINDS as readonly string[]).includes(raw)) return raw as LearningKind;
  throw new ValidationError(`kind must be one of ${LEARNING_KINDS.join(", ")}`);
}

function parseSource(raw: unknown): LearningSource {
  if (typeof raw === "string" && (LEARNING_SOURCES as readonly string[]).includes(raw)) return raw as LearningSource;
  throw new ValidationError(`source must be one of ${LEARNING_SOURCES.join(", ")}`);
}

/**
 * Returns the normalized href, which is what gets stored: the string that was validated is the
 * string that is rendered. Checking the parsed URL (not the raw text) is what rejects userinfo,
 * lookalike hosts, ports and `..` segments that a prefix check on the text would let through.
 */
export function assertSourceUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("source_url must be a string");
  if (raw.length > SOURCE_URL_RAW_MAX) {
    throw new ValidationError(`source_url must be ${SOURCE_URL_MAX} characters or fewer`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("source_url is not a valid URL");
  }
  // A stored link is rendered as an <a>, so the host is allow-listed when BAB_SOURCE_HOSTS is set.
  // The /wiki/ path is Confluence-specific: required only with a configured allow-list.
  const hosts = config().sourceHosts;
  if (
    url.protocol !== "https:" ||
    (hosts !== null && (!hosts.includes(url.hostname) || !url.pathname.startsWith("/wiki/"))) ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== ""
  ) {
    throw new ValidationError(
      hosts === null
        ? "source_url must be an https link"
        : `source_url must be an https link on one of: ${hosts.join(", ")}`,
    );
  }
  // The 300 cap is on the stored href (what gets rendered), not on the raw text: the raw cap
  // above only bounds the parser's input and is looser on purpose, because normalising can
  // shorten a link (default port, dot segments).
  if (url.href.length > SOURCE_URL_MAX) {
    throw new ValidationError(`source_url must be ${SOURCE_URL_MAX} characters or fewer`);
  }
  return url.href;
}

export function resolveProvenance(i: {
  source?: LearningSource;
  sourceUrl?: string | null;
  sourceVersion?: number | null;
}): { source: LearningSource; sourceUrl: string | null; sourceVersion: number | null } {
  const source = i.source === undefined ? "native" : parseSource(i.source);
  const hasUrl = i.sourceUrl !== undefined && i.sourceUrl !== null;
  const hasVersion = i.sourceVersion !== undefined && i.sourceVersion !== null;
  if (source === "native") {
    if (hasUrl || hasVersion) {
      throw new ValidationError("source_url and source_version need source confluence");
    }
    return { source, sourceUrl: null, sourceVersion: null };
  }
  const sourceUrl = assertSourceUrl(i.sourceUrl);
  const v = i.sourceVersion;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
    throw new ValidationError("source_version must be an integer of 1 or more (the Confluence version number)");
  }
  return { source, sourceUrl, sourceVersion: v };
}

/**
 * One parser for both write surfaces (bab_learn, POST /api/learnings), so MCP and REST cannot
 * drift on spelling or types. Values pass through as sent and are validated by create(); this
 * only maps the wire names (snake_case, like the stored columns) to the input names, and
 * refuses the camelCase spelling loudly: ignoring `sourceUrl` would silently store a native
 * entry, which is the opposite of what the caller meant.
 */
export function readProvenance(raw: Record<string, unknown>): {
  kind?: LearningKind;
  source?: LearningSource;
  sourceUrl?: string | null;
  sourceVersion?: number | null;
} {
  if (raw.sourceUrl !== undefined) throw new ValidationError("use source_url, not sourceUrl");
  if (raw.sourceVersion !== undefined) throw new ValidationError("use source_version, not sourceVersion");
  // null means "not given", like a missing key: a client that serialises absent fields as null
  // must not turn a correction of a mirror into a native entry (or a 400 on kind).
  return {
    kind: (raw.kind ?? undefined) as LearningKind | undefined,
    source: (raw.source ?? undefined) as LearningSource | undefined,
    sourceUrl: (raw.source_url ?? undefined) as string | undefined,
    sourceVersion: (raw.source_version ?? undefined) as number | undefined,
  };
}

export interface CreateLearningInput {
  authorId: string;
  title: string;
  body: string;
  tags?: string[];
  repo?: string | null;
  /**
   * General-purpose scope: a repo, client, campaign, product or system.
   * Normalized via normalizeProjectKey(); when absent, auto-filled from
   * `repo` (see deriveProjectFromRepo()) so the two fields never disagree.
   */
  project?: string | null;
  confidence?: LearningConfidence;
  /**
   * YYYY-MM-DD: the last day a time-bound fact is valid (a campaign, a freeze); the sweep archives
   * the memory the day after. Omit or null for none: memories do not expire by default (owner,
   * 2026-10-07), they are archived only after INACTIVITY_ARCHIVE_DAYS without an agent read.
   */
  expiresAt?: string | null;
  supersedesId?: string | null;
  /** Bypasses the findSimilar duplicate check on create() (caller confirmed it's genuinely different). */
  confirmNotDuplicate?: boolean;
  /** Omit for a plain learning. */
  kind?: LearningKind;
  /** Omit for native. A confluence mirror needs sourceUrl and sourceVersion; native refuses both. */
  source?: LearningSource;
  sourceUrl?: string | null;
  sourceVersion?: number | null;
  /**
   * The model id the author declares (self-declared, honour system); normalized by
   * normalizeModel(). Omit or null for none. Never an input to standing or confidence.
   */
  model?: string | null;
  /**
   * Stack or platform labels the memory holds for; validated and normalised by create() with
   * parseAppliesTo() (lib/applies-to.ts), so a bad label is a 400. Omit for "like the memory this
   * corrects, else everywhere"; null or [] for everywhere on purpose.
   */
  appliesTo?: string[] | string | null;
}

export interface LearningSearchResult extends LearningRow, AgeInfo {
  /** The memory's applies-to labels (empty: everywhere), and, when a `stack` was passed that they do not match, a mismatch flag and hint. */
  appliesTo: string[];
  stackMismatch?: true;
  stackHint?: string;
  snippet: string;
  authorName: string | null;
  /** Derived from the votes on read (lib/standing.ts); never stored, never ranks the search. */
  standing: StandingLevel;
  standingReason: string;
  /** id of the learning that supersedes this one, if any. */
  supersededBy?: string;
  /** The latest retire or restore of this memory (who, when, why), if there is one. */
  lastRetire?: RetireEvent;
  /**
   * true on a live memory that is over 90 days old with no confirm or keep in the last 90 days
   * (lib/swarm-gc.ts verifyDueIds): whoever uses it checks it first. Absent otherwise.
   */
  verify?: true;
}

export interface AgeInfo {
  /** Whole days since created_at. */
  ageDays: number;
  /** Whole days until expires_at; negative once past, null if the memory never expires. */
  expiresInDays: number | null;
}

/**
 * Surfaced on every read path (search, GET /api/learnings, bab_search, the /memory
 * pages) so an agent citing an old memory can say so — the colleague complaint this
 * answers: "today it's this architecture, tomorrow it's not, but you wouldn't actually
 * know." `now` is injectable for deterministic tests.
 */
export function ageInfo(
  l: Pick<LearningRow, "created_at" | "expires_at">,
  now: number = Date.now(),
): AgeInfo {
  const createdMs = parseDbTime(l.created_at).getTime();
  const ageDays = Math.max(0, Math.floor((now - createdMs) / 86_400_000));

  let expiresInDays: number | null = null;
  if (l.expires_at) {
    const today = new Date(now).toISOString().slice(0, 10);
    const expiresOn = toCalendarDate(l.expires_at);
    const diffMs = Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
    expiresInDays = Math.round(diffMs / 86_400_000);
  }
  return { ageDays, expiresInDays };
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  return tags
    .map((t) => redact(t.trim().toLowerCase()))
    .filter(Boolean)
    .map((t) => {
      assertMaxLength("tag", t, TAG_MAX);
      return t;
    })
    .slice(0, TAGS_MAX);
}

function normalizeRepo(repo: string | null | undefined): string | null {
  if (repo == null) return null;
  const trimmed = redact(repo.trim());
  if (!trimmed) return null;
  assertMaxLength("repo", trimmed, REPO_MAX);
  return trimmed;
}

/**
 * Normalizes a free-text `project` value into a stable filter key: trimmed,
 * lowercased, inner whitespace/underscores collapsed to a single hyphen,
 * anything outside `[a-z0-9.-]` stripped, capped at 80 chars — so
 * "Q4 ESG Campaign" -> "q4-esg-campaign" and "acme.export.api" stays as
 * is. A blank or absent value normalizes to `null` (no project set, not an
 * error). A value that had real content but strips down to nothing (e.g.
 * all punctuation) is rejected rather than silently dropped, since that
 * usually means the caller meant to set one.
 */

/**
 * Auto-fill from `repo` (docs/spec.md "Data model"): the last path segment
 * of a remote URL or "org/slug" string, a trailing `.git` stripped, then
 * run through normalizeProjectKey() — the same normaliser explicit
 * `project` values go through, so the two never disagree. Best-effort: a
 * repo string that normalizes to nothing just means no derived project,
 * never a thrown error (the `repo` field itself is validated separately).
 */

export function create(input: CreateLearningInput, via: AuditVia = "ui"): LearningRow {
  const db = getDb();

  assertRawLength("title", input.title, TITLE_MAX);
  assertRawLength("body", input.body, BODY_MAX);
  const title = redact(input.title.trim());
  const body = redact(input.body.trim());
  assertMaxLength("title", title, TITLE_MAX);
  assertMaxLength("body", body, BODY_MAX);

  const tags = normalizeTags(input.tags);
  const repo = normalizeRepo(input.repo);
  // An EXPLICIT null means "company-wide, on purpose": a guardrail or best practice
  // written while sitting in a repo must not inherit that repo as its scope. Only an
  // absent project falls back to the repo (owner, 2026-09-18).
  // `_general` is the read-side spelling of "no project" (bab_search, GET /api/learnings);
  // on a write it must mean null too, not the key "general".
  const project =
    input.project === null || input.project === GENERAL_PROJECT_KEY
      ? null
      : normalizeProjectKey(input.project) ?? (repo ? deriveProjectFromRepo(repo) : null);
  const id = randomUUID();
  // A bogus supersedes id must not silently skip the dedup guard below: validate
  // it exists (and isn't deleted) before anything else, whether the route already
  // checked or not.
  let target: LearningRow | undefined;
  if (input.supersedesId) {
    target = getById(input.supersedesId);
    if (!target || target.status === "deleted") {
      throw new NotFoundError("Learning to supersede was not found");
    }
  }

  // Validated before the dedup check so a bad input fails without leaving an audit row behind.
  // A correction keeps what it replaces unless told otherwise: kind on its own, the source
  // triple only when the caller passed none of its three fields (a half-given triple would
  // otherwise mix the old url with a new version).
  const kind =
    input.kind !== undefined ? parseKind(input.kind) : target ? target.kind : "learning";
  // A correction does not inherit the model: it records who wrote THIS entry.
  const model = normalizeModel(input.model);
  // A correction keeps the applies-to labels of what it replaces unless given (an empty list is given).
  const appliesTo = parseAppliesTo(input.appliesTo) ?? (target ? readAppliesTo(target.applies_to) : []);
  const provenance = resolveProvenance(
    target && input.source == null && input.sourceUrl == null && input.sourceVersion == null
      ? { source: target.source, sourceUrl: target.source_url, sourceVersion: target.source_version }
      : input,
  );

  // Dedup at write time (docs/spec.md "Garbage collection"): skip when this
  // create is itself a correction (supersedes is set) or the caller already
  // confirmed, after seeing the candidates, that it is genuinely different.
  let overriddenCandidateIds: string[] = [];
  if (!input.supersedesId) {
    const duplicates = findSimilar({ title, body, tags, repo, project }, { limit: 5 }).filter(
      (m) => m.verdict === "duplicate",
    );
    if (duplicates.length > 0) {
      if (input.confirmNotDuplicate === true) {
        overriddenCandidateIds = duplicates.map((d) => d.id);
      } else {
        audit(db, input.authorId, "create_rejected_duplicate", "learning", id, via, {
          details: { candidateIds: duplicates.map((d) => d.id) },
        });
        throw new ConflictError("Looks like a duplicate", duplicates);
      }
    }
  }

  // Memories do not expire by default (owner, 2026-10-07): omitted and null both mean no date. A date
  // is the author's own "valid until" for a time-bound fact; the sweep archives the memory once it
  // has passed (sweepExpiry in lib/maintenance.ts). Unread memories are archived separately, after
  // INACTIVITY_ARCHIVE_DAYS without an agent read (sweepInactive).
  const expiresAt = input.expiresAt ?? null;

  db.prepare(
    `INSERT INTO learnings
       (id, author_id, title, body, tags, repo, project, confidence, status, expires_at, expires_explicit,
        supersedes_id, kind, source, source_url, source_version, model, applies_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.authorId,
    title,
    body,
    JSON.stringify(tags),
    repo,
    project,
    input.confidence ?? "medium",
    expiresAt,
    // 1 marks a date the author chose: migration v40 reads it, so it stays true to its meaning.
    expiresAt == null ? 0 : 1,
    input.supersedesId ?? null,
    kind,
    provenance.source,
    provenance.sourceUrl,
    provenance.sourceVersion,
    model,
    JSON.stringify(appliesTo),
  );

  audit(db, input.authorId, "create", "learning", id, via);

  // Reclassifying a house rule as a practice or standard goes through a correction, so the
  // change is recorded: only part of the old entry's standing carries over (carryOver in
  // lib/standing.ts), and who changed the kind should be findable.
  if (target && kind !== target.kind) {
    audit(db, input.authorId, "kind_change", "learning", id, via, {
      details: { from: target.kind, to: kind, supersedes: target.id },
    });
  }

  if (overriddenCandidateIds.length > 0) {
    audit(
      db,
      input.authorId,
      "create_confirmed_not_duplicate",
      "learning",
      id,
      via,
      { details: { overriddenCandidateIds } },
    );
  }

  const created = getById(id)!;
  emit("learning.created", id, { id, title, kind: created.confidence });
  return created;
}

export function getById(id: string): LearningRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM learnings WHERE id = ?").get(id) as unknown as | LearningRow
    | undefined;
}

/** The learning (if any) whose supersedes_id points at this one. */
export function findSupersededBy(id: string): LearningRow | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT l.* FROM supersession_links s JOIN learnings l ON l.id = s.new_id WHERE s.old_id = ?`,
    )
    .get(id) as unknown as LearningRow | undefined;
}

export interface ListFilters {
  /**
   * Omitted => active only (the default a human or agent browsing wants).
   * "all" => every status including archived and deleted. Any explicit status
   * (including "archived") filters to exactly that status.
   */
  status?: LearningStatus | "all";
  tag?: string;
  repo?: string;
  author?: string;
  /** Exact match on the normalized project key (see normalizeProjectKey()). */
  project?: string;
  /** Any of these kinds. Omitted or empty means all kinds. */
  kind?: LearningKind[];
  /** Exact match on the stored model id (normalize with parseModelFilter()). Omitted means any model, including none. */
  model?: string;
  /** Only memories carrying one of these labels, or "everywhere" for those with none (parseAppliesToFilter). */
  appliesTo?: string[];
  /**
   * The caller's stack (parseStack): memories that apply everywhere or share a label are ranked first,
   * the rest after, and the search flags them (stackMismatch). Ranking only, never a filter.
   */
  stack?: string[];
  /**
   * Only the flagged standards and decisions that wait for a maintainer: exactly the set the
   * maintainer nudge counts (flaggedStandardsWaitingIds), so the count and the search agree.
   */
  flagged?: boolean;
}

/** The values a `status` filter takes. The old `expiring` status is gone, so it is refused, not read as "no matches". */
export const STATUS_FILTER_VALUES = ["active", "archived", "deleted", "all"] as const;

/**
 * Parses a `status` filter from an agent (bab_search, GET /api/learnings). Omitted or empty means the
 * default (active). Anything else that is not a status is an error: an agent still following an old
 * instruction (`status: expiring`) must be told, not shown an empty page.
 */
export function parseStatusFilter(raw: unknown): LearningStatus | "all" | undefined {
  if (raw == null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (value === "") return undefined;
  if ((STATUS_FILTER_VALUES as readonly string[]).includes(value)) return value as LearningStatus | "all";
  throw new ValidationError(
    `status must be one of ${STATUS_FILTER_VALUES.join(", ")} (memories no longer expire, so there is no expiring status)`,
  );
}

/** `flagged`, parsed for every surface: true or "true"/"1" filters; absent, "", false, "false" and "0" do not. Anything else is refused. */
export function parseFlaggedFilter(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === "" || raw === false) return undefined;
  if (raw === true) return true;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "true" || v === "1") return true;
    if (v === "false" || v === "0") return undefined;
  }
  throw new ValidationError("flagged must be true or false");
}

function applyFlaggedClause(
  clauses: string[],
  params: (string | number)[],
  flagged: boolean | undefined,
  columnPrefix = "",
) {
  if (!flagged) return;
  const ids = flaggedStandardsWaitingIds();
  if (ids.length === 0) {
    clauses.push("0");
    return;
  }
  clauses.push(`${columnPrefix}id IN (${ids.map(() => "?").join(",")})`);
  params.push(...ids);
}

/**
 * One parser for every surface: undefined, null or "" is no filter; a string is one kind or a
 * comma list (REST); an array is a list of kinds (MCP). Anything else, including an empty
 * element like "standard,", is refused. A typo must never read as "unfiltered", or a search
 * for standards would quietly return ordinary learnings.
 */
export function parseKindFilter(raw: unknown): LearningKind[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").map((p) => p.trim()) : null;
  if (parts === null) throw new ValidationError(`kind must be a string or a list of: ${LEARNING_KINDS.join(", ")}`);
  if (parts.length === 0) return undefined;
  return [...new Set(parts.map((p) => parseKind(p)))];
}

function applyKindClause(
  clauses: string[],
  params: (string | number)[],
  kind: LearningKind[] | undefined,
  columnPrefix = "",
) {
  if (!kind || kind.length === 0) return;
  if (kind.length === 1) {
    clauses.push(`${columnPrefix}kind = ?`);
  } else {
    clauses.push(`${columnPrefix}kind IN (${kind.map(() => "?").join(",")})`);
  }
  params.push(...kind);
}

function applyStatusClause(
  clauses: string[],
  params: (string | number)[],
  status: ListFilters["status"],
  columnPrefix = "",
) {
  if (!status) {
    clauses.push(`${columnPrefix}status = 'active'`);
  } else if (status !== "all") {
    clauses.push(`${columnPrefix}status = ?`);
    params.push(status);
  }
  // status === "all": no clause, every status included.
}

/**
 * `project` is either a normalized key (exact match) or the reserved
 * GENERAL_PROJECT_KEY sentinel meaning "no project set" (IS NULL, not a
 * bound param — a stored project is never literally the sentinel string).
 */
function applyProjectClause(
  clauses: string[],
  params: (string | number)[],
  project: string | undefined,
  columnPrefix = "",
) {
  if (!project) return;
  if (project === GENERAL_PROJECT_KEY) {
    clauses.push(`${columnPrefix}project IS NULL`);
  } else {
    clauses.push(`${columnPrefix}project = ?`);
    params.push(project);
  }
}

function applyModelClause(
  clauses: string[],
  params: (string | number)[],
  model: string | undefined,
  columnPrefix = "",
) {
  if (!model) return;
  clauses.push(`${columnPrefix}model = ?`);
  params.push(model);
}

function applyAppliesToClause(clauses: string[], appliesTo: string[] | undefined, columnPrefix = "") {
  if (appliesTo && appliesTo.length > 0) clauses.push(appliesToFilterSql(appliesTo, columnPrefix));
}

export function list(filters: ListFilters = {}): LearningRow[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  applyStatusClause(clauses, params, filters.status);
  if (filters.repo) {
    clauses.push("repo = ?");
    params.push(filters.repo);
  }
  if (filters.author) {
    clauses.push("author_id = ?");
    params.push(filters.author);
  }
  if (filters.tag) {
    clauses.push("tags LIKE ?");
    params.push(`%"${filters.tag}"%`);
  }
  applyProjectClause(clauses, params, filters.project);
  applyKindClause(clauses, params, filters.kind);
  applyModelClause(clauses, params, filters.model);
  applyAppliesToClause(clauses, filters.appliesTo);
  applyFlaggedClause(clauses, params, filters.flagged);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const stackRank = stackRankSql(filters.stack);
  return db
    .prepare(`SELECT * FROM learnings ${where} ORDER BY ${stackRank ? `${stackRank}, ` : ""}score DESC, created_at DESC`)
    .all(...params) as unknown as LearningRow[];
}

// Control characters used as FTS5 snippet() markers. They can't appear in the
// escaped HTML output by accident, so we escape first and only then turn them
// into <mark>/</mark> — the escape step never gets a chance to run *after* the
// tags are inserted, which is what made the old implementation vulnerable to
// stored XSS via learning bodies like "<img src=x onerror=alert(1)>".
const SNIPPET_MARK_START = "";
const SNIPPET_MARK_END = "";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pure helper: turns a raw FTS5 snippet (with control-char markers) into safe HTML. */
export function renderSnippetHtml(raw: string): string {
  return escapeHtml(raw)
    .split(SNIPPET_MARK_START)
    .join("<mark>")
    .split(SNIPPET_MARK_END)
    .join("</mark>");
}

/**
 * Turns a free-text query into a safe FTS5 MATCH expression: normalized,
 * stopword/short-token-filtered, then each remaining token individually
 * quoted (so raw FTS5 syntax like `*`, `"`, `NEAR`, `-`, `^`, unbalanced
 * parens, etc. can never reach MATCH unescaped and 500 the request). Tokens
 * stay space-joined, mirroring FTS5's implicit AND, so multi-word searches
 * keep their original all-terms-match behaviour.
 */
function buildFtsQuery(query: string): string {
  const tokens = normalizeTokens(query);
  return tokens.map(quoteFtsToken).join(" ");
}

/**
 * The same tokens joined with OR, used only when the all-terms query matched nothing.
 * A question typed as a sentence ("how do we size kafka messages") rarely has every
 * word present in one entry, and returning nothing sends the agent off to guess. Any
 * term matching is a far better answer than no answer, and the ranking above sorts the
 * partial matches sensibly, so the best of them still lands first.
 */
function buildFtsAnyQuery(query: string): string {
  const tokens = normalizeTokens(query);
  if (tokens.length < 2) return "";
  return Array.from(new Set(tokens)).map(quoteFtsToken).join(" OR ");
}

// Search ranking. Until now search ordered by vote score alone and ignored how well a
// row actually matched, so a perfect title hit with no votes lost to a passing body
// mention with two upvotes. Relevance now leads, with votes and recency as multipliers.
//
// bm25() returns a NEGATIVE number, more negative meaning a better match, so it is
// negated below. Its column weights follow the FTS table's column order
// (title, body, tags): a term in the title is worth far more than the same term buried
// in a body, and a tag hit sits between the two because tags are deliberate.
const BM25_TITLE_WEIGHT = 10.0;
const BM25_BODY_WEIGHT = 1.0;
const BM25_TAGS_WEIGHT = 5.0;

// The boosts MULTIPLY relevance, they do not add to it. Measured on a two-row corpus,
// bm25 came back around -1e-6: its magnitude depends on corpus statistics (IDF, average
// document length), so it is small and collection-dependent, and any fixed additive
// bonus simply swamps it. A first additive attempt let recency alone decide every
// search. Multiplying is scale-invariant: relevance keeps the ordering, the boosts only
// resolve rows that matched about as well as each other, and the balance does not drift
// as the corpus grows.
//
// Votes: a clamped +-, so one popular entry cannot follow the reader around. Kudos
// already count double inside `score`.
const VOTE_FACTOR_PER_POINT = 0.05;
const VOTE_SCORE_MIN = -5;
const VOTE_SCORE_MAX = 10;

// Recency: worth up to +50% for something written today, roughly halved at
// RECENCY_HALF_LIFE_DAYS and decaying more slowly after that, never dropping below 1.0.
// The curve is hyperbolic (C/(1+t/T)), not exponential, so at twice the half-life the
// bonus is a third of C rather than a quarter. Plain arithmetic rather than exp(),
// because SQLite's math functions are a compile-time option node:sqlite does not
// guarantee.
const RECENCY_FACTOR_MAX = 0.5;
const RECENCY_HALF_LIFE_DAYS = 90.0;

// COALESCE and the MAX(..., 0) floor are belt and braces, not live bugs: score is NOT
// NULL today and nothing writes a future created_at. Both matter because SQLite's
// scalar MIN/MAX propagate NULL, and a row whose age went negative enough would divide
// by ~0, NULL the whole product, and sort LAST under DESC. That is, a clock skew or a
// bad import would silently bury a perfect match rather than fail loudly.
const RANK_EXPRESSION = `(
  (-bm25(learnings_fts, ${BM25_TITLE_WEIGHT}, ${BM25_BODY_WEIGHT}, ${BM25_TAGS_WEIGHT}))
  * (1.0 + MIN(MAX(COALESCE(learnings.score, 0), ${VOTE_SCORE_MIN}), ${VOTE_SCORE_MAX}) * ${VOTE_FACTOR_PER_POINT})
  * (1.0 + ${RECENCY_FACTOR_MAX} / (1.0 + MAX(julianday('now') - julianday(learnings.created_at), 0) / ${RECENCY_HALF_LIFE_DAYS}))
)`;

/**
 * WHERE-clause fragments for the non-FTS filters (status/repo/author/tag/project),
 * shared between search()'s row query and searchTotal()'s count query so the two can
 * never drift apart on which rows they consider a match. Excludes the FTS MATCH clause
 * itself, which each caller adds with its own match expression.
 */
function searchFilterClauses(filters: ListFilters): { clauses: string[]; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  applyStatusClause(clauses, params, filters.status, "learnings.");
  if (filters.repo) {
    clauses.push("learnings.repo = ?");
    params.push(filters.repo);
  }
  if (filters.author) {
    clauses.push("learnings.author_id = ?");
    params.push(filters.author);
  }
  if (filters.tag) {
    clauses.push("learnings.tags LIKE ?");
    params.push(`%"${filters.tag}"%`);
  }
  applyProjectClause(clauses, params, filters.project, "learnings.");
  applyKindClause(clauses, params, filters.kind, "learnings.");
  applyModelClause(clauses, params, filters.model, "learnings.");
  applyAppliesToClause(clauses, filters.appliesTo, "learnings.");
  applyFlaggedClause(clauses, params, filters.flagged, "learnings.");
  return { clauses, params };
}

/**
 * Search via FTS5, returning ranked results with snippets. `offset` pages further into
 * the same result set (bab_search, lib/mcp.ts); the any-term widening below only ever
 * runs at offset 0 — at a later offset an empty page means "no more rows", not "widen
 * the query", so a page 2 request can't silently swap in a different, wider match set
 * than the page 1 the agent already saw (and than searchTotal() below already counted).
 */
export function search(
  query: string,
  filters: ListFilters = {},
  limit = 20,
  offset = 0,
): LearningSearchResult[] {
  const db = getDb();

  const ftsQuery = buildFtsQuery(query);

  if (!ftsQuery) {
    // Empty after sanitizing (blank query, or nothing but stopwords/operators/junk
    // like "*", "AND", "(" ) — fall back to the normal unfiltered list.
    const rows = list(filters).slice(offset, offset + limit);
    const authorNames = getAuthorNames(rows.map((r) => r.author_id));
    const supersededByIds = getSupersededByIds(rows.map((r) => r.id));
    const standings = standingsFor(rows);
    const retires = lastRetiresFor(rows);
    const verify = verifyDueIds(db, rows);
    return rows.map((r) => ({
      ...r,
      ...ageInfo(r),
      ...appliesToFields(r, filters.stack),
      snippet: escapeHtml(r.body.slice(0, 200)),
      authorName: authorNames.get(r.author_id) ?? null,
      supersededBy: supersededByIds.get(r.id),
      ...standingFields(standings.get(r.id)!),
      lastRetire: retires.get(r.id),
      ...(verify.has(r.id) ? { verify: true as const } : {}),
    }));
  }

  const { clauses: filterClauses, params: filterParams } = searchFilterClauses(filters);
  const clauses = ["learnings_fts MATCH ?", ...filterClauses];

  const stackRank = stackRankSql(filters.stack, "learnings.");
  const statement = db.prepare(
    // CROSS JOIN pins the join order (FTS MATCH first, then learnings by
    // rowid) so the query planner can't "helpfully" drive this from the new
    // learnings(status, created_at) index instead — that plan probes the FTS
    // virtual table per learnings row and is dramatically slower than MATCH
    // first (measured ~300x on a 5k-row corpus; see tests/perf.test.ts).
    `SELECT learnings.*, snippet(learnings_fts, -1, ?, ?, '…', 24) AS snippet
     FROM learnings_fts
     CROSS JOIN learnings ON learnings.rowid = learnings_fts.rowid
     WHERE ${clauses.join(" AND ")}
     ORDER BY ${stackRank ? `${stackRank}, ` : ""}${RANK_EXPRESSION} DESC, learnings.created_at DESC
     LIMIT ? OFFSET ?`,
  );

  type SearchRow = LearningRow & { snippet: string };
  const run = (matchExpr: string, lim = limit, off = offset) =>
    statement.all(
      SNIPPET_MARK_START,
      SNIPPET_MARK_END,
      matchExpr,
      ...filterParams,
      lim,
      off,
    ) as unknown as SearchRow[];

  let rows = run(ftsQuery);
  // Nothing matched every term: widen to any term rather than answering "nothing
  // found" to a question typed as a sentence. Past page 1 an empty page can also
  // mean "ran out of all-terms matches", so widen only when all-terms matches
  // nothing at all, the same decision searchTotal() makes, or page 2 of a widened
  // search comes back empty while `total` says there is more.
  if (rows.length === 0 && (offset === 0 || run(ftsQuery, 1, 0).length === 0)) {
    const anyQuery = buildFtsAnyQuery(query);
    if (anyQuery) rows = run(anyQuery);
  }

  const authorNames = getAuthorNames(rows.map((r) => r.author_id));
  const supersededByIds = getSupersededByIds(rows.map((r) => r.id));
  const standings = standingsFor(rows);
  const retires = lastRetiresFor(rows);
  const verify = verifyDueIds(db, rows);

  return rows.map((r) => ({
    ...r,
    ...ageInfo(r),
    ...appliesToFields(r, filters.stack),
    snippet: renderSnippetHtml(r.snippet),
    authorName: authorNames.get(r.author_id) ?? null,
    supersededBy: supersededByIds.get(r.id),
    ...standingFields(standings.get(r.id)!),
    lastRetire: retires.get(r.id),
    ...(verify.has(r.id) ? { verify: true as const } : {}),
  }));
}

export interface VoteNote {
  kind: "confirm" | "flag";
  voterName: string;
  note: string | null;
  at: string;
}

export const RECENT_NOTES_LIMIT = 5;

/**
 * The latest confirmations and flags with their notes, newest first. Search results, the list
 * endpoint and standingReason never carry note text, and the FTS index covers title, body and
 * tags only; the one exception is the note of the latest retire or restore, which has its own
 * field (lastRetire) so that later notes cannot push it out of these five. Plain data; every
 * surface renders it as text.
 */
export function recentNotes(learningId: string, limit: number = RECENT_NOTES_LIMIT): VoteNote[] {
  // A deleted memory is a wiped tombstone: its notes often paraphrase the content, so they go
  // with it instead of lingering until the retention sweep removes the vote rows.
  const row = getDb().prepare("SELECT status FROM learnings WHERE id = ?").get(learningId) as { status: string } | undefined;
  if (!row || row.status === "deleted") return [];
  return getDb()
    .prepare(
      `SELECT v.kind AS kind, v.note AS note, v.created_at AS at, COALESCE(u.name, v.voter_id) AS voterName
       FROM votes v LEFT JOIN users u ON u.id = v.voter_id
       WHERE v.learning_id = ? AND v.kind IN ('confirm', 'flag')
       ORDER BY v.created_at DESC, v.rowid DESC LIMIT ?`,
    )
    .all(learningId, limit) as unknown as VoteNote[];
}

/** Who retired or restored a memory, when and why (lastRetire). */
export interface RetireEvent {
  kind: "retire" | "restore";
  voterName: string;
  note: string | null;
  /** SQLite datetime text (UTC), like VoteNote.at. */
  at: string;
}

/**
 * The latest retire or restore of each memory in `rows`, in one grouped query however many rows
 * there are. A retire used to sit among the five recent notes, where five later flags or
 * confirms pushed it out and nobody could tell why a memory was archived; it is its own field
 * now, on the memory page, in GET /api/learnings/:id and in every search hit (owner review,
 * 2026-10-02). "Latest" is the highest rowid, because recordRetireEvent gives every event a
 * fresh row. A deleted memory has none: its notes go with its text.
 */
export function lastRetiresFor(rows: Array<Pick<LearningRow, "id" | "status">>): Map<string, RetireEvent> {
  const out = new Map<string, RetireEvent>();
  const ids = [...new Set(rows.filter((r) => r.status !== "deleted").map((r) => r.id))];
  if (ids.length === 0) return out;

  const marks = ids.map(() => "?").join(",");
  const events = getDb()
    .prepare(
      `SELECT v.learning_id AS id, v.kind AS kind, v.note AS note, v.created_at AS at,
              COALESCE(u.name, v.voter_id) AS voterName
       FROM votes v LEFT JOIN users u ON u.id = v.voter_id
       WHERE v.learning_id IN (${marks}) AND v.kind IN ('retire', 'restore')
       ORDER BY v.rowid`,
    )
    .all(...ids) as unknown as Array<RetireEvent & { id: string }>;
  // Oldest first, so the last event of a memory is the one that stays.
  for (const e of events) out.set(e.id, { kind: e.kind, voterName: e.voterName, note: e.note, at: e.at });
  // A restore is not the reason a memory is archived: when it was archived again since (two
  // flags, a sweep), saying "restored" would mislead. Say nothing rather than that.
  const archived = new Set(rows.filter((r) => r.status === "archived").map((r) => r.id));
  for (const [id, e] of out) if (e.kind === "restore" && archived.has(id)) out.delete(id);
  return out;
}

/** lastRetiresFor for one memory. */
export function lastRetire(learning: Pick<LearningRow, "id" | "status">): RetireEvent | undefined {
  return lastRetiresFor([learning]).get(learning.id);
}

/** The two fields that go on the wire; `points` stays internal. */
function standingFields(s: Standing): { standing: StandingLevel; standingReason: string } {
  return { standing: s.standing, standingReason: s.standingReason };
}

/** The longest chain of corrections carriedFor follows. A cycle cannot be written through create(); this bounds one made by hand. */
const CARRY_CHAIN_MAX = 20;

function emptyVoteCounts(): LearningVoteCounts {
  return { helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 0 };
}

/**
 * The points each correction in `ids` inherits (lib/standing.ts carryOver). A correction that
 * replaces exactly one entry gets half of that entry's points, and that entry's points include
 * what it inherited itself, so standing survives a chain A -> B -> C. A consolidation of several
 * entries carries nothing and ends the chain. The chain is walked one level per grouped query,
 * however many rows `ids` has, then the carry is computed from the oldest end down. `pageCounts`
 * are the votes standingsFor already counted for `ids`, so only entries outside the page are read.
 */
function carriedFor(
  db: ReturnType<typeof getDb>,
  ids: string[],
  pageCounts: Map<string, LearningVoteCounts>,
): Map<string, number> {
  const parentOf = new Map<string, string>();
  const seen = new Set(ids);
  let frontier = ids;
  for (let depth = 0; depth < CARRY_CHAIN_MAX && frontier.length > 0; depth++) {
    const marks = frontier.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT new_id AS id, MIN(old_id) AS old_id FROM supersession_links
         WHERE new_id IN (${marks}) GROUP BY new_id HAVING COUNT(DISTINCT old_id) = 1`,
      )
      .all(...frontier) as unknown as { id: string; old_id: string }[];
    const next: string[] = [];
    for (const r of rows) {
      parentOf.set(r.id, r.old_id);
      if (!seen.has(r.old_id)) {
        seen.add(r.old_id);
        next.push(r.old_id);
      }
    }
    frontier = next;
  }
  if (parentOf.size === 0) return new Map();

  const pageIds = new Set(ids);
  const votes = new Map(pageCounts);
  const outside = [...new Set(parentOf.values())].filter((id) => !pageIds.has(id));
  if (outside.length > 0) {
    const marks = outside.map(() => "?").join(",");
    const voteRows = db
      .prepare(`SELECT learning_id, kind, COUNT(*) AS n FROM votes WHERE learning_id IN (${marks}) GROUP BY learning_id, kind`)
      .all(...outside) as unknown as { learning_id: string; kind: string; n: number | bigint }[];
    for (const r of voteRows) {
      let c = votes.get(r.learning_id);
      if (!c) {
        c = emptyVoteCounts();
        votes.set(r.learning_id, c);
      }
      if (r.kind in c) c[r.kind as keyof LearningVoteCounts] = Number(r.n);
    }
  }

  const carried = new Map<string, number>();
  const visiting = new Set<string>();
  const carriedOf = (id: string): number => {
    const known = carried.get(id);
    if (known !== undefined) return known;
    const parent = parentOf.get(id);
    if (!parent || visiting.has(id)) return 0;
    visiting.add(id);
    const n = carryOver(votes.get(parent) ?? emptyVoteCounts(), carriedOf(parent));
    visiting.delete(id);
    carried.set(id, n);
    return n;
  };
  for (const id of parentOf.keys()) carriedOf(id);
  return carried;
}

/**
 * Standing for a page of rows in a few grouped queries, however many rows there are (a per-row
 * lookup would add N queries to every search): vote counts with the newest confirm per entry,
 * what each entry superseded, and the chain of corrections behind it (see carriedFor). The votes
 * are the only input, so a note cannot leak into the reason.
 */
export function standingsFor(
  rows: Array<Pick<LearningRow, "id" | "source" | "created_at" | "author_id">>,
  now: number = Date.now(),
): Map<string, Standing> {
  const out = new Map<string, Standing>();
  if (rows.length === 0) return out;

  const db = getDb();
  const ids = [...new Set(rows.map((r) => r.id))];
  const marks = ids.map(() => "?").join(",");

  const counts = new Map<string, LearningVoteCounts>();
  const lastConfirm = new Map<string, string>();
  const voteRows = db
    .prepare(
      `SELECT learning_id, kind, COUNT(*) AS n, MAX(created_at) AS last
       FROM votes WHERE learning_id IN (${marks}) GROUP BY learning_id, kind`,
    )
    .all(...ids) as unknown as { learning_id: string; kind: string; n: number | bigint; last: string }[];
  for (const r of voteRows) {
    let c = counts.get(r.learning_id);
    if (!c) {
      c = { helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 0 };
      counts.set(r.learning_id, c);
    }
    if (r.kind in c) c[r.kind as keyof LearningVoteCounts] = Number(r.n);
    if (r.kind === "confirm") lastConfirm.set(r.learning_id, r.last);
  }

  const replaced = new Map<string, { entries: number; confirmations: number }>();
  const replacedRows = db
    .prepare(
      `SELECT sl.new_id AS id, COUNT(DISTINCT sl.old_id) AS entries, COUNT(v.voter_id) AS confirmations
       FROM supersession_links sl
       LEFT JOIN votes v ON v.learning_id = sl.old_id AND v.kind = 'confirm'
       WHERE sl.new_id IN (${marks}) GROUP BY sl.new_id`,
    )
    .all(...ids) as unknown as { id: string; entries: number | bigint; confirmations: number | bigint }[];
  for (const r of replacedRows) replaced.set(r.id, { entries: Number(r.entries), confirmations: Number(r.confirmations) });

  // A correction that replaces exactly one entry inherits part of that entry's standing, and
  // that entry may have inherited from the one before it (see carriedFor).
  const carried = carriedFor(db, ids, counts);

  for (const row of rows) {
    const c = counts.get(row.id) ?? { helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 0 };
    out.set(
      row.id,
      computeStanding(
        { ...c, lastConfirmAt: lastConfirm.get(row.id) ?? null, replaced: replaced.get(row.id), carried: carried.get(row.id) ?? 0 },
        { source: row.source, created_at: row.created_at, authorIsMaintainer: isMaintainer(row.author_id) },
        now,
      ),
    );
  }
  return out;
}

/**
 * Total rows search() would page through for the same query/filters, ignoring
 * limit/offset — bab_search's `total` (lib/mcp.ts). Mirrors search()'s own
 * all-terms-then-any-term decision (a query that needs the any-term widening
 * to match anything counts against that wider match, same as page 1 of search()
 * would return), so the two never disagree about how many rows exist at offset 0.
 */
export function searchTotal(query: string, filters: ListFilters = {}): number {
  const db = getDb();
  const ftsQuery = buildFtsQuery(query);

  if (!ftsQuery) return list(filters).length;

  const { clauses: filterClauses, params: filterParams } = searchFilterClauses(filters);
  const clauses = ["learnings_fts MATCH ?", ...filterClauses];

  const countStatement = db.prepare(
    `SELECT COUNT(*) AS n
     FROM learnings_fts
     CROSS JOIN learnings ON learnings.rowid = learnings_fts.rowid
     WHERE ${clauses.join(" AND ")}`,
  );
  const countFor = (matchExpr: string) =>
    (countStatement.get(matchExpr, ...filterParams) as { n: number }).n;

  const allCount = countFor(ftsQuery);
  if (allCount > 0) return allCount;

  const anyQuery = buildFtsAnyQuery(query);
  return anyQuery ? countFor(anyQuery) : 0;
}

export interface ProjectSummary {
  project: string;
  count: number;
  lastActivityAt: string;
}

/**
 * Every project in use across active learnings, newest activity
 * first — how an agent discovers what projects already exist before
 * picking a key (GET /api/projects).
 */
export function listProjects(): ProjectSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT project, COUNT(*) AS count, MAX(updated_at) AS lastActivityAt
       FROM learnings
       WHERE project IS NOT NULL AND status = 'active'
       GROUP BY project
       ORDER BY lastActivityAt DESC`,
    )
    .all() as unknown as { project: string; count: number | bigint; lastActivityAt: string }[];
  return rows.map((r) => ({
    project: r.project,
    count: Number(r.count),
    lastActivityAt: r.lastActivityAt,
  }));
}

export interface FindSimilarInput {
  title: string;
  body: string;
  tags?: string[];
  repo?: string | null;
  /** Normalised project key of the draft: its own project's rows are compared first. */
  project?: string | null;
}

export interface SimilarLearning {
  id: string;
  title: string;
  score: number;
  author_id: string;
  authorName: string | null;
  tags: string[];
  created_at: string;
  status: LearningStatus;
  verdict: "duplicate" | "similar";
}

const FTS_TOKEN_CAP = 20;
const FTS_CANDIDATE_LIMIT = 20;

/**
 * Draft has no usable title/body tokens (too short, all stopwords) but does have
 * tags: fall back to a tag-only candidate scan among active learnings,
 * scoring by raw tag-set Jaccard overlap rather than the weighted formula (which
 * would otherwise cap out at 0.15 and never surface anything).
 */
function findSimilarByTagsOnly(draftTags: string[], limit: number): SimilarLearning[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM learnings WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`,
    )
    .all(FTS_CANDIDATE_LIMIT) as unknown as LearningRow[];

  const authorNames = getAuthorNames(rows.map((r) => r.author_id));

  const scored: SimilarLearning[] = rows.map((r) => {
    const candidateTags = (JSON.parse(r.tags) as string[]).map((t) => t.toLowerCase());
    const score = jaccard(candidateTags, draftTags);
    return {
      id: r.id,
      title: r.title,
      score,
      author_id: r.author_id,
      authorName: authorNames.get(r.author_id) ?? null,
      tags: candidateTags,
      created_at: r.created_at,
      status: r.status,
      verdict: score >= DUPLICATE_THRESHOLD ? "duplicate" : "similar",
    };
  });

  return scored
    .filter((s) => s.score >= TAG_ONLY_SIMILAR_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Finds existing active learnings similar to a draft. Builds an
 * FTS5 OR query from the draft's title+body tokens (capped at 20, each
 * quoted), pulls the top 20 candidates, scores each with similarityScore,
 * and returns those at or above SIMILAR_THRESHOLD, sorted highest first.
 * If the draft has no usable title/body tokens but does have tags, falls
 * back to tag-only overlap (see findSimilarByTagsOnly).
 */
export function findSimilar(
  draft: FindSimilarInput,
  { limit = 5 }: { limit?: number } = {},
): SimilarLearning[] {
  const db = getDb();

  const tokens = [...normalizeTokens(draft.title), ...normalizeTokens(draft.body)].slice(
    0,
    FTS_TOKEN_CAP,
  );
  const draftTagsEarly = (draft.tags ?? []).map((t) => t.toLowerCase());
  if (tokens.length === 0) {
    return draftTagsEarly.length > 0 ? findSimilarByTagsOnly(draftTagsEarly, limit) : [];
  }

  const ftsQuery = Array.from(new Set(tokens)).map(quoteFtsToken).join(" OR ");

  // Best bm25 match first, not newest first: with created_at DESC a common token let 20
  // newer rows crowd out an older true duplicate. A draft with a project compares that
  // project's rows first and fills the rest from everywhere else, so a duplicate in the
  // same project is never displaced by another project's chatter.
  const candidateSql = (projectClause: string) =>
    // See the CROSS JOIN note in search() above: same reordering hazard.
    `SELECT learnings.*
       FROM learnings_fts
       CROSS JOIN learnings ON learnings.rowid = learnings_fts.rowid
       WHERE learnings_fts MATCH ? AND learnings.status = 'active'${projectClause}
       ORDER BY bm25(learnings_fts), learnings.rowid
       LIMIT ?`;
  let rows: LearningRow[] = [];
  if (draft.project) {
    rows = db.prepare(candidateSql(" AND learnings.project = ?")).all(ftsQuery, draft.project, FTS_CANDIDATE_LIMIT) as unknown as LearningRow[];
  }
  if (rows.length < FTS_CANDIDATE_LIMIT) {
    const seen = new Set(rows.map((r) => r.id));
    const rest = db
      .prepare(candidateSql(draft.project ? " AND (learnings.project IS NULL OR learnings.project != ?)" : ""))
      .all(...(draft.project ? [ftsQuery, draft.project] : [ftsQuery]), FTS_CANDIDATE_LIMIT - rows.length) as unknown as LearningRow[];
    rows = rows.concat(rest.filter((r) => !seen.has(r.id)));
  }

  const draftTags = (draft.tags ?? []).map((t) => t.toLowerCase());
  const authorNames = getAuthorNames(rows.map((r) => r.author_id));

  const scored: SimilarLearning[] = rows.map((r) => {
    const candidateTags = JSON.parse(r.tags) as string[];
    const score = similarityScore(
      { title: r.title, body: r.body, tags: candidateTags },
      { title: draft.title, body: draft.body, tags: draftTags },
    );
    return {
      id: r.id,
      title: r.title,
      score,
      author_id: r.author_id,
      authorName: authorNames.get(r.author_id) ?? null,
      tags: candidateTags,
      created_at: r.created_at,
      status: r.status,
      verdict: score >= DUPLICATE_THRESHOLD ? "duplicate" : "similar",
    };
  });

  return scored
    .filter((s) => s.score >= SIMILAR_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** `.` and `-` are interchangeable in a folder name (`claude.plugins` vs `claude-plugins`). */
const dotToDash = (v: string) => v.replace(/\./g, "-");

/**
 * How long a worktree folder's project is remembered (owner review, 2026-10-02): the hook asks
 * for it on every prompt of every session, and each answer reads the projects in use. A project
 * that gets its first memory is noticed after this long at most.
 */
export const CWD_PROJECT_TTL_MS = 5 * 60 * 1000;
/** The hook sends whatever folder it is given, so the memory is bounded. */
const CWD_PROJECT_CACHE_MAX = 500;
/** Keyed on the folder; an entry made against another database connection (a test's reset) is ignored. */
const cwdProjectCache = new Map<string, { db: ReturnType<typeof getDb>; at: number; value: string }>();

/**
 * The project a session's cwd belongs to. projectKeyFromCwd cannot know repo names, so
 * `_worktrees/bab-fix-count` comes back as `bab-fix-count`. When the folder sat under
 * `_worktrees`, match it against the projects in use: the longest key the candidate starts
 * with (`.` and `-` equal, next char `-` or the end) wins. No match keeps the candidate as is.
 *
 * Only that match reads the database, and its answer is remembered per folder for
 * CWD_PROJECT_TTL_MS: the hook calls this on every prompt, twice. Any other folder is answered
 * from its name alone.
 */
export function resolveProjectFromCwd(cwd: string | null | undefined): string | null {
  const candidate = projectKeyFromCwd(cwd);
  if (!candidate) return null;

  // Only a worktree folder is named "<repo>-<branch>"; a plain folder such as ci-mono is
  // its own project and must not collapse into a shorter key (ci) that happens to exist.
  const segments = typeof cwd === "string" ? cwd.split(/[\\/]/).filter(Boolean) : [];
  const viaWorktrees = segments.includes("_worktrees");
  if (!viaWorktrees) return candidate;

  const db = getDb();
  const now = Date.now();
  const cached = cwdProjectCache.get(cwd as string);
  if (cached && cached.db === db && now - cached.at < CWD_PROJECT_TTL_MS) return cached.value;

  const wanted = dotToDash(candidate);
  let best: string | null = null;
  for (const { project: key } of listProjects()) {
    const k = dotToDash(key);
    const boundary = wanted.length === k.length || wanted[k.length] === "-";
    if (wanted.startsWith(k) && boundary && (best === null || key.length > best.length)) best = key;
  }
  const value = best ?? candidate;

  if (cwdProjectCache.size >= CWD_PROJECT_CACHE_MAX) {
    for (const [folder, entry] of cwdProjectCache) {
      if (now - entry.at >= CWD_PROJECT_TTL_MS) cwdProjectCache.delete(folder);
    }
    // Still full: drop the oldest entry (a Map iterates in insertion order).
    if (cwdProjectCache.size >= CWD_PROJECT_CACHE_MAX) cwdProjectCache.delete(cwdProjectCache.keys().next().value as string);
  }
  cwdProjectCache.delete(cwd as string);
  cwdProjectCache.set(cwd as string, { db, at: now, value });
  return value;
}

function getAuthorName(authorId: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT name FROM users WHERE id = ?").get(authorId) as unknown as | { name: string | null }
    | undefined;
  return row?.name ?? null;
}

/** Batched author-name lookup: one query for a whole result page instead of N. */
function getAuthorNames(authorIds: string[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const unique = Array.from(new Set(authorIds));
  if (unique.length === 0) return map;

  const db = getDb();
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, name FROM users WHERE id IN (${placeholders})`)
    .all(...unique) as unknown as { id: string; name: string | null }[];
  for (const r of rows) map.set(r.id, r.name ?? null);
  return map;
}

/** Batched findSupersededBy: one query for a whole result page instead of N. */
function getSupersededByIds(learningIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(learningIds));
  if (unique.length === 0) return map;

  const db = getDb();
  const placeholders = unique.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT old_id, new_id FROM supersession_links WHERE old_id IN (${placeholders})`)
    .all(...unique) as unknown as { old_id: string; new_id: string }[];
  for (const r of rows) map.set(r.old_id, r.new_id);
  return map;
}

/**
 * `supersedes` as callers send it: absent, one id, or a list of ids (a consolidation).
 * Returns the distinct ids in order. Anything else is a caller mistake, not "absent".
 */
export function parseSupersedes(raw: unknown): string[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const ids: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") throw new ValidationError("supersedes must be an id or a list of ids");
    const id = item.trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Every id must exist and not be deleted, checked BEFORE anything is written, so one bad
 * id in a list rejects the whole write and archives nothing.
 */
export function assertSupersedable(ids: string[]): void {
  for (const id of ids) {
    const target = getById(id);
    if (!target || target.status === "deleted") {
      throw new NotFoundError("Learning to supersede was not found");
    }
    const link = getDb()
      .prepare("SELECT new_id FROM supersession_links WHERE old_id = ?")
      .get(id) as { new_id: string } | undefined;
    if (link) throw new ConflictError(`Learning ${id} is already superseded by ${link.new_id}`);
  }
}

/**
 * create() plus every supersede in ONE transaction: a consolidation is all or nothing, so a
 * failure on the third id leaves the new learning uncreated and the first two unarchived.
 * Ids are validated up front (assertSupersedable) for the clean 404/409, and again as each
 * link is written.
 */
export function createWithSupersedes(
  input: CreateLearningInput,
  supersedesIds: string[],
  via: AuditVia = "ui",
): LearningRow {
  assertSupersedable(supersedesIds);
  const db = getDb();
  let createInput: CreateLearningInput = { ...input, supersedesId: supersedesIds[0] ?? null };
  if (supersedesIds.length > 1) {
    // A consolidation keeps one kind, so standing earned under "standard" cannot be laundered
    // into a "learning" (or the reverse) by merging. Checked before the transaction so a
    // refusal writes nothing.
    const kinds = new Set(supersedesIds.map((id) => getById(id)!.kind));
    if (input.kind === undefined && kinds.size > 1) {
      throw new ValidationError("superseded entries have different kinds; pass kind");
    }
    if (input.kind !== undefined && (kinds.size > 1 || !kinds.has(parseKind(input.kind)))) {
      throw new ValidationError("a consolidation must keep the kind of the entries it replaces");
    }
    // create() sees only the first id as its target and would inherit that one entry's source
    // triple; a merge of several mirrors is a native summary unless the caller passes the triple.
    createInput = {
      ...createInput,
      kind: input.kind ?? [...kinds][0],
      source: input.source ?? "native",
      // create() sees one target only: a merge carries the union of all their applies-to labels.
      appliesTo: input.appliesTo !== undefined ? input.appliesTo : mergeAppliesTo(supersedesIds.map((id) => readAppliesTo(getById(id)!.applies_to))),
    };
  }
  const archived: Array<{ id: string; title: string }> = [];
  const created = inTransaction(db, () => {
    const row = create(createInput, via);
    for (const oldId of supersedesIds) archived.push(supersedeWithinTransaction(row.id, oldId, input.authorId, via));
    return getById(row.id)!;
  });
  for (const a of archived) emit("learning.updated", a.id, { id: a.id, title: a.title, kind: "archived" });
  return created;
}

export function supersede(newId: string, oldId: string, actorId: string, via: AuditVia = "ui") {
  const db = getDb();
  const archived = inTransaction(db, () => supersedeWithinTransaction(newId, oldId, actorId, via));
  emit("learning.updated", archived.id, { id: archived.id, title: archived.title, kind: "archived" });
}

/** supersede() for a caller that already holds the connection's transaction. Does not emit. */
function supersedeWithinTransaction(
  newId: string,
  oldId: string,
  actorId: string,
  via: AuditVia,
): { id: string; title: string } {
  if (newId === oldId) {
    throw new ValidationError("A learning cannot supersede itself");
  }

  const oldLearning = getById(oldId);
  if (!oldLearning || oldLearning.status === "deleted") {
    throw new NotFoundError("Learning to supersede was not found");
  }

  const newLearning = getById(newId);
  if (!newLearning || newLearning.status !== "active") {
    throw new ValidationError("Superseding learning must be active");
  }

  const db = getDb();
  // Archiving the old learning and linking supersedes_id on the new one must
  // land together — a crash between the two would orphan the old entry with
  // no forward link, so findSupersededBy() would never find it again (the
  // two-way link docs/spec.md's "Garbage collection" promises).
  db.prepare(
    "UPDATE learnings SET status = 'archived', updated_at = datetime('now') WHERE id = ?",
  ).run(oldId);
  db.prepare(
    "UPDATE learnings SET supersedes_id = COALESCE(supersedes_id, ?), updated_at = datetime('now') WHERE id = ?",
  ).run(oldId, newId);
  // One row per archived original, so a consolidation can point several at one entry.
  db.prepare("INSERT OR REPLACE INTO supersession_links (old_id, new_id) VALUES (?, ?)").run(oldId, newId);
  // A correction of a house rule stays a house rule, so fixing a typo does not silently drop it
  // from every session's digest. Only onto a kind that can be pinned.
  if (oldLearning.pinned === 1) {
    db.prepare(
      `UPDATE learnings SET pinned = 1 WHERE id = ? AND kind IN (${HOUSE_RULE_KINDS.map(() => "?").join(",")})`,
    ).run(newId, ...HOUSE_RULE_KINDS);
  }
  audit(db, actorId, "supersede", "learning", oldId, via);
  return { id: oldId, title: oldLearning.title };
}

export const FLAG_NOTE_MAX = 300;
export const RETIRE_NOTE_MAX = 300;
export const RESTORE_NOTE_MAX = 300;

/**
 * Flags a learning as wrong or stale. The note is the evidence (what moved, where, when); it
 * lands in votes.note and is shown on the detail page only. Required on the agent paths (via
 * "mcp"), optional for the web. A repeat flag by the
 * same person keeps the original date and replaces the note only when a new one is given.
 */
export function flag(
  learningId: string,
  voterId: string,
  via: AuditVia = "ui",
  note?: string | null,
): LearningRow {
  const db = getDb();
  const learning = getById(learningId);
  // A deleted memory cannot be judged any more; treat it as gone rather than store a note on it.
  if (!learning || learning.status === "deleted") throw new NotFoundError("Learning not found");
  if (learning.author_id === voterId) {
    throw new ForbiddenError("Cannot flag your own learning");
  }
  // Every change to someone else's memory carries a one-line evidence note (owner, 2026-10-02),
  // so the agent paths (MCP and REST both pass via "mcp") must give one. The web path keeps it
  // optional. Checked after the not-found and own-learning refusals so those keep their status.
  const normalizedNote = normalizeNote(note, FLAG_NOTE_MAX, via === "mcp");

  // The flag vote and the conditional auto-archive it can trigger must be
  // atomic: a crash between them would record the flag but never archive a
  // learning that just crossed FLAG_THRESHOLD, and a retry of the same flag
  // (ON CONFLICT keeps the row) would then never re-trigger it.
  let autoArchived = false;
  inTransaction(db, () => {
    // created_at is left alone on a repeat: only the note may change, and only when one is given.
    db.prepare(
      `INSERT INTO votes (learning_id, voter_id, kind, note) VALUES (?, ?, 'flag', ?)
       ON CONFLICT(learning_id, voter_id, kind) DO UPDATE SET note = COALESCE(excluded.note, votes.note)`,
    ).run(learningId, voterId, normalizedNote);
    audit(db, voterId, "flag", "learning", learningId, via);

    // Only flags placed after the latest restore count (by rowid: a flag keeps its rowid when its
    // owner repeats it, a restore row is inserted fresh). A restore is an answer to the flags
    // before it, so one more flag must not undo it; the old flags stay on record and in standing.
    const { n } = db
      .prepare(
        `SELECT COUNT(DISTINCT voter_id) AS n FROM votes
         WHERE learning_id = ? AND kind = 'flag'
           AND rowid > COALESCE((SELECT MAX(rowid) FROM votes WHERE learning_id = ? AND kind = 'restore'), 0)`,
      )
      .get(learningId, learningId) as unknown as { n: number };

    // Learnings and practices are kept by the fleet, so two independent flags archive them. A
    // maintainer decides about a standard or an ADR: two agents disagreeing with it must not
    // silently remove it, so the flags are recorded, the entry stays visible and its standing
    // drops to weak instead.
    if (
      n >= FLAG_THRESHOLD &&
      learning.status !== "archived" &&
      (learning.kind === "learning" || learning.kind === "practice")
    ) {
      db.prepare(
        "UPDATE learnings SET status = 'archived', updated_at = datetime('now') WHERE id = ?",
      ).run(learningId);
      audit(db, voterId, "auto_archive", "learning", learningId, via);
      autoArchived = true;
    }
  });

  // emit() only after a successful commit — a rollback must never have told
  // subscribers about a flag/archive that didn't actually happen.
  emit("flag", learningId, { id: learningId, title: learning.title });
  if (autoArchived) {
    emit("learning.updated", learningId, { id: learningId, title: learning.title, kind: "archived" });
  }

  return getById(learningId)!;
}

/**
 * Standards and decisions that wait for a maintainer (owner review, 2026-10-02). Others flag a
 * standard or decision with their evidence and "a maintainer decides", so a maintainer's session
 * hears how many are waiting (app/api/hook/route.ts). Waiting means: still live (active),
 * flagged, and the newest flag is newer than any confirm by a maintainer, or keep or
 * restore by a maintainer, after it. A supersede or a retire takes the entry out of the live
 * statuses, which also ends its wait. A repeat flag by the same person keeps its date, so it does
 * not reopen an entry a maintainer has answered; a flag by someone else does. 0 while
 * BAB_MAINTAINERS is unset: nobody could decide.
 *
 * Swarm garbage collection adds the same signal for the memories the sweep never archives (a
 * standard, a decision, a pinned house rule): when 3 or more people marked one not helpful and they
 * outnumber its support (lib/swarm-gc.ts downvotedLive), it waits too, until a keep, restore or
 * confirm answers those votes. An unpinned learning or practice is not here: the sweep archives it
 * once no agent has read it for 90 days, and anyone can keep it.
 */
export function flaggedStandardsWaiting(): number {
  return flaggedStandardsWaitingIds().length;
}

/**
 * The ids flaggedStandardsWaiting counts, newest first. bab_search and GET /api/learnings take
 * them as their `flagged` filter, so the nudge's count is what that search finds.
 */
export function flaggedStandardsWaitingIds(): string[] {
  const maintainers = maintainerIdList();
  if (maintainers.length === 0) return [];
  const marks = maintainers.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `WITH flagged AS (
         SELECT l.id AS id, MAX(v.created_at) AS flagged_at
         FROM learnings l JOIN votes v ON v.learning_id = l.id AND v.kind = 'flag'
         WHERE l.kind IN ('standard', 'decision') AND l.status = 'active'
         GROUP BY l.id
       )
       SELECT f.id AS id FROM flagged f JOIN learnings l ON l.id = f.id
       WHERE NOT EXISTS (
               SELECT 1 FROM votes c
               WHERE c.learning_id = f.id AND c.kind = 'confirm' AND c.created_at > f.flagged_at
                 AND lower(c.voter_id) IN (${marks}))
         AND NOT EXISTS (
               SELECT 1 FROM votes k
               WHERE k.learning_id = f.id AND k.kind IN ('keep', 'restore') AND k.created_at > f.flagged_at
                 AND lower(k.voter_id) IN (${marks}))
       ORDER BY l.created_at DESC, l.id`,
    )
    .all(...maintainers, ...maintainers) as Array<{ id: string }>;
  const flaggedIds = rows.map((r) => r.id);

  const downvoted = downvotedLive(getDb())
    .filter((m) => m.protectedEntry)
    .map((m) => m.id)
    .filter((id) => !flaggedIds.includes(id));
  if (downvoted.length === 0) return flaggedIds;
  const all = [...flaggedIds, ...downvoted];
  const allMarks = all.map(() => "?").join(",");
  const ordered = getDb()
    .prepare(`SELECT id FROM learnings WHERE id IN (${allMarks}) ORDER BY created_at DESC, id`)
    .all(...all) as Array<{ id: string }>;
  return ordered.map((r) => r.id);
}

/**
 * Agent reads (owner, 2026-10-07). A memory counts as read when an AGENT gets it: in a text search
 * result (bab_search, GET /api/learnings), by id (GET /api/learnings/:id), or through a reaction that
 * says it was used (helpful, confirm, kudos, keep). It does not count when a person opens a web
 * page (the /memory pages call this module directly and never come here), nor in the digests a
 * session starts with (house rules, project titles). The hourly sweep archives a memory that no
 * agent has read for INACTIVITY_ARCHIVE_DAYS (sweepInactive in lib/maintenance.ts).
 *
 * At most one write per memory per UTC day: `access_days` counts the days with a read and
 * `last_accessed_at` holds the first read of the latest day, so a popular memory costs one write a
 * day, not one per search. It never touches updated_at (that is "last edited") and emits no event
 * (it would refresh every open page). Only an active memory: an archived one comes back through
 * keep, which restores it first. Runs inside the caller's transaction when there is one.
 */
export function touchRead(db: ReturnType<typeof getDb>, ids: string[]): void {
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE learnings SET last_accessed_at = datetime('now'), access_days = access_days + 1
     WHERE id IN (${marks}) AND status = 'active'
       AND (last_accessed_at IS NULL OR substr(last_accessed_at, 1, 10) < ?)`,
  ).run(...ids, todayUtc());
}

/** touchRead for the read paths of agents. Never throws: a failed write must not fail the read. */
export function recordAgentRead(ids: string[]): void {
  try {
    touchRead(getDb(), ids);
  } catch (err) {
    console.error("recordAgentRead failed", err);
  }
}

/**
 * The agent read of a search or listing: the page of results the agent actually received. Not for
 * the views of someone reviewing what is not live or waiting: the flagged queue a maintainer
 * triages, and an explicit status other than active (archived, all). A plain listing by kind,
 * project or repo counts: "bab_search kind standard before changing a repo" is how agents read the
 * rules, and that is use. The house rules digest does not come through here (pinned rules are
 * never archived for lack of reads anyway).
 */
export function recordSearchRead(results: Array<{ id: string }>, filters: Pick<ListFilters, "status" | "flagged">): void {
  if (filters.flagged) return;
  if (filters.status && filters.status !== "active") return;
  recordAgentRead(results.map((r) => r.id));
}

export type VoteChoice = "helpful" | "not_helpful";

export interface VoteResult {
  learning: LearningRow;
  /**
   * false when this exact kind was already recorded for this identity: the vote itself is
   * unchanged (200). A repeat helpful still counts as use, so it counts as a read.
   */
  changed: boolean;
}

/**
 * Casts (or switches) a helpful/not_helpful vote. A repeat of the same kind
 * leaves the vote as it is (`changed: false`, 200), but a repeat helpful still
 * says the memory is in use, so it counts as a read like the first one.
 * Switching kind (helpful <-> not_helpful) replaces the previous one, since a
 * voter only ever holds one opinion at a time (`changed: true`, 200).
 */
export function vote(
  learningId: string,
  voterId: string,
  choice: VoteChoice,
  via: AuditVia = "ui",
): VoteResult {
  const db = getDb();
  const learning = getById(learningId);
  if (!learning) throw new NotFoundError("Learning not found");
  if (learning.author_id === voterId) {
    throw new ForbiddenError("Cannot vote on your own learning");
  }

  // One transaction, so the vote, its score and the read land together or not at all.
  const changed = inTransaction(db, () => {
    const existing = db
      .prepare(
        "SELECT kind FROM votes WHERE learning_id = ? AND voter_id = ? AND kind IN ('helpful', 'not_helpful')",
      )
      .get(learningId, voterId) as { kind: VoteChoice } | undefined;

    // The vote is already recorded and stays as it is. A repeat helpful is still use, though.
    if (existing && existing.kind === choice) {
      if (choice === "helpful") touchRead(db, [learningId]);
      return false;
    }

    if (existing) {
      db.prepare("DELETE FROM votes WHERE learning_id = ? AND voter_id = ? AND kind = ?").run(
        learningId,
        voterId,
        existing.kind,
      );
    }

    db.prepare(
      "INSERT OR IGNORE INTO votes (learning_id, voter_id, kind) VALUES (?, ?, ?)",
    ).run(learningId, voterId, choice);
    audit(db, voterId, choice, "learning", learningId, via);

    recomputeScore(learningId);
    // Only a helpful says the memory is in use; not_helpful says nothing about that.
    if (choice === "helpful") touchRead(db, [learningId]);
    return true;
  });

  if (!changed) return { learning: getById(learningId)!, changed: false };
  emit("vote", learningId, { id: learningId, title: learning.title, kind: choice });

  return { learning: getById(learningId)!, changed: true };
}

const KUDOS_NOTE_MAX = 500;
export const CONFIRM_NOTE_MAX = 300;
/** A repeat confirm by the same person inside this window is a no-op (see confirm()). */
export const CONFIRM_REFRESH_DAYS = 30;

/**
 * One place for the trim, redact and length rules every vote note shares (kudos, confirm),
 * so the three lines are not copied per vote kind. `required` turns an empty note into a
 * 400; otherwise empty becomes null.
 */
function normalizeNote(note: string | null | undefined, max: number, required: boolean): string | null {
  const trimmed = note == null ? "" : note.trim();
  if (!trimmed) {
    if (required) throw new ValidationError("note is required");
    return null;
  }
  assertRawLength("note", trimmed, max);
  const redacted = redact(trimmed);
  // The cap is on what is stored, so a note just under it can grow past it when an email or
  // number is replaced; say so, or the caller cannot tell why a short note was refused.
  if (redacted.length > max) {
    throw new ValidationError(`note must be ${max} characters or fewer after redaction (emails and numbers are replaced)`);
  }
  return redacted;
}

/**
 * A note from a request body or tool arguments: text or nothing. Anything else is refused, so
 * `{}` cannot become the note "[object Object]" and count as a required confirmation note.
 */
export function noteArg(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new ValidationError("note must be text");
  return raw;
}

/**
 * give_kudos (docs/spec.md "Kudos, leaderboard and awards", phase 3
 * groundwork): a distinct vote kind, one per identity per learning, never
 * on your own. A repeat is an explicit 409 (`ConflictError`), not a silent
 * no-op — the agent should tell the human it already thanked this author.
 */
export function giveKudos(
  learningId: string,
  voterId: string,
  note: string | null | undefined,
  via: AuditVia = "ui",
): LearningRow {
  const db = getDb();
  const learning = getById(learningId);
  if (!learning) throw new NotFoundError("Learning not found");
  if (learning.author_id === voterId) {
    throw new ForbiddenError("Cannot give kudos on your own learning");
  }

  const already = db
    .prepare("SELECT 1 FROM votes WHERE learning_id = ? AND voter_id = ? AND kind = 'kudos'")
    .get(learningId, voterId);
  if (already) {
    throw new ConflictError("Kudos already given");
  }

  const normalizedNote = normalizeNote(note, KUDOS_NOTE_MAX, false);

  inTransaction(db, () => {
    db.prepare(
      "INSERT OR IGNORE INTO votes (learning_id, voter_id, kind, note) VALUES (?, ?, 'kudos', ?)",
    ).run(learningId, voterId, normalizedNote);
    audit(db, voterId, "kudos", "learning", learningId, via);

    recomputeScore(learningId);
    touchRead(db, [learningId]);
  });
  emit("kudos", learningId, { id: learningId, title: learning.title });

  return getById(learningId)!;
}

export interface ConfirmResult {
  learning: LearningRow;
  /**
   * false when the same person confirmed inside CONFIRM_REFRESH_DAYS: the confirmation itself
   * (note, date, score) is unchanged. It still counts as use, so it counts as a read.
   */
  changed: boolean;
}

/**
 * confirm: "I checked this against code or docs and it holds". A note saying where is
 * required, so a confirmation is a checkable statement, not a click. Never on your own
 * entry, like vote, flag and kudos.
 *
 * One row per person per learning (the votes primary key). A repeat inside
 * CONFIRM_REFRESH_DAYS leaves the confirmation alone: a loop cannot pump a score by
 * re-confirming. After that a repeat is a real re-check a month later, so it refreshes the note
 * and the date, and the score still counts the person once. So does a repeat after a flag that
 * came in since: it answers the flag, and for a standard or decision a maintainer's confirm
 * after the newest flag is what ends its wait (flaggedStandardsWaiting). Either way a confirm
 * is use, so it counts as a read (touchRead).
 */
export function confirm(
  learningId: string,
  voterId: string,
  note: string | null | undefined,
  via: AuditVia = "ui",
): ConfirmResult {
  const db = getDb();
  const learning = getById(learningId);
  if (!learning || learning.status === "deleted") throw new NotFoundError("Learning not found");
  if (learning.author_id === voterId) {
    throw new ForbiddenError("Cannot confirm your own learning");
  }
  const normalizedNote = normalizeNote(note, CONFIRM_NOTE_MAX, true);

  const changed = inTransaction(db, () => {
    const existing = db
      .prepare("SELECT created_at FROM votes WHERE learning_id = ? AND voter_id = ? AND kind = 'confirm'")
      .get(learningId, voterId) as { created_at: string } | undefined;
    const recent =
      existing !== undefined &&
      Date.now() - parseDbTime(existing.created_at).getTime() < CONFIRM_REFRESH_DAYS * 86_400_000;
    // A flag or a not-helpful vote that arrived after the confirmation is answered by a new one,
    // not treated as a repeat: the renewed date is what tells the swarm sweep (lib/swarm-gc.ts) that
    // the not-helpful votes before it were answered.
    const flaggedSince =
      recent &&
      db
        .prepare("SELECT 1 FROM votes WHERE learning_id = ? AND kind IN ('flag', 'not_helpful') AND created_at > ? LIMIT 1")
        .get(learningId, existing!.created_at) !== undefined;
    if (recent && !flaggedSince) {
      // The confirmation stays as it is, but the person just said again that the memory is in use.
      touchRead(db, [learningId]);
      return false;
    }
    // A confirm on an old memory nobody has checked lately is a verification (the usage page's
    // Clean-up card counts them): recorded in the audit row, so decided before this confirm lands.
    const verified = verifyDueIds(db, [learning]).has(learningId);
    db.prepare(
      `INSERT INTO votes (learning_id, voter_id, kind, note) VALUES (?, ?, 'confirm', ?)
       ON CONFLICT(learning_id, voter_id, kind) DO UPDATE SET note = excluded.note, created_at = datetime('now')`,
    ).run(learningId, voterId, normalizedNote);
    audit(db, voterId, "confirm", "learning", learningId, via, verified ? { details: { verified: true } } : undefined);
    recomputeScore(learningId);
    touchRead(db, [learningId]);
    return true;
  });

  // emit() only after commit, and as the existing vote event: LiveUpdates already refreshes on it.
  if (changed) emit("vote", learningId, { id: learningId, title: learning.title, kind: "confirm" });
  return { learning: getById(learningId)!, changed };
}

export interface KeepResult {
  learning: LearningRow;
  /** true when the keep restored an archived memory; false for a keep of a live one (nothing moved, the keep is on record). */
  changed: boolean;
  /** Set when the memory has a valid-until date of its own, which a keep does not move. */
  message?: string;
}

/**
 * "Keep" a memory (bab_react's `keep` action, lib/mcp.ts): anyone who is identified may keep a memory
 * they verified is still true (owner, 2026-10-02: BAB is managed by a fleet of independent agents,
 * so keeping is not an author right). On a live memory it counts as a read (touchRead) and is on
 * record as a `keep` row in `votes`, which is how a maintainer answers a flag on a standard or
 * decision. Nothing else moves: memories do not expire, and a valid-until date its author chose is
 * the author's to change (post a correction with a new expiresAt).
 *
 * On an ARCHIVED memory, keep restores it (owner review, 2026-10-02): a retire, two flags or the
 * inactivity sweep can be wrong, and without a way back a wrongly archived memory was lost. The
 * server does not ask why it was archived: whoever keeps it says it is still true, the same claim
 * for a retired, a flagged-away, an unread and a past-its-date memory. A non-author gives a
 * one-line note saying why, a required field like retire's, trimmed, redacted and at most
 * RESTORE_NOTE_MAX characters. The status goes back to `active`, the inactivity clock restarts (the
 * keep is a read), a `restore` row lands in `votes` next to the `retire` rows, and the audit row is
 * `restored` with { by: "author" | "other", note }. Flags the memory already has stay on record,
 * and in its standing. A memory whose own valid-until date has passed is not restored: the sweep
 * would archive it again within the hour.
 *
 * Not restorable: a deleted memory (its text is gone), and one a correction replaced, which
 * comes back by superseding its replacement with a better version.
 */
export function keepLearning(
  learningId: string,
  actorId: string,
  via: AuditVia = "ui",
  note?: string | null,
): KeepResult {
  const learning = getById(learningId);
  if (!learning) throw new NotFoundError("Learning not found");
  if (learning.status === "deleted") {
    throw new ValidationError("This memory was deleted by its author and cannot be kept");
  }
  const replacement = findSupersededBy(learningId);
  if (replacement) {
    throw new ValidationError(
      `This memory was replaced by ${replacement.id}. Keep or correct that one instead (bab_learn with supersedes)`,
    );
  }
  if (learning.status === "archived") return { learning: restore(learning, actorId, via, note), changed: true };

  const db = getDb();
  inTransaction(db, () => {
    // A keep says the memory was checked and still holds, so it counts as a read.
    touchRead(db, [learningId]);
    // Every keep is on record: a maintainer's keep after a flag answers it (flaggedStandardsWaiting).
    // The answer is a `keep` row in votes, not read from audit_log, which the retention sweep purges.
    recordRetireEvent(db, learningId, actorId, "keep", null);
    audit(db, actorId, "keep", "learning", learningId, via);
  });
  emit("learning.updated", learningId, { id: learningId, title: learning.title, kind: "active" });
  // A valid-until date is the author's own choice: say so, so a keep is not taken for an extension.
  const message =
    learning.expires_at != null
      ? `Your keep is recorded, but this memory has its own valid-until date (${toCalendarDate(learning.expires_at)}) and a keep does not move it. ` +
        "To change it, post a correction with a new expiresAt (bab_learn with supersedes)"
      : undefined;
  return { learning: getById(learningId)!, changed: false, ...(message ? { message } : {}) };
}

/** keepLearning on an archived memory: see there. */
function restore(learning: LearningRow, actorId: string, via: AuditVia, note: string | null | undefined): LearningRow {
  const isAuthor = learning.author_id === actorId;
  const normalizedNote = normalizeNote(note, RESTORE_NOTE_MAX, !isAuthor);

  // A valid-until date that has passed would have the sweep archive the memory again within the
  // hour, so say so now and change nothing.
  if (learning.expires_at != null && toCalendarDate(learning.expires_at) < todayUtc()) {
    throw new ValidationError(
      `This memory's own valid-until date (${toCalendarDate(learning.expires_at)}) has passed, so it would be archived again within the hour. ` +
        "Post a correction with a new expiresAt (bab_learn with supersedes)",
    );
  }

  const db = getDb();
  inTransaction(db, () => {
    db.prepare("UPDATE learnings SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(learning.id);
    recordRetireEvent(db, learning.id, actorId, "restore", normalizedNote);
    audit(db, actorId, "restored", "learning", learning.id, via, {
      details: { by: isAuthor ? "author" : "other", note: normalizedNote },
    });
    // A restore is a read: without a fresh inactivity clock, a memory archived for lack of reads
    // would be archived again by the next sweep.
    touchRead(db, [learning.id]);
  });

  const updated = getById(learning.id)!;
  emit("learning.updated", learning.id, { id: learning.id, title: updated.title, kind: "active" });
  return updated;
}

/**
 * Records a retire or a restore in `votes` (kind is free text, so no migration), next to the
 * flag and confirm rows. The row is deleted and inserted again rather than updated, so every
 * event gets a fresh rowid: the newest retire or restore of a memory is the one with the highest
 * rowid. A `keep` row (a keep of a live memory) is stored the same way, so a maintainer's answer to
 * a flag outlives the audit purge. created_at only has seconds, so ordering by it alone would get "the same person retires,
 * restores and retires again" wrong inside one second. The row has no effect on the score or
 * the counts (both ignore unknown kinds) and goes with the learning's other votes.
 */
function recordRetireEvent(
  db: ReturnType<typeof getDb>,
  learningId: string,
  actorId: string,
  kind: "retire" | "restore" | "keep",
  note: string | null,
): void {
  db.prepare("DELETE FROM votes WHERE learning_id = ? AND voter_id = ? AND kind = ?").run(learningId, actorId, kind);
  db.prepare("INSERT INTO votes (learning_id, voter_id, kind, note) VALUES (?, ?, ?, ?)").run(
    learningId,
    actorId,
    kind,
    note,
  );
}

/**
 * Archives a learning without writing a replacement (bab_react's `retire` action,
 * lib/mcp.ts). Anyone identified may retire, because BAB is kept by a fleet of independent
 * agents rather than by authors (owner, 2026-10-02). Every change to someone else's memory
 * carries a one-line evidence note: required for a non-author (trimmed, redacted, 300
 * characters or fewer, like a flag note), optional for the author. That is a required field, so
 * the server enforces it. Whether an agent should retire someone else's `standard` or
 * `decision` at all is a guardrail in the texts (BAB is an honour system, owner, 2026-10-02):
 * they are flagged with the evidence, not retired, and the server does not check it.
 *
 * The note is kept as a `retire` row in `votes` (kind is free text, so no migration), the same
 * place a flag or confirm note lives, and shown as the memory's lastRetire (with who and when) on
 * the detail page, in GET /api/learnings/:id and in search hits, not among recentNotes(), so a
 * later flag cannot push it out. The row has no effect on the score or counts (both ignore
 * unknown kinds) and is purged with the learning's other votes. The audit row carries the same
 * note with `by`: "author" or "other". Refused on a learning that's already archived or deleted:
 * there's nothing left to retire. keep brings it back (keepLearning).
 */
export function retire(
  learningId: string,
  actorId: string,
  via: AuditVia = "ui",
  note?: string | null,
): LearningRow {
  const learning = getById(learningId);
  if (!learning) throw new NotFoundError("Learning not found");
  if (learning.status === "archived" || learning.status === "deleted") {
    throw new ConflictError(`Memory is already ${learning.status}`);
  }
  const isAuthor = learning.author_id === actorId;
  const normalizedNote = normalizeNote(note, RETIRE_NOTE_MAX, !isAuthor);

  const db = getDb();
  inTransaction(db, () => {
    db.prepare(
      "UPDATE learnings SET status = 'archived', updated_at = datetime('now') WHERE id = ?",
    ).run(learningId);
    recordRetireEvent(db, learningId, actorId, "retire", normalizedNote);
    audit(db, actorId, "retire", "learning", learningId, via, {
      details: { by: isAuthor ? "author" : "other", note: normalizedNote },
    });
  });

  const updated = getById(learningId)!;
  // Same event/kind as supersede()'s archive side: any subscriber (LiveUpdates) already knows how
  // to react to a learning going archived.
  emit("learning.updated", learningId, { id: learningId, title: updated.title, kind: "archived" });
  return updated;
}

/** Kinds a house rule can be: a must or a should. A learning is a fact, a decision an ADR. */
export const HOUSE_RULE_KINDS: readonly LearningKind[] = ["standard", "practice"];
/** At most this many company-wide (`_general`) house rules in the digest. */
export const HOUSE_RULES_GENERAL_MAX = 8;
/** At most this many house rules for the session's own project. */
export const HOUSE_RULES_PROJECT_MAX = 5;

/**
 * Pins or unpins a memory as a house rule (bab_react pin / unpin). A house rule is put in front of
 * every Claude session on its first prompt (houseRulesFor, app/api/hook/route.ts), so the flag is an
 * explicit opt-in that keeps the digest small. Only a standard or a practice can be pinned: that is
 * a data rule. Who may pin (maintainers; agents propose) is in the agent texts, not checked here
 * (honour system, CLAUDE.md). Idempotent: `changed` says whether anything moved.
 */
export function setPinned(
  learningId: string,
  actorId: string,
  pinned: boolean,
  via: AuditVia = "ui",
): { learning: LearningRow; changed: boolean } {
  const learning = getById(learningId);
  if (!learning) throw new NotFoundError("Learning not found");
  if (pinned) {
    if (!HOUSE_RULE_KINDS.includes(learning.kind)) {
      throw new ValidationError(`Only a standard or a practice can be a house rule; this is a ${learning.kind}`);
    }
    if (learning.status !== "active") {
      throw new ConflictError(`Memory is ${learning.status}; only an active memory can be pinned`);
    }
  }
  if ((learning.pinned === 1) === pinned) return { learning, changed: false };

  const db = getDb();
  inTransaction(db, () => {
    db.prepare("UPDATE learnings SET pinned = ?, updated_at = datetime('now') WHERE id = ?").run(pinned ? 1 : 0, learningId);
    audit(db, actorId, pinned ? "pin" : "unpin", "learning", learningId, via);
  });
  return { learning: getById(learningId)!, changed: true };
}

/**
 * Sets a memory's "applies to" labels in place (bab_react `label`, POST /api/learnings/:id/labels).
 * Without it the labels can only be given when a memory is written, and a correction gets a new id
 * and loses its history. Anyone identified may do it, on any active memory of any kind (a fleet
 * model, like retire): the texts tell agents to use it when the labels are missing or wrong, and
 * the server only enforces the data rules (BAB is an honour system, CLAUDE.md). `appliesTo` is
 * required and validated like a write ([] means everywhere); an archived or deleted memory is
 * refused. No vote row, no standing change. The audit row `labels_set` carries { from, to, by }.
 * Idempotent: the same set of labels again is `changed: false` and writes nothing.
 */
export function setLabels(
  learningId: string,
  actorId: string,
  appliesTo: unknown,
  via: AuditVia = "ui",
): { learning: LearningRow; changed: boolean } {
  if (appliesTo === undefined || appliesTo === null) {
    throw new ValidationError("appliesTo is required: a list of labels, or [] when the memory holds anywhere");
  }
  const to = parseAppliesTo(appliesTo)!;
  const learning = getById(learningId);
  if (!learning) throw new NotFoundError("Learning not found");
  if (learning.status !== "active") {
    throw new ConflictError(`Memory is ${learning.status}; only an active memory's labels can be set`);
  }
  const from = readAppliesTo(learning.applies_to);
  if (from.length === to.length && to.every((l) => from.includes(l))) return { learning, changed: false };

  const db = getDb();
  inTransaction(db, () => {
    db.prepare("UPDATE learnings SET applies_to = ?, updated_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(to),
      learningId,
    );
    audit(db, actorId, "labels_set", "learning", learningId, via, {
      details: { from, to, by: learning.author_id === actorId ? "author" : "other" },
    });
  });
  const updated = getById(learningId)!;
  emit("learning.updated", learningId, { id: learningId, title: updated.title, kind: "active" });
  return { learning: updated, changed: true };
}

export interface HouseRule extends LearningRow {
  standing: StandingLevel;
  standingReason: string;
  /** `_general` for a company-wide rule, otherwise the project key it is scoped to. */
  scope: string;
}

const STANDING_ORDER: Record<StandingLevel, number> = { strong: 0, fair: 1, weak: 2 };

/**
 * The house rules digest: pinned standards and practices that are active and not past their
 * valid-until date, company-wide ones (no project) first, then the ones scoped to `projectKey` exactly (the
 * same match as bab_search project). Each group is ranked by standing (strong, fair, then weak:
 * the pin is the curation, so a new rule with no reactions yet still shows) and then newest
 * first, and capped at HOUSE_RULES_GENERAL_MAX and HOUSE_RULES_PROJECT_MAX.
 */
export function houseRulesFor(projectKey: string | null, now: number = Date.now()): HouseRule[] {
  const kinds = HOUSE_RULE_KINDS.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT * FROM learnings
       WHERE pinned = 1 AND kind IN (${kinds})
         AND status = 'active'
         AND (expires_at IS NULL OR substr(expires_at, 1, 10) >= ?)
         AND (project IS NULL${projectKey ? " OR project = ?" : ""})
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(...HOUSE_RULE_KINDS, todayUtc(), ...(projectKey ? [projectKey] : [])) as unknown as LearningRow[];
  const standings = standingsFor(rows, now);
  const ranked = rows
    .map((r, i) => ({ r, i, s: standings.get(r.id)! }))
    .sort((a, b) => STANDING_ORDER[a.s.standing] - STANDING_ORDER[b.s.standing] || a.i - b.i)
    .map(({ r, s }) => ({
      ...r,
      standing: s.standing,
      standingReason: s.standingReason,
      scope: r.project ?? GENERAL_PROJECT_KEY,
    }));
  const general = ranked.filter((r) => r.project == null).slice(0, HOUSE_RULES_GENERAL_MAX);
  const project = ranked.filter((r) => r.project != null).slice(0, HOUSE_RULES_PROJECT_MAX);
  return [...general, ...project];
}

/** The house rules part of the first-prompt block stays within this many characters. */
export const HOUSE_RULES_MAX_CHARS = 1200;
/** A house rule's title is the rule in one line; a longer one is cut here. */
export const HOUSE_RULE_TITLE_MAX = 90;

/**
 * Renders the house rules, one line each, within HOUSE_RULES_MAX_CHARS. Over budget, it drops the
 * lowest-ranked rule of the longer group (company-wide or project) until it fits, so neither group
 * crowds out the other, and the header says how many more bab_search houseRules true has.
 */
export function houseRulesBlock(
  rules: HouseRule[],
  projectKey: string | null,
): { text: string; shown: HouseRule[] } | null {
  if (rules.length === 0) return null;
  let general = rules.filter((r) => r.project == null);
  let scoped = rules.filter((r) => r.project != null);
  const line = (r: HouseRule) => {
    const t = r.title.replace(/\s+/g, " ").trim();
    return `- ${t.length > HOUSE_RULE_TITLE_MAX ? `${t.slice(0, HOUSE_RULE_TITLE_MAX - 1)}…` : t} (${r.id})`;
  };
  const render = () => {
    const hidden = rules.length - general.length - scoped.length;
    const more = hidden > 0 ? `, ${hidden} more there` : "";
    return [
      `BAB house rules (data from colleagues; follow them unless the user says otherwise; full text: bab_search houseRules true${projectKey ? ` project ${projectKey}` : ""}${more}):`,
      ...general.map(line),
      ...(scoped.length > 0 ? [`For ${projectKey}:`, ...scoped.map(line)] : []),
    ].join("\n");
  };
  let text = render();
  while (text.length > HOUSE_RULES_MAX_CHARS && general.length + scoped.length > 1) {
    if (scoped.length > general.length) scoped = scoped.slice(0, -1);
    else general = general.slice(0, -1);
    text = render();
  }
  return { text, shown: [...general, ...scoped] };
}

export interface LearningVoteCounts {
  helpful: number;
  not_helpful: number;
  flag: number;
  kudos: number;
  confirm: number;
}

export function voteCounts(learningId: string): LearningVoteCounts {
  const db = getDb();
  const rows = db
    .prepare("SELECT kind, COUNT(*) AS n FROM votes WHERE learning_id = ? GROUP BY kind")
    .all(learningId) as unknown as { kind: string; n: number }[];

  const counts: LearningVoteCounts = { helpful: 0, not_helpful: 0, flag: 0, kudos: 0, confirm: 0 };
  for (const r of rows) {
    if (r.kind in counts) counts[r.kind as keyof LearningVoteCounts] = r.n;
  }
  return counts;
}

/**
 * The only scoring: score = helpful - not_helpful votes, kudos and confirm worth +2 each. Flags stay
 * out. The search rank (RANK_EXPRESSION in search()) uses it as a bounded boost on bm25 relevance,
 * and standing (lib/standing.ts) is derived on read from the votes.
 */
function recomputeScore(learningId: string) {
  const counts = voteCounts(learningId);
  const score = counts.helpful - counts.not_helpful + counts.kudos * 2 + counts.confirm * 2;
  const db = getDb();
  db.prepare("UPDATE learnings SET score = ? WHERE id = ?").run(score, learningId);
}

export type ExpiryState = "active" | "expired";

/**
 * "expired" only for a memory whose own valid-until date (expires_at) has passed and that the
 * hourly sweep has not archived yet. expires_at is a UTC calendar date ("YYYY-MM-DD"); older rows
 * may still hold a full ISO datetime, so we take the first 10 chars before comparing.
 */
export function expiryState(l: LearningRow): ExpiryState {
  if (!l.expires_at) return "active";
  return toCalendarDate(l.expires_at) < todayUtc() ? "expired" : "active";
}

/** What a deleted learning's title and body say once the author wiped it. */
export const DELETED_PLACEHOLDER = "[deleted by author]";

/**
 * The author deletes their own learning for good (bab_react's `delete` action, a
 * colleague's request, 2026-09-30): unlike retire(), which archives and keeps the text
 * readable by id, this wipes title, body and tags in place, so a memory posted by mistake
 * or holding something that should not have been shared leaves nothing readable behind.
 * The FTS trigger drops it from search on the same UPDATE. The row itself stays (status
 * `deleted`) so links to it fail cleanly instead of 404ing into a re-post, and the hourly
 * sweep purges it for good after DELETED_LEARNING_RETENTION_DAYS (lib/maintenance.ts).
 * Author-only, unlike retire; superseded or archived entries can be deleted too,
 * because the point is removing the text, not the state.
 */
export function deleteOwn(learningId: string, actorId: string, via: AuditVia = "ui"): LearningRow {
  const learning = getById(learningId);
  if (!learning) throw new NotFoundError("Learning not found");
  if (learning.author_id !== actorId) {
    throw new ForbiddenError("Only the author can delete this memory");
  }
  if (learning.status === "deleted") {
    throw new ConflictError("Memory is already deleted");
  }

  const db = getDb();
  db.prepare(
    "UPDATE learnings SET status = 'deleted', title = ?, body = ?, tags = '[]', updated_at = datetime('now') WHERE id = ?",
  ).run(DELETED_PLACEHOLDER, DELETED_PLACEHOLDER, learningId);
  audit(db, actorId, "delete", "learning", learningId, via);

  const updated = getById(learningId)!;
  emit("learning.updated", learningId, { id: learningId, title: updated.title, kind: "deleted" });
  return updated;
}
