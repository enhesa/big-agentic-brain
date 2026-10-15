import { getSessionUser, type SessionUser } from "./session";
import { ownerIdFor } from "./reminders-view";

export const NO_STORE = { "Cache-Control": "no-store" };

export function notifyJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export interface Viewer {
  actor: SessionUser;
  ownerId: string;
}

/**
 * The signed-in browser viewer, or null. Only a proxy viewer with a long-form identity
 * counts: agent headers (X-Bab-Actor-*) are refused, because routes that act for a
 * person's own browser must not be drivable by anyone who can reach the app and type a header.
 */
export async function getViewer(): Promise<Viewer | null> {
  const actor = await getSessionUser();
  if (!actor || actor.source !== "proxy") return null;
  const ownerId = ownerIdFor(actor);
  return ownerId ? { actor, ownerId } : null;
}

/**
 * Identity for the /notify/* routes. They sit outside /api on purpose: only paths behind
 * the sign-in proxy attach identity headers, and a browser call is the only caller. No id yields
 * 401 with linkRequired so the UI can point at /me/devices.
 */
export async function requireViewer(): Promise<Viewer | Response> {
  const actor = await getSessionUser();
  if (actor && actor.source !== "proxy") {
    return notifyJson({ error: "Sign in through the BAB web UI to use notifications" }, 401);
  }
  const viewer = await getViewer();
  if (!viewer) {
    return notifyJson(
      { error: "Your browser is not linked to your agent yet", linkRequired: true },
      401,
    );
  }
  return viewer;
}
