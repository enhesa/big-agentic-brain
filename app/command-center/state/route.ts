import { getViewer, notifyJson } from "@/lib/notify-auth";
import { ccView } from "@/lib/command-center";
import { config } from "@/lib/config";
import { checkUiRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /command-center/state: the stamp the open page polls every 15 seconds, so it refreshes
 * only when something changed. Viewer only, outside /api so the browser needs no API token.
 */
export async function GET() {
  if (!config().commandCenter) return notifyJson({ error: "Command Center is switched off on this BAB" }, 404);
  const viewer = await getViewer();
  if (!viewer) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  if (!checkUiRateLimit(viewer.ownerId)) return notifyJson({ error: "Too many requests; wait a minute" }, 429);
  try {
    return notifyJson({ stamp: ccView(viewer.ownerId).stamp });
  } catch {
    return notifyJson({ error: "Command Center is not available right now" }, 503);
  }
}
