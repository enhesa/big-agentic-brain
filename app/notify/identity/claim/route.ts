import { auditRequest } from "@/lib/request-audit";
import { notifyJson } from "@/lib/notify-auth";
import { currentUser } from "@/lib/user";
import { trustForgeHeaders } from "@/lib/session";
import { claimSuggestedLink } from "@/lib/forge-links";
import { toApiError, ValidationError } from "@/lib/errors";
import { forbiddenResponse, sameOrigin } from "@/lib/feedback-web";

export const dynamic = "force-dynamic";

/**
 * POST /notify/identity/claim {email}: the one-click link. Cookie-authenticated, so the
 * guards are: own Origin and a JSON body, which a cross-site form cannot send. The email is only compared with the server's own
 * suggestion (lib/forge-links.ts), never used as the identity.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenResponse();
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return notifyJson({ error: "Content-Type must be application/json" }, 415);
  }
  if (!trustForgeHeaders()) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  const forge = await currentUser();
  if (!forge) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);

  try {
    const body = (await request.json().catch(() => undefined)) as { email?: unknown } | undefined;
    if (typeof body?.email !== "string") throw new ValidationError("email is required");
    const { email } = claimSuggestedLink(forge.id, forge.email, forge.name, body.email);
    await auditRequest({ actor: { id: email, name: forge.name, email }, method: "POST", path: "/notify/identity/claim", via: "ui" });
    return notifyJson({ state: "linked", email });
  } catch (err) {
    const { status, body } = toApiError(err);
    return notifyJson(body, status);
  }
}
