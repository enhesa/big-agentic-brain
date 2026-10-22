export interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  roles: string | null;
  created_at: string;
  last_seen_at: string;
  trust: number;
  /** One of the team tags (BAB_TEAM_TAGS, see lib/teams.ts), or null. */
  home_team: string | null;
}

/**
 * What may leave the server about a user (publicUser in lib/users.ts): an allowlist, so a column
 * added to the table later is not exposed until someone decides it should be.
 */
export type PublicUser = Pick<UserRow, "id" | "email" | "name" | "roles" | "created_at" | "last_seen_at" | "trust">;

export type LearningStatus = "active" | "archived" | "deleted";
export type LearningConfidence = "low" | "medium" | "high";

/** practice = should, standard = must, decision = an ADR (what was chosen, why, what was rejected). */
export type LearningKind = "learning" | "practice" | "standard" | "decision";
/** confluence = a mirror of a Confluence page, carrying source_url and source_version. */
export type LearningSource = "native" | "confluence";

export interface LearningRow {
  id: string;
  author_id: string;
  title: string;
  body: string;
  tags: string; // JSON array
  repo: string | null;
  /** Normalized scope key (repo, client, campaign, product, system): see normalizeProjectKey() in lib/learnings.ts. */
  project: string | null;
  confidence: LearningConfidence;
  status: LearningStatus;
  /**
   * The author's own valid-until date (YYYY-MM-DD) for a time-bound fact, or null (the default:
   * memories do not expire). The hourly sweep archives the memory once it has passed.
   */
  expires_at: string | null;
  /** 1 when expires_at is a date the author chose (create() sets it); migration v40 cleared every date with 0. */
  expires_explicit: number;
  /**
   * When an AGENT last read this memory (first read of that UTC day), or null if none has since
   * reads were recorded (migration v40). Humans opening a web page do not count. See touchRead in
   * lib/learnings.ts.
   */
  last_accessed_at: string | null;
  /** How many distinct UTC days an agent read this memory, since reads were recorded. */
  access_days: number;
  supersedes_id: string | null;
  score: number;
  kind: LearningKind;
  source: LearningSource;
  source_url: string | null;
  source_version: number | null;
  /** Model id the author declared when writing (self-declared, lowercase), or null. Not an input to standing or confidence. */
  model: string | null;
  /** JSON array of stack or platform labels the memory holds for (lib/applies-to.ts); '[]' means everywhere. */
  applies_to: string;
  /** JSON array of other wordings, symptoms and error strings an author listed so the memory is found by them; '[]' for none. Indexed in search, never shown by the hook. */
  aliases: string;
  /** 1 when the memory is a house rule (a pinned standard or practice), 0 otherwise. See houseRulesFor in lib/learnings.ts. */
  pinned: number;
  /** Who pinned it and when (UTC, SQLite datetime); NULL when unpinned or pinned before migration v43. */
  pinned_by: string | null;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
}

export type VoteKind = "helpful" | "not_helpful" | "flag" | "cited" | "kudos" | "confirm";

export interface VoteRow {
  learning_id: string;
  voter_id: string;
  kind: VoteKind;
  created_at: string;
  note: string | null;
}

export type TodoStatus = "open" | "done" | "snoozed" | "abandoned";

export interface TodoRow {
  id: string;
  owner_id: string;
  title: string;
  body: string | null;
  due_at: string | null;
  /** 1 when due_at is a UTC instant ("...T..Z"); 0 when it is a date-only day. */
  due_has_time: number;
  status: TodoStatus;
  related_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThreadRow {
  id: string;
  subject: string | null;
  created_by: string;
  created_at: string;
  lease_json: string | null;
}

export type MessageKind = "human" | "auto";

/** A collaborative request attached to a message. Everything optional except kind and goal. */
export interface MessageRequest {
  kind: string; // short lowercase slug, e.g. "review-pr", "review-doc", "pair", "question"; 1-40 chars, /^[a-z0-9][a-z0-9-]*$/
  goal: string; // one or two sentences, what the recipient should do; 1-2000 chars
  repo?: string; // repository URL or slug the work concerns, e.g. "https://git.example.com/team/bab.git" or "acmecorp/acme.export.api"; <=300 chars
  ref?: string; // branch, tag, commit or PR URL; <=300 chars
  cwd?: string; // SUGGESTED folder NAME (not an absolute path), e.g. "bab"; <=120 chars, no path separators
  links?: string[]; // up to 5 URLs (<=500 chars each) with more context
}

export interface MessageRow {
  id: string;
  thread_id: string;
  from_id: string;
  to_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
  kind: MessageKind;
  request: string | null;
}

export type SessionStatus = "active" | "idle" | "busy" | "ended";

/** A linked Claude Code session (lib/sessions.ts): whose it is, for the hook. */
export interface SessionRow {
  id: string;
  owner_id: string;
  status: SessionStatus;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  /** Linked UserPromptSubmit hooks since the owner last called bab_learn (migration v21). */
  prompts_since_learn: number;
}

export interface ThreadLease {
  actorId: string;
  turnsLeft: number;
  expiresAt: string;
}

export type AuditVia = "ui" | "mcp";

export interface AuditLogRow {
  id: number;
  actor_id: string;
  action: string;
  entity: string;
  entity_id: string;
  via: AuditVia;
  at: string;
}
