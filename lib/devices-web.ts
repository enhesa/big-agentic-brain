import { identityHint } from "./identity";
import { auditRequest } from "./request-audit";
import { notifyJson } from "./notify-auth";
import { currentUser } from "./user";
import { trustProxyHeaders } from "./session";
import { claimTypedIdentity, SsoAddressMismatchError } from "./proxy-links";
import { ConflictError, ForbiddenError, toApiError } from "./errors";
import { forbiddenResponse, redirectTo, sameOrigin } from "./feedback-web";
import { readFields, wantsJson } from "./me-web";

/**
 * The typed claim on /me/devices: a signed-in viewer with no identity types their long-form
 * address and links their own browser (claimTypedIdentity), which is what gives the web UI a
 * person to show reminders to. The refusal codes and the POST live here.
 */

/** One plain line per refusal code; the redirect carries the code, never the message. */
export const CLAIM_ERRORS: Record<string, string> = {
  get invalid() {
    return `Type your long address, ${identityHint()}.`;
  },
  mismatch: "That address does not fit the name your sign-in shows. Ask a maintainer for help (they use /admin/links).",
  get sso() {
    return `Your sign-in does not show an address that fits this one (${identityHint()}). Ask a maintainer for help (they use /admin/links).`;
  },
  taken: "That address, or this browser, is already linked. Unlink it first, or ask a maintainer for help (they use /admin/links).",
};

export function claimErrorCode(err: unknown): "sso" | "mismatch" | "taken" | "invalid" {
  if (err instanceof SsoAddressMismatchError) return "sso";
  return err instanceof ForbiddenError ? "mismatch" : err instanceof ConflictError ? "taken" : "invalid";
}

/**
 * The typed-claim POST. The proxy user comes from the SSO headers; the typed address is only a
 * claim that lib/proxy-links.ts checks against the SSO name. A plain HTML form is answered with
 * a redirect to `backTo` (refusals as `?claim=<code>`), a JSON caller with JSON.
 */
export async function claimResponse(request: Request, path: string, backTo: string): Promise<Response> {
  if (!sameOrigin(request)) return forbiddenResponse();
  if (!trustProxyHeaders()) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);
  const proxy = await currentUser();
  if (!proxy) return notifyJson({ error: "Sign in through the BAB web UI" }, 401);

  const json = wantsJson(request);
  const { email } = await readFields(request);
  try {
    const claimed = claimTypedIdentity(proxy.id, proxy.email, proxy.name, email ?? "");
    await auditRequest({ actor: { id: claimed.email, name: proxy.name, email: claimed.email }, method: "POST", path, via: "ui" });
    return json ? notifyJson({ ok: true, email: claimed.email }) : redirectTo(request, backTo);
  } catch (err) {
    if (json) {
      const { status, body } = toApiError(err);
      return notifyJson({ error: body.error }, status);
    }
    return redirectTo(request, `${backTo}?claim=${claimErrorCode(err)}`);
  }
}
