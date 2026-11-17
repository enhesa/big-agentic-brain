import { identityHint } from "./identity";

/**
 * What a signed-in but unlinked viewer is told, in one wording on every page that shows the
 * link card (app/components/LinkBrowserNotice.tsx). Such a viewer's sign-in passed a short alias,
 * another domain or no address BAB accepts as a person (lib/session.ts fromProxy), so BAB cannot
 * key them yet. The fix is one step, right on the page: confirm the address once.
 */

/** The card's headline. */
export const LINK_TITLE = "Link this browser to your BAB account";

/** What is missing. */
export function linkNeededReason(): string {
  return `Your sign-in did not give BAB your full work address (like ${identityHint()}), so BAB does not know who you are yet.`;
}

/** Why it is safe and quick. */
export const LINK_ONCE = "You do this once. This browser stays linked after that.";

/** Where a claim goes back to when the form sent no usable return path. */
export const DEFAULT_RETURN = "/me/devices";

const RETURN_PATH = /^\/(?![/\\])[A-Za-z0-9\-._~/%]*$/;

/**
 * The page a link form returns to, from its `next` field. Only a plain same-origin path counts:
 * one leading slash, no second slash or backslash after it, no scheme, host, user info, query,
 * fragment or control characters. Anything else falls back to DEFAULT_RETURN, so the claim can
 * never redirect off the site.
 */
export function safeReturnPath(next: unknown): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return DEFAULT_RETURN;
  if (!RETURN_PATH.test(next)) return DEFAULT_RETURN;
  try {
    const base = "http://bab.invalid";
    const url = new URL(next, base);
    if (url.origin !== base || url.pathname !== next) return DEFAULT_RETURN;
  } catch {
    return DEFAULT_RETURN;
  }
  return next;
}

/** `path` with `?claim=<code>`; the code is one of CLAIM_ERRORS' keys, never free text. */
export function withClaimCode(path: string, code: string): string {
  const url = new URL(safeReturnPath(path), "http://bab.invalid");
  url.searchParams.set("claim", code);
  return `${url.pathname}${url.search}`;
}
