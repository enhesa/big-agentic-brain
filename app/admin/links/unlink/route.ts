import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { unlinkBrowser } from "@/lib/forge-links";
import { toApiError, ValidationError } from "@/lib/errors";
import { forbiddenResponse, sameOrigin } from "@/lib/feedback-web";

export const dynamic = "force-dynamic";

/**
 * POST /admin/links/unlink {email} or {forgeUserId}: undo a wrong browser link.
 * Maintainers only (BAB_MAINTAINERS). Outside /api on purpose, so the caller is the real
 * Entra-backed viewer and not a self-declared agent header. Same guards as the other
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
    const body = (await request.json().catch(() => undefined)) as { email?: unknown; forgeUserId?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email : undefined;
    const forgeUserId = typeof body?.forgeUserId === "string" ? body.forgeUserId : undefined;
    if (!email && !forgeUserId) throw new ValidationError("email or forgeUserId is required");
    const { removed } = unlinkBrowser(viewer.ownerId, { email, forgeUserId });
    return notifyJson({ ok: true, removed });
  } catch (err) {
    const { status, body } = toApiError(err);
    return notifyJson({ error: body.error }, status);
  }
}
