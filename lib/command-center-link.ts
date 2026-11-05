/**
 * The link that opens the Claude session behind an initiative (record source.link), checked on
 * the server when it is published and again on the page before it becomes an href. A strict
 * allowlist, not a URL parser: https:// with a plain lowercase host, or claude://claude.ai, then
 * an optional path of letters, digits, / _ - . only, with no empty, "." or ".." segment. No port,
 * credentials, query, fragment, percent-encoding, whitespace or any other scheme. No imports: the
 * page and the client use it too.
 */

export const CC_LINK_MAX = 300;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SEGMENT = "(?!\\.\\.?(?:/|$))[A-Za-z0-9_.-]+";
const LINK_RE = new RegExp(`^(?:https://${LABEL}(?:\\.${LABEL})+|claude://claude\\.ai)(?:/${SEGMENT})*/?$`);

/** True for a link the page may render as an href. Anything else, of any type, is false. */
export function isSessionLink(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length <= CC_LINK_MAX && LINK_RE.test(raw);
}
