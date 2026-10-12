import { parseDbTime } from "@/lib/dates";
import { formatDate } from "./branding";
/**
 * Human-friendly relative time for the Conversations browser ("3 min ago"),
 * falling back to a plain date once it's more than a week old. `now` is
 * injectable for deterministic tests.
 */
export function formatRelativeTime(dateStr: string, now: number = Date.now()): string {
  const then = parseDbTime(dateStr).getTime();
  if (Number.isNaN(then)) return dateStr;

  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} hr ago`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;

  return formatDate(parseDbTime(dateStr));
}

function pluralDays(n: number): string {
  return `${n} day${n === 1 ? "" : "s"}`;
}

/**
 * Coarse "how long ago" phrasing for a memory's age (`ageDays`, see
 * lib/learnings.ts's ageInfo()). Unlike formatRelativeTime above — built for a chat
 * timestamp, tops out at "N days ago" — a memory routinely lives for months and
 * years, so this scales up to months and years.
 */
export function formatAge(ageDays: number): string {
  if (ageDays < 1) return "today";
  if (ageDays < 30) return `${pluralDays(ageDays)} ago`;
  if (ageDays < 365) {
    const months = Math.max(1, Math.round(ageDays / 30));
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.max(1, Math.round(ageDays / 365));
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * "valid for N more days" / "valid until today" / "past its valid-until date" for a memory's
 * `expiresInDays` (see lib/learnings.ts's ageInfo()); null (no valid-until date) has nothing to
 * show. The wording matches the "Valid until" fact on the detail page; this only gets a day count.
 */
export function formatExpiry(expiresInDays: number | null): string | null {
  if (expiresInDays == null) return null;
  if (expiresInDays < 0) return "past its valid-until date";
  if (expiresInDays === 0) return "valid until today";
  return `valid for ${expiresInDays} more day${expiresInDays === 1 ? "" : "s"}`;
}
