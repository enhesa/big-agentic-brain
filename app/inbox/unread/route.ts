import { getViewer, notifyJson } from "@/lib/notify-auth";
import { inboxEnabled } from "@/lib/inbox-page";
import { unreadCountFor } from "@/lib/messages";
import { checkUiRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /inbox/unread: the viewer's unread message count, for the badge on the nav item. SSO
 * path, so only a signed-in, linked browser gets a number; everyone else gets a 401 the
 * badge simply ignores. A count only, no thread ids and no text.
 */
export async function GET() {
  if (!inboxEnabled()) return notifyJson({ error: "The Inbox page is switched off" }, 503);
  const viewer = await getViewer();
  if (!viewer) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  // The browser's own bucket, so a busy agent session cannot starve the badge (lib/rate-limit.ts).
  if (!checkUiRateLimit(viewer.ownerId)) return notifyJson({ error: "Too many requests; wait a minute" }, 429);
  return notifyJson({ unread: unreadCountFor(viewer.ownerId) });
}
