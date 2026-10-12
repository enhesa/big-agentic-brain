import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { revokeDevice } from "@/lib/devices";
import { assertMaintainer } from "@/lib/feedback";
import { toApiError, NotFoundError, ValidationError } from "@/lib/errors";
import { forbiddenResponse, sameOrigin } from "@/lib/feedback-web";

export const dynamic = "force-dynamic";

/**
 * POST /admin/links/devices/revoke {id}: revoke any device (lost laptop, leaver). Maintainers
 * only (BAB_MAINTAINERS). Outside /api on purpose, so the caller is the real Entra-backed
 * viewer and not a self-declared agent header. Same guards as /admin/links/unlink: own Origin
 * and a JSON body.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenResponse();
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return notifyJson({ error: "Content-Type must be application/json" }, 415);
  }
  const viewer = await getViewer();
  if (!viewer) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  await auditRequest({ actor: viewer.actor, method: "POST", path: "/admin/links/devices/revoke", via: "ui" });

  try {
    assertMaintainer(viewer.ownerId, "revoke a device");
    const body = (await request.json().catch(() => undefined)) as { id?: unknown } | undefined;
    if (typeof body?.id !== "string" || !body.id) throw new ValidationError("id is required");
    const actor = { id: viewer.ownerId, name: viewer.actor.name, email: viewer.ownerId };
    if (!revokeDevice(body.id, actor)) throw new NotFoundError("No such live device");
    return notifyJson({ ok: true });
  } catch (err) {
    const { status, body } = toApiError(err);
    return notifyJson({ error: body.error }, status);
  }
}
