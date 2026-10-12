/**
 * Who has the Inbox page open right now. The page keeps one Server-Sent Events stream per
 * tab (app/inbox/events/route.ts); a viewer with at least one open stream is "connected".
 * In memory on purpose: the app runs one replica and a restart closes every stream, so the
 * clients reconnect and the map rebuilds itself within seconds.
 *
 * "Connected" means a tab exists, not that anyone is looking at it (a background tab counts,
 * which is the point of the page). It is what send() reports to the sender as delivery.page.
 */

/** Tabs per person that may hold a live stream; one more gets a 429 and falls back to polling. */
export const MAX_STREAMS_PER_VIEWER = 20;

const open = new Map<string, number>();

/**
 * Registers an open stream for the viewer. Returns the function that closes it (safe to call
 * more than once), or null when the viewer is already at the cap.
 */
export function openPageStream(viewerId: string): (() => void) | null {
  const n = open.get(viewerId) ?? 0;
  if (n >= MAX_STREAMS_PER_VIEWER) return null;
  open.set(viewerId, n + 1);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const left = (open.get(viewerId) ?? 1) - 1;
    if (left <= 0) open.delete(viewerId);
    else open.set(viewerId, left);
  };
}

export function pageConnected(viewerId: string): boolean {
  return (open.get(viewerId) ?? 0) > 0;
}

/** Test-only. */
export function _resetPagePresenceForTests(): void {
  open.clear();
}
