import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { forbiddenResponse, redirectTo, sameOrigin } from "@/lib/feedback-web";
import { readFields, wantsJson } from "@/lib/me-web";
import { inboxEnabled, threadForParticipant } from "@/lib/inbox-page";
import { markRead, unreadCountFor } from "@/lib/messages";
import { checkUiRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /inbox/read {threadId}: the "Mark as read" button. It lives under /inbox, not /api, so
 * Forge SSO attaches the viewer; agent headers, devices and connections are not viewers
 * (getViewer), and the cookie makes it forgeable cross-site, so sameOrigin comes first. The
 * target is always the viewer's own side of the thread: markRead only touches messages sent
 * to them, and a thread they are not in is a 404 that says nothing about whether it exists.
 * A plain form post works without JS and is answered with a redirect; JSON gets JSON.
 */
export async function POST(request: Request) {
  if (!inboxEnabled()) return notifyJson({ error: "The Inbox page is switched off" }, 503);
  if (!sameOrigin(request)) return forbiddenResponse();
  const json = wantsJson(request);

  const viewer = await getViewer();
  if (!viewer) return json ? notifyJson({ error: "Sign in through the BAB web UI" }, 401) : redirectTo(request, "/inbox");
  if (!checkUiRateLimit(viewer.ownerId)) return notifyJson({ error: "Too many requests; wait a minute" }, 429);

  const { threadId } = await readFields(request);
  if (!threadId || !threadForParticipant(threadId, viewer.ownerId)) {
    return json ? notifyJson({ error: "Thread not found" }, 404) : redirectTo(request, "/inbox");
  }

  markRead(threadId, viewer.ownerId, "ui");
  await auditRequest({ actor: viewer.actor, method: "POST", path: "/inbox/read", via: "ui" });

  return json
    ? notifyJson({ ok: true, unread: unreadCountFor(viewer.ownerId) })
    : redirectTo(request, `/inbox?thread=${encodeURIComponent(threadId)}`);
}
