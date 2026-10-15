import { headers } from "next/headers";
import { config } from "./config";
import { currentUser, type ForgeUser } from "./user";
import { getUser, upsertUser } from "./users";
import { checkRateLimit, checkAnonNewIdentity, RATE_LIMIT_PER_MINUTE } from "./rate-limit";
import { clientIp, clientIpVerified } from "./client-ip";
import { tokenIdentityFor } from "./gate";
import { scheduleMaintenance } from "./maintenance";
import {
  derivedNameFromEmail,
  forgeNameMatchesEmail,
  identityHint,
  identityRejectionText,
  isAliasEmail,
  isValidIdentityEmail,
} from "./identity";
import { getLinkedUserId } from "./forge-links";
import { devicesEnabled, hashSecret, lookupDevice, DEVICE_HEADER } from "./devices";
import { lookupConnection, MCP_SESSION_HEADER, isSessionId } from "./mcp-connections";

export type IdentitySource = "forge" | "declared" | "device" | "connection";

export interface SessionUser extends ForgeUser {
  /**
   * "forge" = came from proxy identity headers; "declared" = X-Bab-Actor-* agent headers,
   * self-asserted; "device" = a device secret an earlier bab_identify bound to a person
   * (lib/devices.ts); "connection" = an MCP connection (Mcp-Session-Id) bab_identify bound.
   * Device and connection are also the person's own word, remembered: BAB's identity is an honour
   * system; the deployment must sit on a private network, behind an
   * authenticating proxy, or use bound tokens.
   */
  source: IdentitySource;
  /** Only for source "forge": the SSO proxy id, kept because `id` is the linked long-form email. */
  forgeUserId?: string;
  /** Only for source "device": the devices row id (never the secret or its hash). */
  deviceId?: string;
}

/**
 * Where a device secret is honoured. "off" is every SSO page and route: a stolen secret must
 * never drive a browser-only route. "api" is /api/* and /mcp.
 */
type AgentMode = "off" | "api";

/** True only when the operator has explicitly declared that the sign-in proxy fronts this app. */
export function trustForgeHeaders(): boolean {
  return config().proxy.trustIdentity;
}

interface DeclaredActor {
  email: string;
  name: string;
}

/**
 * Validates a candidate {email, name} pair. Anything invalid is treated as
 * absent (null), never thrown — callers fall through to the next identity
 * source.
 */
function validateActor(
  emailRaw: unknown,
  nameRaw: unknown,
): DeclaredActor | null {
  if (typeof emailRaw !== "string" || typeof nameRaw !== "string") return null;

  const email = emailRaw.trim();
  if (!isValidIdentityEmail(email)) return null;

  const name = nameRaw.trim();
  if (name.length < 2 || name.length > 80) return null;

  return { email: email.toLowerCase(), name };
}

function toSessionUser(actor: DeclaredActor): SessionUser {
  return {
    id: actor.email,
    email: actor.email,
    name: actor.name,
    roles: [],
    source: "declared",
  };
}

/** X-Bab-Actor-Email / X-Bab-Actor-Name headers: how agents identify themselves. */
async function fromAgentHeaders(mode: AgentMode): Promise<SessionUser | null> {
  // Web paths (mode "off") never take a declared actor once tokens are configured: the token
  // gate does not cover them, so headers there would bypass token mode. Without tokens, open mode.
  if (mode === "off") {
    // Behind a trusting proxy, web viewers are who the proxy says; a viewer it did not identify
    // (wrong secret, unlinked) must not be able to declare a person instead.
    if (trustForgeHeaders()) return null;
    const c = config();
    if ((c.tokens?.size ?? 0) > 0 || c.tokenIdentities.size > 0) return null;
  }
  const h = await headers();
  const actor = validateActor(
    h.get("x-bab-actor-email"),
    h.get("x-bab-actor-name"),
  );
  return actor ? toSessionUser(actor) : null;
}

/**
 * A bearer token configured as token=email IS that person: the email replaces any declared actor
 * (and any device or connection), so a token holder cannot act as someone else. A bare token only
 * gates access (lib/gate.ts) and leaves identity resolution to the later steps.
 */
async function fromToken(mode: AgentMode): Promise<SessionUser | null> {
  if (mode === "off") return null;
  const email = tokenIdentityFor(await headers());
  if (!email) return null;
  const stored = getUser(email);
  return { id: email, email, name: stored?.name ?? derivedNameFromEmail(email), roles: [], source: "declared" };
}

/**
 * The remembered-identity steps. They run only where the caller opted in with an AgentMode,
 * never on SSO paths. Order: a known device, then a known connection, then (the caller's next
 * step) the X-Bab-Actor-* headers. A known device decides outright, so a header cannot talk a
 * remembered device into being someone else. A device that is unknown OR forgotten (revoked) is
 * not an error: it falls through, so installs that predate devices keep working, and
 * bab_identify binds it. BAB_DEVICES=0 skips both steps (kill switch). Neither the secret, its
 * hash nor the session id is ever echoed.
 */
async function fromDevice(mode: AgentMode): Promise<SessionUser | null> {
  if (mode === "off") return null;
  const state = await deviceState();
  if (!state?.device) return null;
  const { device } = state;
  const stored = getUser(device.userId);
  return {
    id: device.userId,
    email: device.userId,
    name: stored?.name ?? derivedNameFromEmail(device.userId),
    roles: [],
    source: "device",
    deviceId: device.id,
  };
}

async function fromConnection(mode: AgentMode): Promise<SessionUser | null> {
  if (mode === "off") return null;
  const state = await connectionState();
  if (!state?.userId) return null;
  const stored = getUser(state.userId);
  return {
    id: state.userId,
    email: state.userId,
    name: stored?.name ?? derivedNameFromEmail(state.userId),
    roles: [],
    source: "connection",
  };
}

export interface DeviceState {
  /** sha256 of the presented secret; the only form of it that leaves this function. */
  hash: string;
  known: boolean;
  device: ReturnType<typeof lookupDevice>;
}

/**
 * What the request says about a device: null when there is no usable X-Bab-Device (absent,
 * malformed, or BAB_DEVICES=0), else its hash and whether it is a known live device. The MCP
 * route uses this to bind bab_identify to the right secret.
 */
export async function deviceState(): Promise<DeviceState | null> {
  if (!devicesEnabled()) return null;
  // Lowercased before validating: a hex secret that went through something that upper-cased it
  // is still the same secret.
  const hash = hashSecret((await headers()).get(DEVICE_HEADER)?.trim().toLowerCase());
  if (!hash) return null;
  const device = lookupDevice(hash);
  return { hash, known: device !== null, device };
}

export interface ConnectionState {
  /** The well-formed Mcp-Session-Id the request carries. */
  id: string;
  /** Whether BAB has this connection. An unknown id is not an error: it is simply no connection. */
  known: boolean;
  /** Who the connection said it was, or null if it never identified. */
  userId: string | null;
}

/** What the request says about its MCP connection: null with no usable Mcp-Session-Id (or BAB_DEVICES=0). */
export async function connectionState(): Promise<ConnectionState | null> {
  if (!devicesEnabled()) return null;
  const id = (await headers()).get(MCP_SESSION_HEADER)?.trim();
  if (!isSessionId(id)) return null;
  const row = lookupConnection(id);
  return { id, known: row !== null, userId: row?.userId ?? null };
}

/**
 * Resolves the acting identity for this request. Source order:
 *   1. Sign-in proxy identity headers, when trusted: see lib/user.ts.
 *   2. A known device (X-Bab-Device), then a known connection (Mcp-Session-Id), only when the
 *      caller passes an AgentMode (the agent API and /mcp do; pages and proxy-identity routes never do).
 *      See fromDevice and fromConnection.
 *   3. Agent headers (X-Bab-Actor-Email / X-Bab-Actor-Name), self-asserted. An
 *      Authorization header is not read for identity: old plugin configs that still send a bearer
 *      are simply ignored, never refused. (The API-token gate in lib/gate.ts reads it, upstream
 *      of this.) The client address only keys the per-IP caps, and only when verified.
 * The web UI is read-only and needs no identity of its own; only the agent
 * API (requireActorForApi) requires this to resolve.
 * Upserts the resolved user's row on every hit.
 */
/**
 * A signed-in viewer is keyed on their long-form email, not the proxy's user id: agents
 * identify with that email (X-Bab-Actor-Email), so users, reminders and threads are all
 * stored under it, and a proxy id would be a second, empty person on the Usage page
 * (the web UI shows your own reminders). A proxy email that is not
 * long-form is treated as no identity rather than a new user — UNLESS this proxy id has
 * already been linked (forge_links, lib/forge-links.ts): a proxy may send only a short alias
 * in the email header, so the one-time browser link is the only way most viewers ever
 * get an identity here at all. The link is checked first: it must win even for someone
 * whose proxy email happens to be long-form, since a confirmed link is what the person
 * actually asserted.
 */
function fromForge(user: ForgeUser | null): SessionUser | null {
  if (!user) return null;

  const linkedUserId = getLinkedUserId(user.id);
  if (linkedUserId) {
    // Links made in the old "latest link wins" era were never name-checked. The SSO name
    // cannot be edited by the user, so a link it does not fit is not trusted.
    if (forgeNameMatchesEmail(user.name, linkedUserId)) {
      return { ...user, id: linkedUserId, email: linkedUserId, source: "forge", forgeUserId: user.id };
    }
    console.warn(`bab: stored link for forge id ${user.id} does not fit the SSO name; treating as unlinked`);
    return null;
  }

  const email = user.email?.trim().toLowerCase() ?? "";
  if (!isValidIdentityEmail(email)) {
    // Shape only, never the address itself: says why a signed-in viewer got no identity.
    console.warn(
      `bab: signed-in viewer has no long-form email (${email ? (email.includes("@") ? "short alias or other domain" : "not an email") : "empty"})`,
    );
    return null;
  }
  return { ...user, id: email, email, source: "forge", forgeUserId: user.id };
}

/**
 * For app/reminders/page.tsx only: a trusted proxy viewer who resolves to no identity
 * (fromForge returned null — no forge_links row, and their proxy email isn't long-form)
 * is still a real signed-in person the page can point at /me/devices. Returns their
 * proxy user only in exactly that case; null whenever fromForge would already resolve
 * an identity (linked, or a long-form email) or there's no trusted proxy viewer at all —
 * so the page never nudges someone who needs nothing, nor someone already linked.
 * Returns the whole proxy user (for /notify/identity, whose one-click suggestion checks its SSO email and name).
 */
export async function pendingForgeLinkUser(): Promise<ForgeUser | null> {
  if (!trustForgeHeaders()) return null;
  const user = await currentUser();
  if (!user) return null;
  if (getLinkedUserId(user.id)) return null;

  const email = user.email?.trim().toLowerCase() ?? "";
  if (isValidIdentityEmail(email)) return null;

  return user;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  return (await resolveIdentity("off")).user;
}

async function resolveIdentity(mode: AgentMode): Promise<{ user: SessionUser | null }> {
  // proxy identity headers are only trustworthy when the sign-in proxy is the sole way in,
  // because the proxy strips any incoming copy before adding its own. With SSO off the
  // app is reachable directly, so anyone who can reach it could forge them. Flag semantics:
  // unset means "do not trust" (the safe state); set BAB_TRUST_PROXY_IDENTITY=1 together
  // with sso.enabled: true.
  const forgeUser = trustForgeHeaders() ? fromForge(await currentUser()) : null;
  let resolved: SessionUser | null = forgeUser;

  if (!resolved) {
    resolved = (await fromToken(mode)) ?? (await fromDevice(mode)) ?? (await fromConnection(mode)) ?? (await fromAgentHeaders(mode));
  }

  if (!resolved) return { user: null };

  // Before any identity is proven, one address may mint only so many new users from declared
  // headers. A token-pinned identity is authenticated and not counted. Only when the operator
  // declared which client-address header is real (BAB_CLIENT_IP_HEADER): otherwise the address
  // is caller-controlled and the cap would be a lever to lock others out.
  if (clientIpVerified() && resolved.source === "declared" && !getUser(resolved.id) && !tokenIdentityFor(await headers())) {
    if (!checkAnonNewIdentity(clientIp(await headers()))) {
      if (mode === "off") return { user: null };
      throw tooManyRequestsFor("Too many new identities from this address; try again later");
    }
  }

  // The stored row is canonical: a declared identity may only assert WHO it is (the
  // email); the display name is fixed at first use and changed only via POST /api/me.
  const stored = upsertUser(resolved);
  if (stored?.name) resolved.name = stored.name;
  return { user: resolved };
}

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function tooManyRequestsFor(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "3600" },
  });
}

function tooManyRequests(): Response {
  return new Response(JSON.stringify({ error: `Rate limit exceeded: ${RATE_LIMIT_PER_MINUTE} requests/minute per identity` }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

async function resolveIdentityOrThrow(mode: Exclude<AgentMode, "off">): Promise<SessionUser> {
  const { user } = await resolveIdentity(mode);
  if (!user) {
    const h = await headers();
    const email = h.get("x-bab-actor-email");
    const name = h.get("x-bab-actor-name");
    if (!email || !name) {
      throw unauthorized(
        "Identity required: send X-Bab-Actor-Email and X-Bab-Actor-Name",
      );
    }
    if (isAliasEmail(email.trim())) {
      throw unauthorized("Identity rejected: " + identityRejectionText(email.trim()));
    }
    throw unauthorized(
      `Identity rejected: X-Bab-Actor-Email must be an address in the form ${identityHint()} and X-Bab-Actor-Name 2-80 characters`,
    );
  }
  return user;
}

/**
 * For API routes: 401 JSON when there is no resolvable identity, 429 JSON
 * once the resolved actor is over the in-memory rate limit. Every agent API
 * route calls this first, which centralizes both checks.
 */
export async function requireActorForApi(): Promise<SessionUser> {
  const user = await resolveIdentityOrThrow("api");
  if (!checkRateLimit(user.id)) {
    throw tooManyRequests();
  }
  // Opportunistic retention sweep: scheduled off the request's own execution
  // (setImmediate), guarded to at most once/hour, never throws. See lib/maintenance.ts.
  scheduleMaintenance();
  return user;
}
