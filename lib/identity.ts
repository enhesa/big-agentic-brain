/**
 * Pure email/name helpers shared by lib/session.ts (validation) and
 * lib/users.ts (first-sight name derivation). Kept dependency-free so the two
 * don't import each other.
 */

import { config } from "./config";

/**
 * Identity shape comes from config().identity (BAB_IDENTITY_EMAIL_PATTERN, optional
 * BAB_IDENTITY_ALIAS_PATTERN for addresses that are real but not the identity form, such as a
 * short alias, and BAB_ALLOWED_EMAILS as an extra allow-list).
 */
export function isValidIdentityEmail(email: string): boolean {
  const { emailPattern, allowedEmails } = config().identity;
  if (!emailPattern.test(email)) return false;
  return !allowedEmails || allowedEmails.has(email.toLowerCase());
}

/** A real address of this organisation that is not the identity form (for example a short alias). */
export function isAliasEmail(email: string): boolean {
  const { aliasPattern, emailPattern } = config().identity;
  return !!aliasPattern && aliasPattern.test(email) && !emailPattern.test(email);
}

export function identityHint(): string {
  return config().identity.hint;
}

/** The part of the hint after "@", or "" when the hint has none. */
export function identityDomain(): string {
  const h = identityHint();
  const at = h.lastIndexOf("@");
  return at < 0 ? "" : h.slice(at + 1).toLowerCase();
}

export function identityRejectionText(email: string): string {
  const { emailPattern, allowedEmails } = config().identity;
  if (allowedEmails && emailPattern.test(email) && !allowedEmails.has(email.toLowerCase())) {
    return "email is not on the allowed list";
  }
  return isAliasEmail(email)
    ? `Use your long address in the form ${identityHint()} (not the short alias)`
    : `email must be an address in the form ${identityHint()}`;
}

/**
 * Title-cases each dot-separated part of the local part of a long-form email
 * ("bob-luc.van-der-example" -> "Bob-Luc Van-Der-Example"). Hyphen/apostrophe
 * sub-parts are title-cased individually.
 */
export function derivedNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  return local
    .split(".")
    .map((part) =>
      part
        .split(/([-'])/)
        .map((seg) =>
          seg === "-" || seg === "'" ? seg : seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase(),
        )
        .join(""),
    )
    .join(" ");
}

/**
 * Loose match used to decide whether a header-supplied display name is "the
 * same name" as the one derived from the email: same letters, ignoring case,
 * accents, spaces and punctuation, in any order.
 */
export function namesMatchLoosely(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z]/g, "")
      .split("")
      .sort()
      .join("");
  return normalize(a) === normalize(b);
}

const lettersOnly = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * Does the SSO-provided display name belong to the person this long-form email names?
 * Used before offering a one-click link, so it is strict on purpose: the first name and the
 * last name (everything after the first dot, joined) must both appear at token boundaries.
 * A parenthetical nickname ("Alice (Ally) Example") and middle names are ignored; a longer
 * surname ("Smithson" for smith) or a different first name is not a match. Tokens are
 * whitespace-separated and compared letters-only, so "Jean Luc" matches jean-luc.
 */
export function proxyNameMatchesEmail(proxyName: string | null | undefined, email: string): boolean {
  if (!proxyName) return false;
  const local = email.split("@")[0] ?? "";
  const [firstPart, ...rest] = local.split(".");
  const first = lettersOnly(firstPart ?? "");
  const last = lettersOnly(rest.join(""));
  if (!first || !last) return false;

  const tokens = proxyName
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/)
    .map(lettersOnly)
    .filter(Boolean);
  for (let k = 1; k < tokens.length; k++) {
    if (tokens.slice(0, k).join("") !== first) continue;
    for (let i = k; i < tokens.length; i++) {
      if (tokens.slice(i).join("") === last) return true;
    }
  }
  return false;
}
