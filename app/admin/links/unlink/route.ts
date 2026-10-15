import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { unlinkBrowser } from "@/lib/proxy-links";
import { toApiError, ValidationError } from "@/lib/errors";
import { forbiddenResponse, sameOrigin } from "@/lib/feedback-web";

export const dynamic = "force-dynamic";

/**
 * POST /admin/links/unlink {email} or {proxyUserId}: undo a wrong browser link.
 * Maintainers only (BAB_MAINTAINERS). Outside /api on purpose, so the caller is the real
 * SSO-backed viewer and not a self-declared agent header. Same guards as the other
 * cookie-authenticated writes: own Origin and a JSON body.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenResponse();
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return notifyJson({ error: "Content-Type must be application/json" }, 415);
  }
  const viewer = await getViewer();
  if (!viewer) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  await auditRequest({ actor: viewer.actor, method: "POST", path: "/admin/links/unlink", via: "ui" });

  try {
    const body = (await request.json().catch(() => undefined)) as { email?: unknown; proxyUserId?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email : undefined;
    const proxyUserId = typeof body?.proxyUserId === "string" ? body.proxyUserId : undefined;
    if (!email && !proxyUserId) throw new ValidationError("email or proxyUserId is required");
    const { removed } = unlinkBrowser(viewer.ownerId, { email, proxyUserId });
    return notifyJson({ ok: true, removed });
  } catch (err) {
    const { status, body } = toApiError(err);
    return notifyJson({ error: body.error }, status);
  }
}
