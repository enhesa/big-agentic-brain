import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { addAreaContact, removeAreaContact, setHomeTeam } from "@/lib/area-contacts";
import { toApiError } from "@/lib/errors";
import { forbiddenResponse, redirectTo, sameOrigin } from "@/lib/feedback-web";
import { readFields, wantsJson } from "@/lib/me-web";

export const dynamic = "force-dynamic";

/**
 * POST /me/devices/profile {action: team | add | remove, team?, area?, note?}: the viewer's own
 * home team and the areas they are a contact for. Only ever the signed-in person's own profile;
 * the page and lib/area-contacts.ts have no way to name someone else here. A refusal redirects
 * with `?profile=invalid`, a JSON caller gets the message.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenResponse();
  const json = wantsJson(request);
  const viewer = await getViewer();
  if (!viewer) return json ? notifyJson({ error: "Sign in through the BAB web UI" }, 401) : redirectTo(request, "/me/devices");

  const { action, team, area, note } = await readFields(request);
  try {
    if (action === "team") setHomeTeam(viewer.ownerId, team, "ui");
    else if (action === "add") addAreaContact(viewer.ownerId, area, note, "ui");
    else if (action === "remove") removeAreaContact(viewer.ownerId, area, undefined, "ui");
    else return json ? notifyJson({ error: "action must be team, add or remove" }, 400) : redirectTo(request, "/me/devices?profile=invalid");
  } catch (err) {
    if (json) {
      const { status, body } = toApiError(err);
      return notifyJson({ error: body.error }, status);
    }
    return redirectTo(request, "/me/devices?profile=invalid");
  }
  await auditRequest({ actor: viewer.actor, method: "POST", path: "/me/devices/profile", via: "ui" });
  return json ? notifyJson({ ok: true }) : redirectTo(request, "/me/devices");
}
