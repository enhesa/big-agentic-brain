import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { isPublicPath } from "./public-paths";

/** Constant-time string compare: a length check first (lengths are not secret), then timingSafeEqual. */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(h: Headers): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h.get("authorization") ?? "");
  return m ? m[1] : null;
}

/** Where a presented token sits: a bare (access-only) token, a token pinned to an email, or unknown. */
function lookup(presented: string): { known: boolean; email: string | null } {
  const c = config();
  let known = false;
  let email: string | null = null;
  // No early exit: every configured token is compared.
  for (const t of c.tokens ?? []) if (safeEqual(presented, t)) known = true;
  for (const [t, e] of c.tokenIdentities) {
    if (safeEqual(presented, t)) {
      known = true;
      email = e;
    }
  }
  return { known, email };
}

/** True when any API token is configured (token mode). */
export function tokenModeOn(): boolean {
  const c = config();
  return (c.tokens?.size ?? 0) > 0 || c.tokenIdentities.size > 0;
}

/** True when the request carries a bearer token this server knows. */
export function hasValidBearer(h: Headers): boolean {
  const presented = bearer(h);
  return !!presented && lookup(presented).known;
}

/**
 * Hook endpoints are public so a hook never fails, but in token mode they serve content only to a
 * caller that presents a valid bearer.
 */
export function hookMayServe(h: Headers): boolean {
  return !tokenModeOn() || hasValidBearer(h);
}

/** The email the request's bearer token is pinned to (token=email entries), else null. */
export function tokenIdentityFor(h: Headers): string | null {
  const presented = bearer(h);
  return presented ? lookup(presented).email : null;
}

/** True when `email` is the identity of a token=email entry: only a request carrying that token may act as them. */
export function isTokenBoundEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  for (const bound of config().tokenIdentities.values()) if (bound === e) return true;
  return false;
}

/** The refusal text for a request that claims a token-bound address without its token. */
export function tokenBoundMessage(email: string): string {
  return `${email.trim().toLowerCase()} is bound to an API token; connect with that token to act as them`;
}

function json(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * The request gate for /api/* and /mcp (proxy.ts calls it): null lets the request through, a
 * Response ends it. Enforces the body-size cap from Content-Length, then, when any API token is
 * configured, a valid `Authorization: Bearer` on every path that is not public. With no tokens
 * configured nothing is required (open mode).
 */
export function gate(req: Request): Response | null {
  const c = config();
  const pathname = new URL(req.url).pathname;
  const length = Number(req.headers.get("content-length"));
  // /api/hook must always answer 200 {}: a hook failing loudly would break the agent session.
  if (pathname !== "/api/hook" && pathname !== "/api/hook/" && Number.isFinite(length) && length > c.network.maxBodyBytes) return json(413, "request body too large");

  const gated = tokenModeOn();
  if (!gated) return null;
  if (isPublicPath(pathname)) return null;

  const presented = bearer(req.headers);
  if (presented && lookup(presented).known) return null;
  return json(401, "token required");
}
