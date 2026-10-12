/**
 * Every deployment-specific setting, read once from the environment with neutral defaults.
 * Nothing else in the app should read BAB_* directly. `identity.maintainers` is the one live
 * field: it re-reads BAB_MAINTAINERS on each access so a settings change needs no restart.
 */
import { readFileSync } from "node:fs";
import { CONFIG_SPEC } from "./config-spec.mjs";

/** Every environment variable the app reads; docs/configuration.md is generated from it. */
export { CONFIG_SPEC };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface BabConfig {
  identity: {
    emailPattern: RegExp;
    aliasPattern: RegExp | null;
    hint: string;
    allowedEmails: Set<string> | null;
    maintainers: Set<string>;
  };
  proxy: {
    trustIdentity: boolean;
    headerUserId: string;
    headerEmail: string;
    headerName: string;
    headerRoles: string;
    secret: string | null;
    trustForwarded: boolean;
  };
  network: { publicOrigin: string | null; maxBodyBytes: number };
  tokens: Set<string> | null;
  tokenIdentities: Map<string, string>;
  redact: { pii: boolean; domains: string[] };
  sourceHosts: string[] | null;
  projectKeyPrefixes: string[];
  branding: {
    orgName: string;
    accentColor: string;
    pluginMarketplace: string;
    pluginMarketplaceName: string;
    locale: string;
    timeZone: string;
  };
  retention: { staleAfterDays: number; auditDays: number };
  devices: boolean;
  inboxPage: boolean;
  clientIpHeader: "x-real-ip" | "x-forwarded-for-rightmost" | null;
  /** The unrecognised BAB_CLIENT_IP_HEADER value (lowercased) that was ignored, for a one-time warning; else null. */
  clientIpHeaderInvalid: string | null;
}

type Env = NodeJS.ProcessEnv;

/** Value of `name`, or of the deprecated `alias` (with one warning) when `name` is unset. */
function read(env: Env, name: string, alias?: string): string | undefined {
  const v = env[name];
  if (v !== undefined && v !== "") return v;
  if (alias) {
    const a = env[alias];
    if (a !== undefined && a !== "") {
      console.warn("[config] " + alias + " is deprecated, use " + name);
      return a;
    }
  }
  return undefined;
}

function str(env: Env, name: string, def: string): string {
  return read(env, name)?.trim() || def;
}

function optStr(env: Env, name: string): string | null {
  return read(env, name)?.trim() || null;
}

function bool(env: Env, name: string, def: boolean, alias?: string): boolean {
  const v = read(env, name, alias)?.trim().toLowerCase();
  if (v === undefined) return def;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(name + ' must be a boolean (1/0, true/false), got "' + v + '"');
}

function int(env: Env, name: string, def: number): number {
  const v = read(env, name)?.trim();
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(name + ' must be a positive integer, got "' + v + '"');
  return n;
}

function csvOf(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function csv(env: Env, name: string): string[] {
  return csvOf(read(env, name));
}

function regex(env: Env, name: string, def: string | null): RegExp | null {
  const v = read(env, name)?.trim() ?? def;
  if (v === null) return null;
  try {
    return new RegExp(v, "i");
  } catch (e) {
    throw new ConfigError(name + " is not a valid regular expression: " + (e as Error).message);
  }
}

function origin(env: Env, name: string): string | null {
  const v = read(env, name)?.trim();
  if (!v) return null;
  try {
    return new URL(v).origin;
  } catch {
    throw new ConfigError(name + ' must be an absolute URL, got "' + v + '"');
  }
}

function parseTokens(raw: string, emailPattern: RegExp): { tokens: Set<string>; identities: Map<string, string> } {
  const tokens = new Set<string>();
  const identities = new Map<string, string>();
  for (const entry of raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.lastIndexOf("=");
    // token=email only when the part after the last "=" is an email; otherwise "=" is part of the
    // token (base64 padding).
    if (eq < 0 || !entry.slice(eq + 1).includes("@")) tokens.add(entry);
    else {
      const t = entry.slice(0, eq).trim();
      const email = entry.slice(eq + 1).trim().toLowerCase();
      if (!t || !email) throw new ConfigError("BAB_API_TOKENS has a malformed token=email entry");
      if (!emailPattern.test(email)) throw new ConfigError("BAB_API_TOKENS has a token=email entry whose email does not match BAB_IDENTITY_EMAIL_PATTERN");
      identities.set(t, email);
    }
  }
  return { tokens, identities };
}

function maintainersNow(): Set<string> {
  return new Set(csvOf(process.env.BAB_MAINTAINERS).map((v) => v.toLowerCase()));
}

function parse(env: Env): BabConfig {
  if (read(env, "BAB_TRUST_PROXY_IDENTITY") !== undefined && read(env, "BAB_TRUST_FORGE_HEADERS") !== undefined) {
    console.warn("[config] BAB_TRUST_FORGE_HEADERS is ignored because BAB_TRUST_PROXY_IDENTITY is set; it can be removed");
  }
  const trustIdentity = bool(env, "BAB_TRUST_PROXY_IDENTITY", false, "BAB_TRUST_FORGE_HEADERS");
  if (trustIdentity && optStr(env, "BAB_PROXY_SECRET") === null) {
    console.warn("[config] proxy identity trusted without a shared secret; make sure the pod is reachable only through the proxy");
  }
  const locale = str(env, "BAB_LOCALE", "en");
  const timeZone = str(env, "BAB_TIMEZONE", "UTC");
  try {
    new Intl.DateTimeFormat(locale, {});
  } catch {
    throw new ConfigError('BAB_LOCALE is not a valid locale, got "' + locale + '"');
  }
  try {
    new Intl.DateTimeFormat(locale, { timeZone });
  } catch {
    throw new ConfigError('BAB_TIMEZONE is not a valid time zone, got "' + timeZone + '"');
  }
  const accent = str(env, "BAB_ACCENT_COLOR", "#1a3360").toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(accent)) {
    throw new ConfigError('BAB_ACCENT_COLOR must match #rrggbb (lowercase hex), got "' + accent + '"');
  }

  // An unrecognised value is treated as unset (lib/client-ip.ts warns once), never a startup failure.
  const clientIpRaw = optStr(env, "BAB_CLIENT_IP_HEADER")?.toLowerCase() ?? null;
  const clientIp = clientIpRaw === "x-real-ip" || clientIpRaw === "x-forwarded-for-rightmost" ? clientIpRaw : null;
  const clientIpInvalid = clientIpRaw !== null && clientIp === null ? clientIpRaw : null;

  const emailPattern = regex(env, "BAB_IDENTITY_EMAIL_PATTERN", "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")!;
  const inline = read(env, "BAB_API_TOKENS");
  const file = read(env, "BAB_API_TOKENS_FILE")?.trim();
  let rawTokens: string | null = inline ?? null;
  if (file) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch (e) {
      throw new ConfigError("BAB_API_TOKENS_FILE could not be read: " + (e as Error).message);
    }
    rawTokens = rawTokens ? rawTokens + "," + content : content;
  }
  const parsed = rawTokens !== null ? parseTokens(rawTokens, emailPattern) : null;

  const allowed = csv(env, "BAB_ALLOWED_EMAILS").map((v) => v.toLowerCase());
  const hosts = csv(env, "BAB_SOURCE_HOSTS").map((v) => v.toLowerCase());

  return {
    identity: {
      emailPattern,
      aliasPattern: regex(env, "BAB_IDENTITY_ALIAS_PATTERN", null),
      hint: str(env, "BAB_IDENTITY_HINT", "you@example.com"),
      allowedEmails: allowed.length ? new Set(allowed) : null,
      get maintainers() {
        return maintainersNow();
      },
    },
    proxy: {
      trustIdentity,
      headerUserId: str(env, "BAB_HEADER_USER_ID", "x-auth-request-user").toLowerCase(),
      headerEmail: str(env, "BAB_HEADER_EMAIL", "x-auth-request-email").toLowerCase(),
      headerName: str(env, "BAB_HEADER_NAME", "x-auth-request-preferred-username").toLowerCase(),
      headerRoles: str(env, "BAB_HEADER_ROLES", "x-auth-request-groups").toLowerCase(),
      secret: optStr(env, "BAB_PROXY_SECRET"),
      trustForwarded: bool(env, "BAB_TRUST_PROXY", false),
    },
    network: { publicOrigin: origin(env, "BAB_PUBLIC_ORIGIN"), maxBodyBytes: int(env, "BAB_MAX_BODY_BYTES", 1048576) },
    tokens: parsed && parsed.tokens.size ? parsed.tokens : null,
    tokenIdentities: parsed?.identities ?? new Map(),
    redact: { pii: bool(env, "BAB_REDACT_PII", true), domains: csv(env, "BAB_REDACT_DOMAINS").map((v) => v.toLowerCase()) },
    sourceHosts: hosts.length ? hosts : null,
    projectKeyPrefixes: csv(env, "BAB_PROJECT_KEY_PREFIXES"),
    branding: {
      orgName: str(env, "BAB_ORG_NAME", "BAB"),
      accentColor: accent,
      pluginMarketplace: str(env, "BAB_PLUGIN_MARKETPLACE", "enhesa/big-agentic-brain"),
      pluginMarketplaceName: str(env, "BAB_PLUGIN_MARKETPLACE_NAME", "big-agentic-brain"),
      locale,
      timeZone,
    },
    retention: { staleAfterDays: int(env, "BAB_STALE_AFTER_DAYS", 90), auditDays: int(env, "BAB_AUDIT_RETENTION_DAYS", 365) },
    devices: bool(env, "BAB_DEVICES", true),
    inboxPage: bool(env, "BAB_INBOX_PAGE", true),
    clientIpHeader: clientIp,
    clientIpHeaderInvalid: clientIpInvalid,
  };
}

let cached: BabConfig | null = null;

export function config(): BabConfig {
  if (!cached) cached = parse(process.env);
  return cached;
}

export function _resetConfigForTests(): void {
  cached = null;
}

/** How agents are told what a Confluence source_url looks like: the configured hosts, else any https link. */
export function sourceLinkText(c: BabConfig = config()): string {
  return c.sourceHosts ? "an https link on " + c.sourceHosts.join(", ") + "/wiki/" : "an https link";
}

/** Nobody has to prove who they are: no proxy identity and no API tokens. */
export function isOpen(c: BabConfig = config()): boolean {
  return !c.proxy.trustIdentity && c.tokens === null && c.tokenIdentities.size === 0;
}

function mask(v: string | null): string {
  return v === null ? "unset" : "set(" + v.length + " chars, masked)";
}

/** One line per group, secrets masked; a WARN line when the app is open. */
export function logEffectiveConfig(log: (line: string) => void = (l) => console.log(l)): void {
  const c = config();
  const id = c.identity;
  const p = c.proxy;
  log("[config] identity: emailPattern=" + id.emailPattern.source + " aliasPattern=" + (id.aliasPattern?.source ?? "none") + " hint=" + id.hint + " allowedEmails=" + (id.allowedEmails?.size ?? "any") + " maintainers=" + id.maintainers.size);
  log("[config] proxy: trustIdentity=" + p.trustIdentity + " headers=" + [p.headerUserId, p.headerEmail, p.headerName, p.headerRoles].join(",") + " secret=" + mask(p.secret) + " trustForwarded=" + p.trustForwarded);
  log("[config] network: publicOrigin=" + (c.network.publicOrigin ?? "none") + " maxBodyBytes=" + c.network.maxBodyBytes + " clientIpHeader=" + (c.clientIpHeader ?? "none"));
  log("[config] tokens: bare=" + (c.tokens ? c.tokens.size + " (masked)" : "none") + " withIdentity=" + c.tokenIdentities.size + " (masked)");
  log("[config] redact: pii=" + c.redact.pii + " domains=" + (c.redact.domains.join(",") || "none") + " sourceHosts=" + (c.sourceHosts?.join(",") ?? "any") + " projectKeyPrefixes=" + (c.projectKeyPrefixes.join(",") || "none"));
  const b = c.branding;
  log("[config] branding: org=" + b.orgName + " accent=" + b.accentColor + " marketplace=" + b.pluginMarketplace + " (" + b.pluginMarketplaceName + ") locale=" + b.locale + " tz=" + b.timeZone);
  log("[config] features: staleAfterDays=" + c.retention.staleAfterDays + " auditDays=" + c.retention.auditDays + " devices=" + c.devices + " inboxPage=" + c.inboxPage);
  if (isOpen(c)) {
    log("[config] WARN: open mode, no proxy identity and no API tokens configured, callers are not authenticated");
  }
}
