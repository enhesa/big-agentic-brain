import { createHash } from "node:crypto";

/**
 * The "signed-in viewer has no long-form email" warning, at most once per viewer per hour.
 *
 * Every page render resolves the viewer, often more than once, so an unlinked viewer who browses
 * for a minute used to fill the log with the same line. Now each distinct viewer is noted once an
 * hour, with how often they were seen since their last note and how many such viewers there were
 * in the last hour.
 *
 * The key is a sha256 of the sign-in id, kept in memory only. Neither the id, the address nor the
 * hash is ever logged: a hash of a short alias is easy to reverse with a list of names.
 */

export const UNLINKED_VIEWER_LOG_WINDOW_MS = 60 * 60 * 1000;
/** How long a viewer is remembered, so one who comes back after an hour still gets their count. */
export const UNLINKED_VIEWER_LOG_KEEP_MS = 24 * UNLINKED_VIEWER_LOG_WINDOW_MS;
/** Past this many tracked viewers the oldest are dropped, so the map cannot grow without bound. */
export const UNLINKED_VIEWER_LOG_MAX_KEYS = 5000;

type Seen = { loggedAt: number; since: number };
const seen = new Map<string, Seen>();

function keyFor(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

function prune(now: number): void {
  for (const [k, v] of seen) {
    if (now - v.loggedAt >= UNLINKED_VIEWER_LOG_KEEP_MS) seen.delete(k);
  }
  // Map keeps insertion order, and a re-noted viewer is re-inserted, so the first keys are the oldest.
  while (seen.size > UNLINKED_VIEWER_LOG_MAX_KEYS) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/**
 * Notes a signed-in viewer BAB could not key on a long-form email. `identity` is any stable id
 * of the viewer (the sign-in id); `reason` is a fixed shape word, never the address.
 * Returns the line it logged, or null when this viewer was already noted in the last hour.
 */
export function noteUnlinkedViewer(identity: string, reason: string, now: number = Date.now()): string | null {
  const key = keyFor(identity);
  const prev = seen.get(key);
  if (prev && now - prev.loggedAt < UNLINKED_VIEWER_LOG_WINDOW_MS) {
    prev.since += 1;
    return null;
  }
  seen.delete(key);
  seen.set(key, { loggedAt: now, since: 0 });
  prune(now);
  const repeats = prev ? `; this viewer was seen ${prev.since + 1} times since their last note` : "";
  let lastHour = 0;
  for (const v of seen.values()) if (now - v.loggedAt < UNLINKED_VIEWER_LOG_WINDOW_MS) lastHour += 1;
  const line =
    `bab: signed-in viewer has no long-form email (${reason})${repeats}; ` +
    `${lastHour} such viewer${lastHour === 1 ? "" : "s"} in the last hour. Logged once per viewer per hour.`;
  console.warn(line);
  return line;
}

/** Tests only. */
export function _resetUnlinkedViewerLogForTests(): void {
  seen.clear();
}
