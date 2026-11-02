import { bearer, gate, safeEqual } from "@/lib/gate";
import { config } from "@/lib/config";
import { ccApiError, ccExportForApp, exportAppFor } from "@/lib/command-center";
import { checkCommandCenterRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/command-center/export?from=YYYY-MM-DD&to=YYYY-MM-DD&detail=aggregate|entries: the work
 * log for a report app (BAB_COMMAND_CENTER_EXPORT_APPS). A public path: the app's own export token
 * is the credential, compared in constant time with every app's token, and it reads only people who
 * granted that app on their own page and whose switch is on. Counts per initiative and day by
 * default; entries only for people who allowed them. Audited per call; the token is never echoed.
 */
export async function GET(req: Request) {
  // A public path: the gate lets it through in token mode, but its body-size cap still applies.
  const refused = gate(req);
  if (refused) return refused;
  const c = config();
  if (!c.commandCenter || c.commandCenterExportApps.size === 0) return Response.json({ error: "Command Center export is not set up on this BAB" }, { status: 404, headers: NO_STORE });
  const app = exportAppFor(bearer(req.headers), safeEqual);
  if (!app) return Response.json({ error: "export app token required: Authorization: Bearer <token>" }, { status: 401, headers: NO_STORE });
  if (!checkCommandCenterRateLimit(`app:${app}`)) return Response.json({ error: "Too many requests; wait a minute" }, { status: 429, headers: NO_STORE });
  const url = new URL(req.url);
  try {
    const body = ccExportForApp(app, { from: url.searchParams.get("from"), to: url.searchParams.get("to"), detail: url.searchParams.get("detail") });
    return Response.json(body, { status: 200, headers: NO_STORE });
  } catch (err) {
    const { status, body } = ccApiError(err);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
