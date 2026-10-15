import { clientIp, clientIpVerified } from "@/lib/client-ip";
import { subscribe, eventsSince, type BabEvent, type BabEventType } from "@/lib/events";

/** Plain `Request` (not `NextRequest`): the route only needs headers/url/signal, and tests construct it that way. */
type EventsRequest = { headers: Headers; url: string; signal: AbortSignal };

export const dynamic = "force-dynamic";

const DEFAULT_PING_INTERVAL_MS = 20_000;
export const MAX_CONCURRENT_CONNECTIONS = 1000;
/** Open streams one address may hold; a runaway client must not eat the global cap. */
export const MAX_CONNECTIONS_PER_IP = 20;

let pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
let openConnections = 0;
const perIp = new Map<string, number>();

/** Test-only: shortens the ping interval so a test doesn't wait 20s for one. */
export function _setPingIntervalMsForTests(ms: number): void {
  pingIntervalMs = ms;
}

/** Test-only: resets ping interval and the open-connection counter. */
export function _resetEventsRouteForTests(): void {
  pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
  openConnections = 0;
  perIp.clear();
}

/** Test-only: forces the open-connection counter, to exercise the 503 cap without opening 100 real streams. */
export function _setOpenConnectionsForTests(n: number): void {
  openConnections = n;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function formatEvent(event: BabEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function parseLastEventId(req: EventsRequest): number {
  // ?since=<seq> is a convenience for manual testing / curl; a real
  // EventSource reconnect sends Last-Event-ID instead.
  const headerVal = req.headers.get("last-event-id");
  const queryVal = new URL(req.url).searchParams.get("since");
  const raw = headerVal ?? queryVal;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function parseTopics(req: EventsRequest): Set<BabEventType> | null {
  const raw = new URL(req.url).searchParams.get("topics");
  if (!raw) return null;
  const topics = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean) as BabEventType[];
  return topics.length > 0 ? new Set(topics) : null;
}

function retryLater(): Response {
  return Response.json(
    { error: "Too many concurrent /api/events connections; retry shortly" },
    { status: 503, headers: { "Retry-After": "5" } },
  );
}

/**
 * GET /api/events — Server-Sent Events for the read-only web UI (docs/spec.md
 * "Realtime"). One long HTTP response, not a websocket upgrade: the app is a
 * single process and websockets often do not pass through a sign-in proxy, but a
 * normal streamed response does. No identity required — this is part of the
 * read-only UI, same as /memory.
 *
 * `?topics=learnings,messages,...` filters to event types whose name starts
 * with one of those prefixes (e.g. "learnings" matches "learning.created"
 * and "learning.updated"). Replays everything after `Last-Event-ID` (or
 * `?since=`) before switching to live events, so a reconnecting client
 * doesn't miss anything still in the 200-event ring buffer.
 */
export async function GET(req: EventsRequest) {
  if (openConnections >= MAX_CONCURRENT_CONNECTIONS) {
    return retryLater();
  }

  // The per-IP cap needs an address the operator vouched for (BAB_CLIENT_IP_HEADER); otherwise a caller
  // could mint addresses or lock out others. No address either: skip it, the global cap still applies.
  const ip = clientIpVerified() ? clientIp(req.headers) : null;
  if (ip !== null && (perIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
    return Response.json(
      { error: `Too many /api/events connections from this address (max ${MAX_CONNECTIONS_PER_IP})` },
      { status: 429, headers: { "Retry-After": "5" } },
    );
  }

  const topicPrefixes = parseTopics(req);
  const since = parseLastEventId(req);

  function matchesTopics(type: BabEventType): boolean {
    if (!topicPrefixes) return true;
    for (const prefix of topicPrefixes) {
      if (type === prefix || type.startsWith(`${prefix}.`)) return true;
    }
    return false;
  }

  openConnections += 1;
  if (ip !== null) perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    if (closed) return;
    closed = true;
    openConnections = Math.max(0, openConnections - 1);
    if (ip !== null) {
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left > 0) perIp.set(ip, left);
      else perIp.delete(ip);
    }
    if (pingTimer) clearInterval(pingTimer);
    if (unsubscribe) unsubscribe();
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      function safeEnqueue(text: string) {
        if (closed) return;
        try {
          controller.enqueue(encode(text));
        } catch {
          cleanup();
        }
      }

      // Hints the browser's native EventSource reconnect delay (its own
      // backoff on top of this), so LiveUpdates doesn't need to reimplement
      // reconnect timing.
      safeEnqueue("retry: 2000\n\n");

      // Replay first, so the client's ordering (backlog then live) is never
      // interleaved oddly with an event that lands mid-replay.
      for (const event of eventsSince(since)) {
        if (matchesTopics(event.type)) safeEnqueue(formatEvent(event));
      }

      unsubscribe = subscribe((event) => {
        if (matchesTopics(event.type)) safeEnqueue(formatEvent(event));
      });

      pingTimer = setInterval(() => safeEnqueue(": ping\n\n"), pingIntervalMs);

      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
