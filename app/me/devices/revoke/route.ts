import { auditRequest } from "@/lib/request-audit";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { revokeDevice, revokeDevicesForUser } from "@/lib/devices";
import { deleteConnectionsForUser } from "@/lib/mcp-connections";
import { forbiddenResponse, redirectTo, sameOrigin } from "@/lib/feedback-web";
import { readFields, wantsJson } from "@/lib/me-web";

export const dynamic = "force-dynamic";

/**
 * POST /me/devices/revoke {id} or {all: "1"}: the "Forget" button. Forgets one of the viewer's
 * own devices, or all of them ("lost laptop", works from any browser with SSO). lib/devices.ts
 * only lets the owner (or a maintainer) forget, so a forged id cannot touch someone else's
 * device. A forgotten device is unknown again: its next bab_identify binds it. (The path keeps
 * the old name; the table column is revoked_at.)
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenResponse();
  const json = wantsJson(request);
  const viewer = await getViewer();
  if (!viewer) return json ? notifyJson({ error: "Sign in through the BAB web UI" }, 401) : redirectTo(request, "/me/devices");

  const { id, all } = await readFields(request);
  if (all !== "1" && !id && json) return notifyJson({ error: "id or all is required" }, 400);

  let revoked = 0;
  if (all === "1") {
    revoked = revokeDevicesForUser(viewer.ownerId);
    // "Forget all" also ends the connections that said they are this person. One device: devices only.
    const connections = deleteConnectionsForUser(viewer.ownerId);
    audit(getDb(), viewer.actor, "device-revoke-all", "device", viewer.ownerId, "ui", { details: { count: revoked, connections } });
  } else if (id) {
    revoked = revokeDevice(id, { id: viewer.ownerId, name: viewer.actor.name, email: viewer.ownerId }) ? 1 : 0;
  }
  await auditRequest({ actor: viewer.actor, method: "POST", path: "/me/devices/revoke", via: "ui" });
  return json ? notifyJson({ ok: true, revoked }) : redirectTo(request, "/me/devices");
}
