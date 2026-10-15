import { auditRequest } from "@/lib/request-audit";
import { notifyJson, getViewer } from "@/lib/notify-auth";
import { currentUser } from "@/lib/user";
import { pendingProxyLinkUser, trustProxyHeaders } from "@/lib/session";
import { suggestLinkFor } from "@/lib/proxy-links";

export const dynamic = "force-dynamic";

/**
 * GET /notify/identity: where the signed-in viewer stands on linking this browser.
 *   linked   -> nothing to do
 *   suggest  -> the alias points at exactly one person; offer "Yes, that's me"
 *   claim    -> no suggestion; the viewer confirms who they are on /me/devices (typed claim)
 * 401 only when there is no proxy viewer at all. Read-only, so no origin check is needed.
 */
export async function GET() {
  if (!trustProxyHeaders()) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  const proxy = await currentUser();
  if (!proxy) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);

  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/notify/identity", via: "ui" });
  if (viewer) return notifyJson({ state: "linked", email: viewer.ownerId, name: viewer.actor.name });

  const suggestion = suggestLinkFor(proxy.id, proxy.email, proxy.name);
  if (suggestion) return notifyJson({ state: "suggest", ...suggestion });

  const pending = await pendingProxyLinkUser();
  if (!pending) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  return notifyJson({ state: "claim", url: "/me/devices" });
}
