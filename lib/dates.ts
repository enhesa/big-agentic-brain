/**
 * Calendar-date helpers. The memory stores due_at/expires_at as date-only
 * strings ("YYYY-MM-DD") and treats them as UTC calendar days — no time
 * component, no timezone conversion. All comparisons happen as plain
 * string/lexical comparisons on that format.
 */

/** Today's UTC calendar date as "YYYY-MM-DD". */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a real "YYYY-MM-DD" calendar day. The format alone lets 2026-13-01 and 2026-02-30
 * through, and a due or expiry date that no day ever reaches is silently lost; so the string
 * must also survive a round trip through a UTC Date.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !CALENDAR_DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Adds `days` (may be negative) to a "YYYY-MM-DD" date string, in UTC. */
export function addDaysUtc(dateStr: string, days: number): string {
  const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Normalizes any stored value (legacy full ISO datetime or date-only) to "YYYY-MM-DD". */
export function toCalendarDate(value: string): string {
  return value.slice(0, 10);
}

/**
 * Parses a timestamp as stored by SQLite's datetime('now'): "YYYY-MM-DD HH:MM:SS" in UTC
 * with no zone marker. `new Date()` would read that as LOCAL time and shift every
 * displayed time by the server's or browser's offset; this pins it to UTC. Values that
 * already carry a zone (ISO with Z/offset) are parsed as-is.
 */
export function parseDbTime(value: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/.exec(value);
  return m ? new Date(`${m[1]}T${m[2]}Z`) : new Date(value);
}

/** Time zone marker a due date-time must carry: Z or a numeric offset. */
const DUE_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** What a due date-time must look like, for error texts. */
export const DUE_AT_FORM =
  "YYYY-MM-DD, or an ISO 8601 date-time with an offset or Z, e.g. 2026-10-21T16:00:00-04:00";

/** A parsed reminder due value: a stored string and whether it carries a time of day. */
export interface ParsedDueAt {
  /** "YYYY-MM-DD" (date-only) or "YYYY-MM-DDTHH:MM:SSZ" (an instant in UTC). */
  dueAt: string;
  hasTime: boolean;
}

/** Now as "YYYY-MM-DDTHH:MM:SSZ", the format of a timed due_at (compares lexically). */
export function nowUtcInstant(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Parses a reminder's dueAt: a real "YYYY-MM-DD" day, or an ISO 8601 date-time WITH an offset or Z,
 * stored as a UTC instant. A date-time with no offset is refused, because the server cannot know
 * whose clock it was written on. Returns null for anything else; the caller names DUE_AT_FORM.
 */
export function parseDueAt(value: unknown): ParsedDueAt | null {
  if (isCalendarDate(value)) return { dueAt: value, hasTime: false };
  if (typeof value !== "string") return null;
  const m = DUE_DATETIME_RE.exec(value);
  if (!m) return null;
  const [, date, hh, mm, ss] = m;
  if (!isCalendarDate(date) || Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return { dueAt: new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"), hasTime: true };
}
