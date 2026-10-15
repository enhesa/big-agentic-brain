import { auditRequest } from "./request-audit";
import { notifyJson } from "./notify-auth";
import { currentUser } from "./user";
import { trustProxyHeaders } from "./session";
import { unlinkOwnBrowser } from "./proxy-links";
import { forbiddenResponse, redirectTo, sameOrigin } from "./feedback-web";
import { wantsJson } from "./me-web";

/**
 * The self-unlink POST behind /me/devices/unlink (it was shared with /reminders/unlink until the
 * reminders page stopped showing browser linkage, 2026-10-01). The target is the proxy id from the SSO headers and nothing the client
 * sends, so it can only ever remove the caller's own link. Cookie-authenticated, so the guard
 * is the same-origin check; a plain HTML form is answered with a redirect back to `backTo`, a
 * JSON caller with JSON.
 */
export async function unlinkOwnResponse(request: Request, path: string, backTo: string): Promise<Response> {
  if (!sameOrigin(request)) return forbiddenResponse();
  if (!trustProxyHeaders()) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  const proxy = await currentUser();
  if (!proxy) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);

  const removed = unlinkOwnBrowser(proxy.id);
  await auditRequest({
    actor: removed ? { id: removed.email, name: proxy.name, email: removed.email } : null,
    method: "POST",
    path,
    via: "ui",
  });

  if (wantsJson(request)) return notifyJson({ ok: true, unlinked: removed !== null });
  return redirectTo(request, backTo);
}
