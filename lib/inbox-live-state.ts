/**
 * The pure parts of the Inbox page's live behaviour (app/inbox/InboxLive.tsx): the title, the
 * favicon dot and the connection state machine. No DOM and no timers here, so they are unit
 * tested; the component only wires them to the browser.
 */

/** window event carrying the unread count (detail: number): the page tells the nav badge without a second request. */
export const UNREAD_EVENT = "bab:inbox-unread";

/** The server pings every 20 s (a named event, so the client sees it). Silence this long means a dead connection, for example after the laptop slept. */
export const SILENCE_MS = 70_000;
/** The page also refreshes by itself this often, so a refused or dead stream still works. */
export const SAFETY_REFRESH_MS = 60_000;

/**
 * "(2) Inbox" while something is unread, "Inbox" otherwise. Built from a number alone: a
 * subject or a name must never reach document.title. Anything that is not a positive finite
 * number counts as zero.
 */
export function inboxTitle(unread: number): string {
  const n = typeof unread === "number" && Number.isFinite(unread) ? Math.floor(unread) : 0;
  if (n <= 0) return "Inbox";
  return n > 99 ? "(99+) Inbox" : `(${n}) Inbox`;
}

// The app icon (public/branding/icon.svg) plus a coral dot, so a pinned or background tab shows something
// is waiting. The tile takes the deployment's accent colour (passed in: this module also runs in the browser). Inline as a data URL: nothing to fetch, and nothing from a message is in it.
function iconWithDot(accent: string): string {
  return (
  '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="0" y="0" width="512" height="512" rx="96" fill="' + accent + '"/>' +
  '<path d="M256 168 L176 320 M256 168 L336 320 M176 320 L336 320" fill="none" stroke="#00B0A1" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<circle cx="256" cy="168" r="56" fill="#00B0A1"/><circle cx="176" cy="320" r="56" fill="#00B0A1"/><circle cx="336" cy="320" r="56" fill="#FFB700"/>' +
  '<circle data-dot="unread" cx="404" cy="108" r="84" fill="#FF4423" stroke="#FFFFFF" stroke-width="24"/>' +
  "</svg>"
  );
}

/** The favicon to show while something is unread, or null to keep the normal one. */
export function faviconDotHref(unread: number, accent: string): string | null {
  if (!(typeof unread === "number" && Number.isFinite(unread) && unread >= 1)) return null;
  return `data:image/svg+xml,${encodeURIComponent(iconWithDot(accent))}`;
}

export type LiveStatus = "connecting" | "live" | "reconnecting" | "stopped";
export type LiveEvent = "open" | "message" | "error-retrying" | "error-closed" | "silence";

/**
 * "error-retrying" is the browser reconnecting by itself (readyState CONNECTING); "error-closed"
 * is the server refusing the stream (signed out, 429, 503) which EventSource does not retry.
 */
export function nextStatus(_prev: LiveStatus, event: LiveEvent): LiveStatus {
  switch (event) {
    case "open":
    case "message":
      return "live";
    case "error-retrying":
    case "silence":
      return "reconnecting";
    case "error-closed":
      return "stopped";
  }
}

export function isSilent(lastSeenAt: number, now: number): boolean {
  return now - lastSeenAt > SILENCE_MS;
}

/** One plain sentence per state, and the one thing to do when it stopped. */
export function statusText(status: LiveStatus): string {
  switch (status) {
    case "live":
      return "Live";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "stopped":
      return "Live updates stopped. This page still refreshes every minute. Reload to reconnect; you may need to sign in again.";
  }
}

/** The nav badge text: nothing for zero, "99+" for a long list. */
export function badgeLabel(count: number): string {
  const n = typeof count === "number" && Number.isFinite(count) ? Math.floor(count) : 0;
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

/**
 * What the nav makes of GET /inbox/unread: a count on 200, "off" on 503 (BAB_INBOX_PAGE=0, so
 * the nav item hides), and nothing for anything else (401 for a signed-out or unlinked viewer,
 * or the SSO login page when the session ended). On a 429 it is null: the limit says nothing about
 * the inbox, so the badge keeps its last value rather than clearing. Never throws on a body it did
 * not expect.
 */
export function parseUnreadResponse(status: number, body: unknown): { count: number; off: boolean } | null {
  if (status === 429) return null;
  if (status === 503) return { count: 0, off: true };
  if (status === 200 && body && typeof body === "object") {
    const n = (body as { unread?: unknown }).unread;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return { count: Math.floor(n), off: false };
  }
  return { count: 0, off: false };
}
