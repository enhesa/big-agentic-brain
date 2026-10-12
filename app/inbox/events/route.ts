import { getViewer, notifyJson } from "@/lib/notify-auth";
import { subscribe } from "@/lib/events";
import { eventConcernsViewer, inboxEnabled } from "@/lib/inbox-page";
import { openPageStream } from "@/lib/page-presence";
import { onShutdown } from "@/lib/shutdown";
import { forbiddenResponse } from "@/lib/feedback-web";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

const DEFAULT_PING_INTERVAL_MS = 20_000;
let pingIntervalMs = DEFAULT_PING_INTERVAL_MS;

/**
 * A stream ends after this long and the client reconnects (EventSource does it by itself, and
 * the page refreshes on open). It bounds how long a slot, a timer and a subscriber can be held
 * by a tab whose connection died without a close, and re-checks the viewer's SSO session.
 */
export const MAX_STREAM_LIFETIME_MS = 20 * 60_000;
let maxLifetimeMs = MAX_STREAM_LIFETIME_MS;

/** A queue this far over its limit means nobody is reading: the peer is gone. */
const DEAD_PEER_DESIRED_SIZE = -3;

/** Test-only: shortens the ping so a test does not wait 20 s for one. */
export function _setPingIntervalMsForTests(ms: number): void {
  pingIntervalMs = ms;
}

/** Test-only: shortens the stream lifetime. */
export function _setMaxLifetimeMsForTests(ms: number): void {
  maxLifetimeMs = ms;
}

/**
 * A stream is read-only, but opening one registers the viewer as "page open" (delivery) and
 * holds a slot, and the SSO cookie rides along on a request any site can make. So a browser that
 * says the request is cross-site, or whose Origin is not this app's, is refused.
 * EventSource from our own page sends no Origin and Sec-Fetch-Site: same-origin.
 */
function isCrossSite(req: Request): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  try {
    return origin !== publicOrigin(req.headers);
  } catch {
    return true;
  }
}

const encoder = new TextEncoder();

/**
 * GET /inbox/events: Server-Sent Events for the Inbox page, scoped to the signed-in viewer.
 *
 * The public /api/events carries every event to anyone and cannot say who it is for. This
 * route sits on an SSO path, knows the viewer (agent headers, devices and connections are
 * refused, as everywhere on /inbox) and forwards a bus event only when it concerns them, as
 * `{ threadId, kind }` and nothing else (eventConcernsViewer). The page reacts by refreshing
 * itself, so there is no replay and no event ids: a reconnecting client just refreshes.
 *
 * A named `ping` event every 20 s keeps the SSO proxy from idling the connection out and lets
 * the client tell a quiet inbox from a dead connection. Open streams also hold up a deploy,
 * so a shutdown ends them at once; the client reconnects to the new pod.
 */
export async function GET(req: Request) {
  if (isCrossSite(req)) return forbiddenResponse();
  if (!inboxEnabled()) return notifyJson({ error: "The Inbox page is switched off" }, 503);
  const viewer = await getViewer();
  if (!viewer) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);

  const closeStream = openPageStream(viewer.ownerId);
  if (!closeStream) {
    return Response.json(
      { error: "Too many Inbox tabs are open; this one refreshes every minute instead" },
      { status: 429, headers: { "Retry-After": "30", "Cache-Control": "no-store" } },
    );
  }

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let unregisterShutdown: (() => void) | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  function cleanup() {
    if (closed) return;
    closed = true;
    closeStream!();
    if (pingTimer) clearInterval(pingTimer);
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    if (unsubscribe) unsubscribe();
    if (unregisterShutdown) unregisterShutdown();
    try {
      controllerRef?.close();
    } catch {
      // already closed by the client going away
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      function write(text: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      }

      // The retry hint sets the browser's reconnect delay; the first ping tells the client the stream is alive.
      write("retry: 2000\n\nevent: ping\ndata: {}\n\n");

      unsubscribe = subscribe((event) => {
        const hit = eventConcernsViewer(event, viewer.ownerId);
        if (hit) write(`event: inbox\ndata: ${JSON.stringify(hit)}\n\n`);
      });
      pingTimer = setInterval(() => {
        // Chunks pile up unread when the peer vanished without closing (a sleeping laptop, a
        // dropped VPN): the abort never comes, so the ping is where a dead stream is noticed.
        if (controller.desiredSize !== null && controller.desiredSize < DEAD_PEER_DESIRED_SIZE) {
          cleanup();
          return;
        }
        write("event: ping\ndata: {}\n\n");
      }, pingIntervalMs);
      lifetimeTimer = setTimeout(cleanup, maxLifetimeMs);
      unregisterShutdown = onShutdown(cleanup);
      req.signal.addEventListener("abort", cleanup);
      // Already aborted before the listener existed: no abort event will ever come.
      if (req.signal.aborted) cleanup();
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
