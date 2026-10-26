import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { linkBrowserAsMaintainer } from "@/lib/proxy-links";
import { toApiError } from "@/lib/errors";
import { forbiddenResponse, sameOrigin } from "@/lib/feedback-web";
import { checkUiRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /admin/links/link {proxyUserId, email}: link a refused sign-in user's browser to a
 * long-form address. Maintainers only (BAB_MAINTAINERS). Same guards as /admin/links/unlink:
 * an SSO viewer path outside /api, own Origin and a JSON body.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenResponse();
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return notifyJson({ error: "Content-Type must be application/json" }, 415);
  }
  const viewer = await getViewer();
  if (!viewer) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  if (!checkUiRateLimit(viewer.ownerId)) return notifyJson({ error: "Too many requests; wait a minute" }, 429);
  await auditRequest({ actor: viewer.actor, method: "POST", path: "/admin/links/link", via: "ui" });

  try {
    const body = (await request.json().catch(() => undefined)) as { proxyUserId?: unknown; email?: unknown } | undefined;
    const proxyUserId = typeof body?.proxyUserId === "string" ? body.proxyUserId : "";
    const email = typeof body?.email === "string" ? body.email : "";
    const linked = linkBrowserAsMaintainer(viewer.ownerId, proxyUserId, email);
    return notifyJson({ ok: true, email: linked.email });
  } catch (err) {
    const { status, body } = toApiError(err);
    return notifyJson({ error: body.error }, status);
  }
}
