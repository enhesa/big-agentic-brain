import { auditRequest } from "./request-audit";
import { notifyJson, type Viewer } from "./notify-auth";
import { forbiddenResponse, redirectTo, sameOrigin } from "./feedback-web";
import { readFields, wantsJson } from "./me-web";
import { checkUiRateLimit } from "./rate-limit";
import { config } from "./config";
import { ccApiError } from "./command-center";

/**
 * The page's own write routes (/command-center/enable, disable, delete, dismiss). They sit
 * outside /api so the sign-in proxy attaches the viewer; agent headers, devices and connections
 * are not viewers (getViewer), so no agent can flip the switch. The cookie makes a cross-site
 * post possible, so sameOrigin comes first. A plain form post gets a 303 back to the page.
 */
export async function viewerPost(
  request: Request,
  path: string,
  viewer: Viewer | null,
  act: (viewer: Viewer, fields: Record<string, string>) => unknown,
): Promise<Response> {
  if (!config().commandCenter) return notifyJson({ error: "Command Center is switched off on this BAB" }, 404);
  if (!sameOrigin(request)) return forbiddenResponse();
  const json = wantsJson(request);
  if (!viewer) return json ? notifyJson({ error: "Sign in through the BAB web UI" }, 401) : redirectTo(request, "/command-center");
  if (!checkUiRateLimit(viewer.ownerId)) return notifyJson({ error: "Too many requests; wait a minute" }, 429);
  const fields = await readFields(request);
  let result: unknown;
  try {
    result = act(viewer, fields);
  } catch (err) {
    const { status, body } = ccApiError(err);
    return json ? notifyJson(body, status) : redirectTo(request, "/command-center");
  }
  await auditRequest({ actor: viewer.actor, method: "POST", path, via: "ui" });
  return json ? notifyJson({ ok: true, ...(result && typeof result === "object" ? result : {}) }) : redirectTo(request, "/command-center");
}
