/**
 * In-process realtime event bus for the read-only web UI (docs/spec.md
 * "Realtime"). Single replica (see docs/spec.md "Architecture"), so an
 * in-memory pub/sub plus a bounded ring buffer is enough — no Redis, no
 * websockets. `app/api/events/route.ts` turns this into Server-Sent Events;
 * `app/components/shell/LiveUpdates.tsx` is the browser side.
 */

export type BabEventType =
  | "learning.created"
  | "learning.updated"
  | "message.created"
  | "todo.changed"
  | "kudos"
  | "vote"
  | "flag"
  | "feedback.created"
  | "feedback.updated";

/**
 * Kept intentionally small: ids, learning titles, a kind. Never a body, a message
 * subject or snippet, or a person name (P0.3, 2026-10-01): /api/events is a public path (no SSO),
 * so every field here is readable by anyone who can reach the host.
 */
export interface BabEventPayload {
  id?: string;
  title?: string;
  snippet?: string;
  kind?: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface BabEvent {
  /** Monotonically increasing within this process; also the SSE id. */
  seq: number;
  type: BabEventType;
  /** Domain id of the thing the event is about (learning id, thread id, todo id, user id...). */
  id: string;
  at: string;
  payload: BabEventPayload;
}

export type Unsubscribe = () => void;

const RING_BUFFER_SIZE = 200;
const SNIPPET_MAX = 140;

let nextSeq = 1;
const ring: BabEvent[] = [];
const subscribers = new Set<(event: BabEvent) => void>();

/** Truncates a snippet field to SNIPPET_MAX chars, if present. Never throws on missing/short input. */
function clampSnippet(payload: BabEventPayload): BabEventPayload {
  if (typeof payload.snippet !== "string" || payload.snippet.length <= SNIPPET_MAX) return payload;
  return { ...payload, snippet: payload.snippet.slice(0, SNIPPET_MAX) };
}

/**
 * Publishes one event: assigns it the next sequence number, appends it to
 * the ring buffer (dropping the oldest once over RING_BUFFER_SIZE), and
 * fans it out to every live subscriber. A subscriber callback throwing
 * never breaks the publish or other subscribers.
 */
export function emit(type: BabEventType, id: string, payload: BabEventPayload = {}): BabEvent {
  const event: BabEvent = {
    seq: nextSeq++,
    type,
    id,
    at: new Date().toISOString(),
    payload: clampSnippet(payload),
  };

  ring.push(event);
  if (ring.length > RING_BUFFER_SIZE) ring.shift();

  for (const fn of subscribers) {
    try {
      fn(event);
    } catch (err) {
      console.error("bab event subscriber failed", err);
    }
  }

  return event;
}

/** Subscribes to every future event. Returns an unsubscribe function. */
export function subscribe(fn: (event: BabEvent) => void): Unsubscribe {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * Events strictly after `lastSeq` (e.g. a reconnecting client's
 * Last-Event-ID), oldest first. If `lastSeq` is older than everything still
 * in the ring (buffer wrapped while the client was away), returns the whole
 * buffer — the client missed some history either way, so give it what's
 * left rather than nothing.
 */
export function eventsSince(lastSeq: number): BabEvent[] {
  return ring.filter((e) => e.seq > lastSeq);
}

/** Test-only: clears the ring buffer, subscriber set and sequence counter. */
export function _resetEventsForTests(): void {
  ring.length = 0;
  subscribers.clear();
  nextSeq = 1;
}
