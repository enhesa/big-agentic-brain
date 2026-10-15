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
