import { getDb } from "./db";
import { audit } from "./audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { assertMaintainer } from "./feedback";
import { derivedNameFromEmail, forgeNameMatchesEmail, identityDomain, identityHint, isValidIdentityEmail } from "./identity";
import { upsertUser } from "./users";
import { revokeDevicesBoundVia, revokeDevicesForUser } from "./devices";
import { deleteConnectionsForUser } from "./mcp-connections";

/**
 * Browser link: ties the identity provider's user id (opaque GUID, no usable email in production,
 * see lib/session.ts's fromForge()) to the long-form email the same person uses as an
 * agent. It is made on the signed-in viewer's own browser, either by "That's me"
 * (claimSuggestedLink) or by typing the address on /me/devices (claimTypedIdentity), and both
 * are checked against the SSO name and alias, which the user cannot edit. The confirmed link
 * lives in forge_links (v18). The agent-mediated link code was dropped on 2026-10-01: the
 * code a user copied into their agent was the weaker path.
 */

/** Local part of an address on the organisation's domain (the domain of the identity hint), else null. */
function aliasLocalPart(emailRaw: string | null | undefined): string | null {
  const email = emailRaw?.trim().toLowerCase() ?? "";
  const domain = identityDomain();
  const at = email.lastIndexOf("@");
  if (!domain || at < 1 || email.slice(at + 1) !== domain) return null;
  const local = email.slice(0, at);
  return /^[a-z0-9._%+-]+$/.test(local) ? local : null;
}

/**
 * The typed claim has no agent-confirmed address to lean on, so the SSO email is mandatory
 * here: it must be an address on the organisation domain whose local part is one of the typed person's
 * aliases, or the typed local part itself. Without it the name check alone would let a
 * colleague with a similar name claim someone else (a middle name makes the guessed alias
 * differ, so those cases go through a maintainer at /admin/links).
 */
function ssoEmailFitsTyped(forgeEmailRaw: string | null | undefined, typed: string): boolean {
  const m = aliasLocalPart(forgeEmailRaw);
  if (!m) return false;
  return m === typed.split("@")[0] || aliasesOf(typed).includes(m);
}

/** The durable side of the link: null when this proxy user id has never been linked. */
export function getLinkedUserId(forgeUserId: string): string | null {
  const row = getDb()
    .prepare("SELECT user_id FROM forge_links WHERE forge_user_id = ?")
    .get(forgeUserId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export interface LinkSuggestion {
  email: string;
  name: string;
}

/**
 * The alias the proxy sends is first initial + last name ("aexample"). The long form may
 * carry a multi-part last name ("bob.van.der.example") or a hyphenated one, so each
 * candidate alias is built from the letters only and the last name is tried both as the
 * last segment and as everything after the first dot joined together.
 */
function aliasesOf(longEmail: string): string[] {
  const segments = longEmail
    .split("@")[0]
    .toLowerCase()
    .split(".")
    .map((s) => s.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  if (segments.length < 2) return [];
  const initial = segments[0][0];
  return [...new Set([initial + segments[segments.length - 1], initial + segments.slice(1).join("")])];
}

interface Candidate extends LinkSuggestion {
  linkedElsewhere: boolean;
}

/**
 * The one long-form user this proxy alias belongs to, or null. Ambiguity (two people
 * with the same initial and last name) yields null: a wrong "Yes, that's me" would hand
 * someone else's reminders and messages to the viewer, so we only ever offer a certainty.
 */
function findCandidate(forgeUserId: string, forgeEmail: string | null, forgeName: string | null): Candidate | null {
  const email = (forgeEmail ?? "").trim().toLowerCase();
  const alias = aliasLocalPart(email);
  if (!alias || isValidIdentityEmail(email)) return null;
  if (alias.length < 2) return null;

  const db = getDb();
  const rows = db.prepare("SELECT id, name FROM users").all() as {
    id: string;
    name: string | null;
  }[];
  // The alias alone is not enough (asmith fits both Anna and Adam Smith). The SSO display
  // name, which the user cannot edit, must also fit the name in the candidate's EMAIL; the
  // agent-declared users.name is never consulted. No proxy name means no suggestion.
  const hits = rows.filter(
    (r) =>
      isValidIdentityEmail(r.id) &&
      aliasesOf(r.id).includes(alias) &&
      forgeNameMatchesEmail(forgeName, r.id),
  );
  if (hits.length !== 1) return null;

  const hit = hits[0];
  const owner = db.prepare("SELECT forge_user_id FROM forge_links WHERE user_id = ?").get(hit.id) as
    | { forge_user_id: string }
    | undefined;
  return {
    email: hit.id,
    name: hit.name || forgeName?.trim() || derivedNameFromEmail(hit.id),
    linkedElsewhere: !!owner && owner.forge_user_id !== forgeUserId,
  };
}

/**
 * A guess at who an unlinked proxy viewer is, for the one-click "Yes, that's me". Null
 * unless exactly one long-form user fits the alias and nobody else's browser is already
 * linked to them.
 */
export function suggestLinkFor(
  forgeUserId: string,
  forgeEmail: string | null,
  forgeName: string | null,
): LinkSuggestion | null {
  const c = findCandidate(forgeUserId, forgeEmail, forgeName);
  if (!c || c.linkedElsewhere) return null;
  return { email: c.email, name: c.name };
}

/**
 * Links the viewer to the suggested user. The suggestion is recomputed here and the
 * client's email is only compared against it, never trusted, so a forged POST cannot link
 * anyone but the person the alias points to. First come wins: an already-linked user, or a
 * proxy id already linked to someone else, is a 409 rather than a silent takeover (the
 * code flow through an authenticated agent is the only way to replace a link).
 */
export function claimSuggestedLink(
  forgeUserId: string,
  forgeEmail: string | null,
  forgeName: string | null,
  claimedEmail: string,
): { email: string } {
  const claimed = typeof claimedEmail === "string" ? claimedEmail.trim().toLowerCase() : "";
  const db = getDb();

  const existing = getLinkedUserId(forgeUserId);
  if (existing) {
    if (existing === claimed) return { email: existing };
    throw new ConflictError("This browser is already linked to someone");
  }

  const c = findCandidate(forgeUserId, forgeEmail, forgeName);
  if (!c || c.email !== claimed) throw new ValidationError("That is not the identity suggested for this browser");
  if (c.linkedElsewhere) throw new ConflictError("That identity is already linked to another browser");

  db.prepare("INSERT INTO forge_links (forge_user_id, user_id, linked_at) VALUES (?, ?, datetime('now'))").run(
    forgeUserId,
    c.email,
  );
  audit(db, { id: c.email, name: c.name, email: c.email }, "link-browser-claim", "forge_link", forgeUserId, "ui", {
    details: { forgeEmail: forgeEmail?.trim().toLowerCase() ?? null, forgeName },
  });
  return { email: c.email };
}

/**
 * P1.0: a signed-in viewer with no identity types their long-form address and links their own
 * browser, with no agent involved. The same two checks as "That's me" and the code redeem
 * guard it, and neither trusts the typed address on its own: the SSO display name (which the
 * user cannot edit) must fit the name in the address (forgeNameMatchesEmail), and an
 * @example.com SSO email is required and must be that person's alias (ssoEmailFitsTyped). Then first come wins: a browser already
 * linked elsewhere, or an address already linked to another browser, is a 409. Creates the
 * users row when no agent has made one yet, so a brand-new colleague can see their reminders with
 * nothing but a browser. Errors are one plain line each; they say why without naming anyone.
 */
export function claimTypedIdentity(
  forgeUserId: string,
  forgeEmail: string | null,
  forgeName: string | null,
  typedEmail: string,
): { email: string } {
  const typed = typeof typedEmail === "string" ? typedEmail.trim().toLowerCase() : "";
  if (!isValidIdentityEmail(typed)) {
    throw new ValidationError(`Type your long address, ${identityHint()}`);
  }
  const db = getDb();

  const existing = getLinkedUserId(forgeUserId);
  if (existing) {
    if (existing === typed) return { email: existing };
    throw new ConflictError("This browser is already linked to someone. Unlink it first.");
  }

  if (!forgeNameMatchesEmail(forgeName, typed)) {
    audit(db, forgeUserId, "link-refused", "forge_link", forgeUserId, "ui", { details: { reason: "typed-mismatch" } });
    throw new ForbiddenError(
      "That address does not fit the name your sign-in shows. Ask a maintainer for help (they use /admin/links).",
    );
  }

  if (!ssoEmailFitsTyped(forgeEmail, typed)) {
    audit(db, forgeUserId, "link-refused", "forge_link", forgeUserId, "ui", { details: { reason: "typed-sso-email" } });
    throw new ForbiddenError(
      `Your sign-in does not show an @${identityDomain()} address that fits this one. Ask a maintainer for help (they use /admin/links).`,
    );
  }

  if (db.prepare("SELECT 1 FROM forge_links WHERE user_id = ?").get(typed)) {
    audit(db, typed, "link-refused", "forge_link", forgeUserId, "ui", { details: { reason: "email-linked-elsewhere" } });
    throw new ConflictError(
      "That address is already linked to another browser. Ask a maintainer for help (they use /admin/links).",
    );
  }

  const user = upsertUser({ id: typed, email: typed, name: null, roles: [] }, "ui");
  db.prepare("INSERT INTO forge_links (forge_user_id, user_id, linked_at) VALUES (?, ?, datetime('now'))").run(
    forgeUserId,
    typed,
  );
  audit(db, { id: typed, name: user.name, email: typed }, "link-browser-claim", "forge_link", forgeUserId, "ui", {
    details: { forgeEmail: forgeEmail?.trim().toLowerCase() ?? null, forgeName },
  });
  return { email: typed };
}

export interface LinkRow {
  forgeUserId: string;
  userId: string;
  linkedAt: string;
  /** From the claim audit row; null for links made through the agent code flow. */
  forgeEmail: string | null;
  forgeName: string | null;
}

/** Every browser link, newest first, for the maintainer page. Callers check maintainership. */
export function listLinks(): LinkRow[] {
  const rows = getDb()
    .prepare(
      `SELECT l.forge_user_id AS forgeUserId, l.user_id AS userId, l.linked_at AS linkedAt,
         (SELECT a.details FROM audit_log a
            WHERE a.action = 'link-browser-claim' AND a.entity_id = l.forge_user_id
            ORDER BY a.id DESC LIMIT 1) AS details
       FROM forge_links l ORDER BY l.linked_at DESC, l.rowid DESC`,
    )
    .all() as { forgeUserId: string; userId: string; linkedAt: string; details: string | null }[];
  return rows.map((r) => {
    let d: { forgeEmail?: string | null; forgeName?: string | null } = {};
    try {
      d = r.details ? JSON.parse(r.details) : {};
    } catch {
      d = {};
    }
    return {
      forgeUserId: r.forgeUserId,
      userId: r.userId,
      linkedAt: r.linkedAt,
      forgeEmail: d.forgeEmail ?? null,
      forgeName: d.forgeName ?? null,
    };
  });
}

/**
 * A signed-in viewer unlinks their own browser (decision 1, 2026-10-01: re-linking a linked
 * proxy id is refused, so this is how a wrong first link is fixed). Keyed on the proxy id
 * from SSO, never on anything the client sends, so it can only remove the caller's own row.
 * Null when this browser was not linked.
 */
export function unlinkOwnBrowser(forgeUserId: string): { email: string } | null {
  const email = getLinkedUserId(forgeUserId);
  if (!email) return null;
  const db = getDb();
  db.prepare("DELETE FROM forge_links WHERE forge_user_id = ?").run(forgeUserId);
  // Devices connected through this link stop working with it, so a wrong first link cannot
  // leave a live device for whoever was mislinked.
  const revoked = revokeDevicesBoundVia(forgeUserId);
  audit(db, email, "unlink-browser-self", "forge_link", forgeUserId, "ui", { details: { email, devicesRevoked: revoked } });
  return { email };
}

/**
 * Undo a wrong link (maintainers only; 403 while BAB_MAINTAINERS is unset). Removes the
 * forge_links row(s) for the email or proxy id. The person can link their own browser
 * again afterwards.
 */
export function unlinkBrowser(
  maintainerId: string,
  target: { email?: string; forgeUserId?: string },
): { removed: number } {
  assertMaintainer(maintainerId, "unlink a browser");
  const email = target.email?.trim().toLowerCase();
  const forgeUserId = target.forgeUserId?.trim();
  if (!email && !forgeUserId) throw new ValidationError("email or forgeUserId is required");

  const db = getDb();
  const rows = (
    email
      ? db.prepare("SELECT forge_user_id, user_id FROM forge_links WHERE user_id = ?").all(email)
      : db.prepare("SELECT forge_user_id, user_id FROM forge_links WHERE forge_user_id = ?").all(forgeUserId ?? "")
  ) as { forge_user_id: string; user_id: string }[];
  if (rows.length === 0) throw new NotFoundError("No such link");

  for (const row of rows) {
    db.prepare("DELETE FROM forge_links WHERE forge_user_id = ?").run(row.forge_user_id);
    // One browser per address, so every device of that address goes too, not only the ones
    // that came through this proxy id.
    const revoked = revokeDevicesBoundVia(row.forge_user_id) + revokeDevicesForUser(row.user_id);
    // A maintainer unlink ends the address's identified connections too.
    const connections = deleteConnectionsForUser(row.user_id);
    audit(db, maintainerId, "unlink-browser", "forge_link", row.forge_user_id, "ui", {
      details: { email: row.user_id, devicesRevoked: revoked, connectionsEnded: connections },
    });
  }
  return { removed: rows.length };
}
