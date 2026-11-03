import { getViewer, notifyJson } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { ccApiError, ccExportOwn } from "@/lib/command-center";
import { config } from "@/lib/config";
import { checkUiRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /command-center/export: the signed-in viewer downloads their own work log as JSON. Viewer
 * only (getViewer), outside /api so the browser needs no API token; never anyone else's log.
 */
export async function GET() {
  if (!config().commandCenter) return notifyJson({ error: "Command Center is switched off on this BAB" }, 404);
  const viewer = await getViewer();
  if (!viewer) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  if (!checkUiRateLimit(viewer.ownerId)) return notifyJson({ error: "Too many requests; wait a minute" }, 429);
  await auditRequest({ actor: viewer.actor, method: "GET", path: "/command-center/export", via: "ui" });
  try {
    const body = ccExportOwn(viewer.ownerId);
    return new Response(JSON.stringify(body, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="command-center-log-${body.exportedAt.slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const { status, body } = ccApiError(err);
    return notifyJson(body, status);
  }
}
