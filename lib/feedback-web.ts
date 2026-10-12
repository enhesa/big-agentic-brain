import { publicOrigin } from "./origin";

/**
 * Helpers for the two browser write routes (app/feedback/submit, app/feedback/[id]/vote).
 * They sit behind Forge SSO, which authenticates with a cookie, so a form on any other
 * site could post to them with the viewer's session: the Origin header must be this app's
 * own origin. A missing Origin is refused too; every browser sends one on a form POST.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return origin === publicOrigin(req.headers);
  } catch {
    return false;
  }
}

export function forbiddenResponse(): Response {
  return new Response("Cross-site request refused", { status: 403, headers: { "Cache-Control": "no-store" } });
}

/**
 * 401 for a viewer with no identity. The page cannot render the Shell from a route
 * handler, so this is a small self-contained page that points at /me/devices.
 */
export function unauthorizedResponse(): Response {
  const html =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Link your browser</title>" +
    '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a3360">' +
    "<h1>Link your browser first</h1>" +
    "<p>BAB does not know who you are yet. Open <a href=\"/me/devices\">/me/devices</a>, confirm who you are, then try again.</p>" +
    '<p><a href="/feedback">Back to feedback</a></p>';
  return new Response(html, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

export function redirectTo(req: Request, pathAndQuery: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${publicOrigin(req.headers)}${pathAndQuery}`, "Cache-Control": "no-store" },
  });
}
