/**
 * In-memory per-actor rate limit. Single replica (see docs/spec.md
 * "Architecture"), so process memory is a fine store — no Redis.
 *
 * These only stop a runaway loop (owner, 2026-10-02: raise them a lot). They
 * are the one source of the numbers: every error text that states a limit is built from them.
 */

const WINDOW_MS = 60_000;
/** Requests a person's agent may make a minute (was 120). */
export const RATE_LIMIT_PER_MINUTE = 2000;
/** The browser routes' own bucket, same size, so a busy agent cannot starve the person's clicks (was 120). */
export const UI_RATE_LIMIT_PER_MINUTE = 2000;
/** Requests a minute from one address that no identity could be resolved for (was the general 120). */
export const ANON_RATE_LIMIT_PER_MINUTE = 1000;
/**
 * Requests a minute, process-wide, for anonymous /mcp calls that have no verified per-caller key
 * (no BAB_CLIENT_IP_HEADER and no Mcp-Session-Id). A constant, not configurable.
 */
export const ANON_GLOBAL_LIMIT_PER_MINUTE = 3000;
/** New identities one address may create an hour from declared headers, before any identity exists (keyed by IP). */
export const ANON_NEW_IDENTITIES_PER_HOUR = 60;
const HOUR_MS = 3_600_000;
const LIMIT = RATE_LIMIT_PER_MINUTE;

interface Bucket {
  count: number;
  windowStart: number;
  windowMs: number;
}

const buckets = new Map<string, Bucket>();

let clock: () => number = () => Date.now();

// Without pruning, one bucket per distinct actorId ever seen sits in memory
// forever (an unbounded-growth leak for a long-lived single-replica
// process). Sweep stale (expired-window) buckets every PRUNE_INTERVAL_HITS
// calls instead of on every call, so the prune itself stays cheap.
const PRUNE_INTERVAL_HITS = 500;
let hitsSinceLastPrune = 0;

function pruneStaleBuckets(now: number) {
  for (const [actorId, bucket] of buckets) {
    if (now - bucket.windowStart >= bucket.windowMs) buckets.delete(actorId);
  }
}

/**
 * The same limit in a bucket of its own, for the browser routes under /inbox. The agent API
 * spends the plain bucket under the same person's id, so a busy agent session must not be able
 * to 429 that person's own "Mark as read" click (or the nav badge poll).
 */
export function checkUiRateLimit(actorId: string): boolean {
  return checkRateLimit(`ui:${actorId}`, UI_RATE_LIMIT_PER_MINUTE);
}

/** True while this address may still create a new identity from declared headers this hour. */
export function checkAnonNewIdentity(ip: string | null): boolean {
  // No resolvable address: nothing to key on, and a shared "unknown" bucket would let one caller lock out all the others.
  if (ip === null) return true;
  return checkRateLimit(`anon-new:${ip}`, ANON_NEW_IDENTITIES_PER_HOUR, HOUR_MS);
}

/** True if this request is allowed; false once the key is over `limit` (default: the general one) for the current window. */
export function checkRateLimit(actorId: string, limit: number = LIMIT, windowMs: number = WINDOW_MS): boolean {
  const now = clock();

  hitsSinceLastPrune += 1;
  if (hitsSinceLastPrune >= PRUNE_INTERVAL_HITS) {
    hitsSinceLastPrune = 0;
    pruneStaleBuckets(now);
  }

  const bucket = buckets.get(actorId);

  if (!bucket || now - bucket.windowStart >= bucket.windowMs) {
    buckets.set(actorId, { count: 1, windowStart: now, windowMs });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= limit;
}

/** Test-only: inject a fake clock so a test can advance past the window without sleeping. */
export function _setClockForTests(fn: () => number): void {
  clock = fn;
}

/** Test-only: clears all buckets and restores the real clock. */
export function resetForTests(): void {
  buckets.clear();
  clock = () => Date.now();
  hitsSinceLastPrune = 0;
}

/** Test-only: number of buckets currently held (to assert pruning actually shrinks memory). */
export function _bucketCountForTests(): number {
  return buckets.size;
}

