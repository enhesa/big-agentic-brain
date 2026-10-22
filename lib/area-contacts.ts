import { getDb } from "./db";
import { audit } from "./audit";
import { ForbiddenError, ValidationError } from "./errors";
import { isMaintainer } from "./feedback";
import { redact } from "./redact";
import { normalizeTokens } from "./similarity";
import { isTeamTag, teamTags } from "./teams";
import { getUser } from "./users";
import type { AuditVia } from "./types";

/**
 * A person's home team and the knowledge areas they volunteered to be a contact for. Both are the
 * person's own opt-in and can be changed or removed at any time. A maintainer may also remove
 * someone from an area (cleanup), never add them. The home team is kept apart from post tags: a
 * tag says what a memory is about, the home team says where the person works.
 */

export const AREA_MAX = 40;
export const AREA_NOTE_MAX = 200;
/** Contacts listed per area, and areas one person may be a contact for. */
export const CONTACTS_PER_AREA_MAX = 3;
export const AREAS_PER_PERSON_MAX = 10;
/** Contacts a search with no answer suggests. */
export const SEARCH_CONTACTS_MAX = 3;

/** Sent with the contacts a search with no answer found (bab_search and GET /api/learnings). */
export const CONTACTS_HINT =
  "BAB has no answer. These people volunteered as contacts for the area: suggest one to the user, or with the user's yes send only that person the question (bab_send). " +
  "When the answer comes back and others could reuse it, save it with bab_learn.";

/** A part of a hyphenated area must be at least this long, and not a very common word, to match on its own. */
const PART_MIN = 4;
const COMMON_WORDS = new Set([
  "data", "code", "file", "files", "tool", "tools", "team", "work", "make", "using", "issue", "problem",
  "error", "check", "need", "help", "does", "should", "would", "could", "project", "system", "process",
]);

export interface AreaContact {
  area: string;
  id: string;
  name: string | null;
  note: string | null;
}

export interface MyArea {
  area: string;
  note: string | null;
}

/**
 * A free label as a stable key: lowercased, every run of other characters becomes one hyphen
 * ("Regulatory lists" -> "regulatory-lists"), at most AREA_MAX characters.
 */
export function normalizeArea(raw: unknown): string {
  const text = String(raw ?? "");
  // Labels are public (/usage, /api/people): an email or a token must not become one.
  if (redact(text) !== text) throw new ValidationError("area must not contain an email address, a token or other personal data");
  const area = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!area) throw new ValidationError("area is required (letters and digits, for example toxicology)");
  if (area.length > AREA_MAX) throw new ValidationError(`area must be ${AREA_MAX} characters or fewer`);
  return area;
}

function normalizeNote(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (text.length > AREA_NOTE_MAX) throw new ValidationError(`note must be ${AREA_NOTE_MAX} characters or fewer`);
  const note = redact(text);
  if (!note) return null;
  if (note.length > AREA_NOTE_MAX) throw new ValidationError(`note must be ${AREA_NOTE_MAX} characters or fewer`);
  return note;
}

/** Refuses an id with no users row, instead of a silent no-op or a raw foreign-key error. */
function requireUser(userId: string): void {
  if (!getUser(userId)) throw new ValidationError("BAB does not know you yet: identify first (bab_identify) and try again");
}

/** Sets the person's home team to one of the team tags. An explicit null or "" clears it; undefined (a missing key) is an error. */
export function setHomeTeam(userId: string, team: unknown, via: AuditVia): string | null {
  if (team === undefined) throw new ValidationError("team is required (a team tag, or an empty string to clear it)");
  requireUser(userId);
  const raw = team === null ? "" : String(team).trim().toLowerCase();
  const current = getUser(userId)?.home_team ?? null;
  // An unchanged value is always accepted, even when its team has left the configured list.
  if (raw && raw !== current && !isTeamTag(raw)) {
    throw new ValidationError(`team must be one of ${teamTags().join(", ")}`);
  }
  const next = raw || null;
  const db = getDb();
  const from = current;
  db.prepare("UPDATE users SET home_team = ? WHERE id = ?").run(next, userId);
  audit(db, userId, "home_team_set", "user", userId, via, { details: { from, to: next } });
  return next;
}

/** Makes the person a contact for an area; the same area again only changes the note. */
export function addAreaContact(userId: string, areaRaw: unknown, noteRaw: unknown, via: AuditVia): MyArea {
  const area = normalizeArea(areaRaw);
  const note = normalizeNote(noteRaw);
  requireUser(userId);
  const db = getDb();
  const has = db.prepare("SELECT 1 FROM area_contacts WHERE area = ? AND user_id = ?").get(area, userId);
  if (!has) {
    const mine = (db.prepare("SELECT COUNT(*) AS n FROM area_contacts WHERE user_id = ?").get(userId) as { n: number }).n;
    if (mine >= AREAS_PER_PERSON_MAX) {
      throw new ValidationError(`You are already a contact for ${AREAS_PER_PERSON_MAX} areas; remove one first`);
    }
    const taken = (db.prepare("SELECT COUNT(*) AS n FROM area_contacts WHERE area = ?").get(area) as { n: number }).n;
    if (taken >= CONTACTS_PER_AREA_MAX) {
      throw new ValidationError(`${area} already has ${CONTACTS_PER_AREA_MAX} contacts; ask one to step down first`);
    }
  }
  db.prepare(
    `INSERT INTO area_contacts (area, user_id, note) VALUES (?, ?, ?)
     ON CONFLICT(area, user_id) DO UPDATE SET note = excluded.note`,
  ).run(area, userId, note);
  audit(db, userId, has ? "area_contact_update" : "area_contact_add", "area_contact", area, via, { details: { area, note } });
  return { area, note };
}

/**
 * Removes a contact. A person removes themselves; a maintainer may remove anyone (`targetId`).
 * Returns false when there was nothing to remove.
 */
export function removeAreaContact(actorId: string, areaRaw: unknown, targetId: string | undefined, via: AuditVia): boolean {
  const area = normalizeArea(areaRaw);
  const target = targetId?.trim().toLowerCase() || actorId;
  if (target !== actorId && !isMaintainer(actorId)) {
    throw new ForbiddenError("Only maintainers can remove someone else from an area");
  }
  const db = getDb();
  const removed = db.prepare("DELETE FROM area_contacts WHERE area = ? AND user_id = ?").run(area, target).changes > 0;
  if (removed) audit(db, actorId, "area_contact_remove", "area_contact", area, via, { details: { area, userId: target } });
  return removed;
}

/** The contacts for one area, oldest sign-up first. */
export function contactsForArea(areaRaw: unknown): AreaContact[] {
  const area = normalizeArea(areaRaw);
  return getDb()
    .prepare(
      `SELECT c.area, c.user_id AS id, u.name, c.note FROM area_contacts c JOIN users u ON u.id = c.user_id
       WHERE c.area = ? ORDER BY c.created_at, c.user_id`,
    )
    .all(area) as unknown as AreaContact[];
}

/** One person's areas, alphabetical. */
export function areasOf(userId: string): MyArea[] {
  return getDb()
    .prepare("SELECT area, note FROM area_contacts WHERE user_id = ? ORDER BY area")
    .all(userId) as unknown as MyArea[];
}

/** Every person's areas in one query, keyed by user id (the directory). */
export function areasByUser(): Map<string, MyArea[]> {
  const rows = getDb()
    .prepare("SELECT user_id AS userId, area, note FROM area_contacts ORDER BY area")
    .all() as unknown as Array<{ userId: string; area: string; note: string | null }>;
  const map = new Map<string, MyArea[]>();
  for (const r of rows) map.set(r.userId, [...(map.get(r.userId) ?? []), { area: r.area, note: r.note }]);
  return map;
}

/**
 * Contacts to suggest when a search found nothing: those whose area is a search word or the tag
 * filter, whole or as one hyphen-separated part of 4+ characters that is not a very common word ("lists" fits regulatory-lists, "data" does not fit data-science). At most
 * SEARCH_CONTACTS_MAX, best match first: a whole-area match before a partial one.
 */
export function contactsForSearch(query: string, tag?: string): AreaContact[] {
  // Stopwords and short words drop out (the same list the search index uses). A whole word with
  // a hyphen ("regulatory-lists") is also tried as a whole area.
  const keys = new Set(normalizeTokens(query));
  for (const w of query.toLowerCase().split(/\s+/)) {
    const whole = w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (whole.includes("-") && whole.length >= 3) keys.add(whole);
  }
  if (tag) {
    try {
      keys.add(normalizeArea(tag));
    } catch {
      // a tag that is not a usable area matches nothing
    }
  }
  if (keys.size === 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT c.area, c.user_id AS id, u.name, c.note FROM area_contacts c JOIN users u ON u.id = c.user_id
       ORDER BY c.created_at, c.user_id`,
    )
    .all() as unknown as AreaContact[];
  const partMatch = (area: string) =>
    area.split("-").some((p) => p.length >= PART_MIN && !COMMON_WORDS.has(p) && keys.has(p));
  const scored = rows
    .map((r) => ({ r, score: keys.has(r.area) ? 2 : partMatch(r.area) ? 1 : 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, SEARCH_CONTACTS_MAX).map((x) => x.r);
}
