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
