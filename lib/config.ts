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
  /** Extra platform labels for applies-to (BAB_EXTRA_APPLIES_TO), lowercase, validated. */
  extraAppliesTo: string[];
  /** Team slugs (BAB_TEAM_TAGS), lowercase, validated, in the order given. */
  teamTags: string[];
  branding: {
    orgName: string;
    accentColor: string;
    pluginMarketplace: string;
    pluginMarketplaceName: string;
    /** Optional landing-page install screenshot (site path or https URL), and its alt text. */
    installScreenshot: string | null;
    installScreenshotAlt: string;
    locale: string;
    timeZone: string;
  };
  retention: { staleAfterDays: number; auditDays: number };
  devices: boolean;
  /** Default MCP tool list (BAB_MCP_TOOLS): full, or lean (bab_search, bab_learn, bab_react). A connection can override it with ?tools=. */
  mcpTools: "full" | "lean";
  inboxPage: boolean;
  /** Command Center (lib/command-center.ts): the page, its routes and the MCP tool. */
  commandCenter: boolean;
  /** The file store (lib/files.ts). Sizes in bytes, expiry in days. */
  files: {
    enabled: boolean;
    maxFileBytes: number;
    userQuotaBytes: number;
    defaultExpiryDays: number;
    maxExpiryDays: number;
    diskFullPercent: number;
    /** Free bytes kept on top of twice the database size (BAB_FILES_DISK_RESERVE_BYTES). */
    diskReserveBytes: number;
    /** Longest one upload may take, in milliseconds (BAB_FILES_UPLOAD_DEADLINE_SECONDS). */
    uploadDeadlineMs: number;
    /** Lets header-declared and connection identities use the store (BAB_FILES_ALLOW_DECLARED). Local development only. */
    allowDeclared: boolean;
  };
  /** The key-value store (lib/kv.ts). Sizes in bytes, TTL in seconds. */
  kv: {
    enabled: boolean;
    /** Names allowed after shared/, such as "build-push" for shared/build-push/. Empty: no shared namespaces. */
    sharedNamespaces: string[];
    maxValueBytes: number;
    maxKeysPerUser: number;
    maxBytesPerUser: number;
    maxTotalBytes: number;
    maxTtlSeconds: number;
    /** Longest TTL a key in a shared namespace may have (at most maxTtlSeconds). */
    sharedMaxTtlSeconds: number;
    /** Keys and bytes one person may hold inside each shared namespace, counted against whoever wrote them. */
    sharedMaxKeysPerUser: number;
    sharedMaxBytesPerUser: number;
    /** Lets header-declared and connection identities use the store (BAB_KV_ALLOW_DECLARED). Local development only. */
    allowDeclared: boolean;
  };
  /** How many BAB processes serve this data (BAB_REPLICAS). BAB supports 1; above that the key-value store refuses every call. */
  replicas: number;
  clientIpHeader: "x-real-ip" | "x-forwarded-for-rightmost" | null;
  /** The unrecognised BAB_CLIENT_IP_HEADER value (lowercased) that was ignored, for a one-time warning; else null. */
  clientIpHeaderInvalid: string | null;
}

type Env = NodeJS.ProcessEnv;

/** Value of `name`, or undefined when it is unset or empty. */
function read(env: Env, name: string): string | undefined {
  const v = env[name];
  return v !== undefined && v !== "" ? v : undefined;
}

function str(env: Env, name: string, def: string): string {
  return read(env, name)?.trim() || def;
}

const DEFAULT_INSTALL_SCREENSHOT = "/install/claude-app-plugins.png";
const DEFAULT_INSTALL_SCREENSHOT_ALT =
  "Claude app. Step 1: Customize in the sidebar is boxed in red. Step 2: the search field, containing BAB, is boxed. Step 3: the Add button next to Big Agentic Brain is circled.";

/** A same-site path or an https URL, or "none" for no image; anything else fails at startup. */
function installScreenshotOf(value: string): string | null {
  if (value.toLowerCase() === "none") return null;
  if ((value.startsWith("/") && !value.startsWith("//")) || /^https:\/\/[^\s]+$/i.test(value)) return value;
  throw new Error("BAB_INSTALL_SCREENSHOT must be a path on this site (/install/claude-app-plugins.png), an https URL or none");
}

function optStr(env: Env, name: string): string | null {
  return read(env, name)?.trim() || null;
}

function bool(env: Env, name: string, def: boolean): boolean {
  const v = read(env, name)?.trim().toLowerCase();
  if (v === undefined) return def;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(name + ' must be a boolean (1/0, true/false), got "' + v + '"');
}

function mcpToolsOf(env: Env): "full" | "lean" {
  const v = read(env, "BAB_MCP_TOOLS")?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "full") return "full";
  if (v === "lean") return "lean";
  throw new ConfigError('BAB_MCP_TOOLS must be full or lean, got "' + v + '"');
}

function int(env: Env, name: string, def: number): number {
  const v = read(env, name)?.trim();
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(name + ' must be a positive integer, got "' + v + '"');
  return n;
}

/** The hard ceiling for one upload: reverse proxies in front of BAB commonly refuse bodies over 50 MB. */
export const FILES_MAX_FILE_BYTES_CEILING = 50 * 1024 * 1024;

function filesOf(env: Env): BabConfig["files"] {
  const maxFileBytes = int(env, "BAB_FILES_MAX_FILE_BYTES", 25 * 1024 * 1024);
  const userQuotaBytes = int(env, "BAB_FILES_USER_QUOTA_BYTES", 100 * 1024 * 1024);
  const defaultExpiryDays = int(env, "BAB_FILES_DEFAULT_EXPIRY_DAYS", 14);
  const maxExpiryDays = int(env, "BAB_FILES_MAX_EXPIRY_DAYS", 30);
  const diskFullPercent = int(env, "BAB_FILES_DISK_FULL_PERCENT", 85);
  const diskReserveBytes = int(env, "BAB_FILES_DISK_RESERVE_BYTES", 64 * 1024 * 1024);
  const deadlineSeconds = int(env, "BAB_FILES_UPLOAD_DEADLINE_SECONDS", 300);
  if (maxFileBytes > FILES_MAX_FILE_BYTES_CEILING) throw new ConfigError("BAB_FILES_MAX_FILE_BYTES must be at most " + FILES_MAX_FILE_BYTES_CEILING + ", got " + maxFileBytes);
  if (maxFileBytes > userQuotaBytes) throw new ConfigError("BAB_FILES_MAX_FILE_BYTES (" + maxFileBytes + ") must not exceed BAB_FILES_USER_QUOTA_BYTES (" + userQuotaBytes + ")");
  if (defaultExpiryDays > maxExpiryDays) throw new ConfigError("BAB_FILES_DEFAULT_EXPIRY_DAYS (" + defaultExpiryDays + ") must not exceed BAB_FILES_MAX_EXPIRY_DAYS (" + maxExpiryDays + ")");
  if (diskFullPercent > 99) throw new ConfigError("BAB_FILES_DISK_FULL_PERCENT must be 1-99, got " + diskFullPercent);
  // At most 30 minutes: the hourly sweep deletes temp uploads older than an hour.
  if (deadlineSeconds < 10 || deadlineSeconds > 1800) throw new ConfigError("BAB_FILES_UPLOAD_DEADLINE_SECONDS must be 10-1800, got " + deadlineSeconds);
  return {
    enabled: bool(env, "BAB_FILES", true),
    maxFileBytes,
    userQuotaBytes,
    defaultExpiryDays,
    maxExpiryDays,
    diskFullPercent,
    diskReserveBytes,
    uploadDeadlineMs: deadlineSeconds * 1000,
    allowDeclared: bool(env, "BAB_FILES_ALLOW_DECLARED", false),
  };
}

/** Hard ceilings for the key-value store: one value must fit in an MCP call, and the store lives in memory. */
export const KV_MAX_VALUE_BYTES_CEILING = 256 * 1024;
export const KV_MAX_TOTAL_BYTES_CEILING = 256 * 1024 * 1024;
export const KV_MAX_TTL_SECONDS_CEILING = 7 * 24 * 60 * 60;

function kvNamespaces(env: Env): string[] {
  const raw = read(env, "BAB_KV_SHARED_NAMESPACES")?.trim() ?? "bitbucket-push";
  if (raw.toLowerCase() === "none") return [];
  const names = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (v.startsWith("shared/") ? v.slice("shared/".length) : v).replace(/\/+$/, ""));
  if (names.length === 0) throw new ConfigError("BAB_KV_SHARED_NAMESPACES must hold at least one name, or none");
  for (const n of names) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(n) || n.includes("..")) {
      throw new ConfigError('BAB_KV_SHARED_NAMESPACES holds a name that is not lowercase letters, digits, dots, underscores and hyphens, got "' + n + '"');
    }
  }
  return [...new Set(names)];
}

function kvOf(env: Env): BabConfig["kv"] {
  const maxValueBytes = int(env, "BAB_KV_MAX_VALUE_BYTES", 64 * 1024);
  const maxKeysPerUser = int(env, "BAB_KV_MAX_KEYS_PER_USER", 1000);
  const maxBytesPerUser = int(env, "BAB_KV_MAX_BYTES_PER_USER", 4 * 1024 * 1024);
  const maxTotalBytes = int(env, "BAB_KV_MAX_TOTAL_BYTES", 20 * 1024 * 1024);
  const maxTtlSeconds = int(env, "BAB_KV_MAX_TTL_SECONDS", 24 * 60 * 60);
  if (maxValueBytes > KV_MAX_VALUE_BYTES_CEILING) throw new ConfigError("BAB_KV_MAX_VALUE_BYTES must be at most " + KV_MAX_VALUE_BYTES_CEILING + ", got " + maxValueBytes);
  if (maxValueBytes > maxBytesPerUser) throw new ConfigError("BAB_KV_MAX_VALUE_BYTES (" + maxValueBytes + ") must not exceed BAB_KV_MAX_BYTES_PER_USER (" + maxBytesPerUser + ")");
  if (maxBytesPerUser > maxTotalBytes) throw new ConfigError("BAB_KV_MAX_BYTES_PER_USER (" + maxBytesPerUser + ") must not exceed BAB_KV_MAX_TOTAL_BYTES (" + maxTotalBytes + ")");
  if (maxTotalBytes > KV_MAX_TOTAL_BYTES_CEILING) throw new ConfigError("BAB_KV_MAX_TOTAL_BYTES must be at most " + KV_MAX_TOTAL_BYTES_CEILING + ", got " + maxTotalBytes);
  if (maxTtlSeconds > KV_MAX_TTL_SECONDS_CEILING) throw new ConfigError("BAB_KV_MAX_TTL_SECONDS must be at most " + KV_MAX_TTL_SECONDS_CEILING + ", got " + maxTtlSeconds);
  // Unset: an hour, or the general maximum when that is shorter. Set: must not exceed the general maximum.
  const sharedMaxTtlSeconds = read(env, "BAB_KV_SHARED_MAX_TTL_SECONDS") === undefined ? Math.min(3600, maxTtlSeconds) : int(env, "BAB_KV_SHARED_MAX_TTL_SECONDS", 3600);
  const sharedMaxKeysPerUser = int(env, "BAB_KV_SHARED_MAX_KEYS_PER_USER", 50);
  const sharedMaxBytesPerUser = int(env, "BAB_KV_SHARED_MAX_BYTES_PER_USER", 512 * 1024);
  if (sharedMaxTtlSeconds > maxTtlSeconds) throw new ConfigError("BAB_KV_SHARED_MAX_TTL_SECONDS (" + sharedMaxTtlSeconds + ") must not exceed BAB_KV_MAX_TTL_SECONDS (" + maxTtlSeconds + ")");
  if (sharedMaxKeysPerUser > maxKeysPerUser) throw new ConfigError("BAB_KV_SHARED_MAX_KEYS_PER_USER (" + sharedMaxKeysPerUser + ") must not exceed BAB_KV_MAX_KEYS_PER_USER (" + maxKeysPerUser + ")");
  if (sharedMaxBytesPerUser > maxBytesPerUser) throw new ConfigError("BAB_KV_SHARED_MAX_BYTES_PER_USER (" + sharedMaxBytesPerUser + ") must not exceed BAB_KV_MAX_BYTES_PER_USER (" + maxBytesPerUser + ")");
  return {
    enabled: bool(env, "BAB_KV", true),
    sharedNamespaces: kvNamespaces(env),
    maxValueBytes,
    maxKeysPerUser,
    maxBytesPerUser,
    maxTotalBytes,
    maxTtlSeconds,
    sharedMaxTtlSeconds,
    sharedMaxKeysPerUser,
    sharedMaxBytesPerUser,
    allowDeclared: bool(env, "BAB_KV_ALLOW_DECLARED", false),
  };
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

/** Lowercase letters, with single hyphens between words: what the built-in labels look like, and safe in SQL literals. */
const LABEL_SHAPE = /^[a-z]+(?:-[a-z]+)*$/;

function extraLabels(env: Env, name: string): string[] {
  const labels = csv(env, name).map((v) => v.toLowerCase());
  for (const label of labels) {
    if (!LABEL_SHAPE.test(label) || label === "everywhere") {
      throw new ConfigError(name + ' holds a label that is not lowercase letters and hyphens (or is reserved), got "' + label + '"');
    }
  }
  return [...new Set(labels)];
}

/** Lowercase letters and digits, with single hyphens between words. Safe in SQL literals and URLs. */
const TEAM_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DEFAULT_TEAM_TAGS = CONFIG_SPEC.find((e) => e.env === "BAB_TEAM_TAGS")!.default;

function teamTagsOf(env: Env): string[] {
  const name = "BAB_TEAM_TAGS";
  const raw = env[name]; // only undefined means unset: an empty value must fail, not fall back
  const slugs = (raw === undefined ? DEFAULT_TEAM_TAGS : raw).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (slugs.length === 0) throw new ConfigError(name + " must hold at least one team slug (unset it to use the default)");
  for (const slug of slugs) {
    if (!TEAM_SLUG_SHAPE.test(slug)) {
      throw new ConfigError(name + ' holds a team that is not lowercase letters, digits and hyphens, got "' + slug + '"');
    }
  }
  return [...new Set(slugs)];
}

function origin(env: Env, name: string): string | null {
  const v = read(env, name)?.trim();
  if (!v) return null;
  let origin: string;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    origin = u.origin;
  } catch {
    throw new ConfigError(name + ' must be an absolute http(s) URL, got "' + v + '"');
  }
  return origin;
}

function parseTokens(
  raw: string,
  emailPattern: RegExp,
  source: string,
  tokens = new Set<string>(),
  identities = new Map<string, string>(),
): { tokens: Set<string>; identities: Map<string, string> } {
  let parsed = 0;
  for (const entry of raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    parsed++;
    const eq = entry.lastIndexOf("=");
    // token=email only when the part after the last "=" is an email; otherwise "=" is part of the
    // token (base64 padding).
    if (eq < 0 || !entry.slice(eq + 1).includes("@")) tokens.add(entry);
    else {
      const t = entry.slice(0, eq).trim();
      const email = entry.slice(eq + 1).trim().toLowerCase();
      if (!t || !email) throw new ConfigError(source + " has a malformed token=email entry");
      if (!emailPattern.test(email)) throw new ConfigError(source + " has a token=email entry whose email does not match BAB_IDENTITY_EMAIL_PATTERN");
      identities.set(t, email);
    }
  }
  // A set-but-empty source must not silently switch token mode off.
  if (parsed === 0) throw new ConfigError(source + " is set but holds no token");
  return { tokens, identities };
}

function maintainersNow(): Set<string> {
  return new Set(csvOf(process.env.BAB_MAINTAINERS).map((v) => v.toLowerCase()));
}

function parse(env: Env): BabConfig {
  const trustIdentity = bool(env, "BAB_TRUST_PROXY_IDENTITY", false);
  if (maintainersNow().size === 0) {
    console.warn("[config] BAB_MAINTAINERS is unset: anyone can pin a house rule, and nobody can change a feedback status or open /admin");
  }
  if (trustIdentity && optStr(env, "BAB_PROXY_SECRET") === null) {
    // Fail closed: without the secret, anyone who can reach the app directly can send the identity headers.
    if (!bool(env, "BAB_TRUST_PROXY_WITHOUT_SECRET", false)) {
      throw new ConfigError("BAB_TRUST_PROXY_IDENTITY needs BAB_PROXY_SECRET, or BAB_TRUST_PROXY_WITHOUT_SECRET=1 when the proxy is the only way to reach BAB");
    }
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
  let parsed: { tokens: Set<string>; identities: Map<string, string> } | null = null;
  if (inline !== undefined) parsed = parseTokens(inline, emailPattern, "BAB_API_TOKENS");
  if (file) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch (e) {
      throw new ConfigError("BAB_API_TOKENS_FILE could not be read: " + (e as Error).message);
    }
    // Lines starting with "#" are comments, never tokens.
    const lines = content.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    parsed = parseTokens(lines.join("\n"), emailPattern, "BAB_API_TOKENS_FILE", parsed?.tokens, parsed?.identities);
  }

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
    extraAppliesTo: extraLabels(env, "BAB_EXTRA_APPLIES_TO"),
    teamTags: teamTagsOf(env),
    branding: {
      orgName: str(env, "BAB_ORG_NAME", "BAB"),
      accentColor: accent,
      pluginMarketplace: str(env, "BAB_PLUGIN_MARKETPLACE", "enhesa/big-agentic-brain"),
      pluginMarketplaceName: str(env, "BAB_PLUGIN_MARKETPLACE_NAME", "big-agentic-brain"),
      installScreenshot: installScreenshotOf(str(env, "BAB_INSTALL_SCREENSHOT", DEFAULT_INSTALL_SCREENSHOT)),
      installScreenshotAlt: str(env, "BAB_INSTALL_SCREENSHOT_ALT", DEFAULT_INSTALL_SCREENSHOT_ALT),
      locale,
      timeZone,
    },
    retention: { staleAfterDays: int(env, "BAB_STALE_AFTER_DAYS", 90), auditDays: int(env, "BAB_AUDIT_RETENTION_DAYS", 365) },
    devices: bool(env, "BAB_DEVICES", true),
    mcpTools: mcpToolsOf(env),
    inboxPage: bool(env, "BAB_INBOX_PAGE", true),
    commandCenter: bool(env, "BAB_COMMAND_CENTER", true),
    files: filesOf(env),
    kv: kvOf(env),
    replicas: int(env, "BAB_REPLICAS", 1),
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
  log("[config] features: staleAfterDays=" + c.retention.staleAfterDays + " auditDays=" + c.retention.auditDays + " devices=" + c.devices + " inboxPage=" + c.inboxPage + " commandCenter=" + c.commandCenter);
  const f = c.files;
  log("[config] files: enabled=" + f.enabled + " maxFileBytes=" + f.maxFileBytes + " userQuotaBytes=" + f.userQuotaBytes + " expiryDays=" + f.defaultExpiryDays + "/" + f.maxExpiryDays + " diskFullPercent=" + f.diskFullPercent + " diskReserveBytes=" + f.diskReserveBytes + " uploadDeadlineMs=" + f.uploadDeadlineMs + " allowDeclared=" + f.allowDeclared);
  if (f.enabled && f.allowDeclared) log("[config] WARN: BAB_FILES_ALLOW_DECLARED is on: callers identified only by headers can read and delete other people's files");
  const k = c.kv;
  log("[config] kv: enabled=" + k.enabled + " shared=" + (k.sharedNamespaces.join(",") || "none") + " maxValueBytes=" + k.maxValueBytes + " maxKeysPerUser=" + k.maxKeysPerUser + " maxBytesPerUser=" + k.maxBytesPerUser + " maxTotalBytes=" + k.maxTotalBytes + " maxTtlSeconds=" + k.maxTtlSeconds + " shared(ttl/keys/bytes per person)=" + k.sharedMaxTtlSeconds + "/" + k.sharedMaxKeysPerUser + "/" + k.sharedMaxBytesPerUser + " allowDeclared=" + k.allowDeclared + " replicas=" + c.replicas);
  if (k.enabled && k.allowDeclared) log("[config] WARN: BAB_KV_ALLOW_DECLARED is on: callers identified only by headers can read and change other people's keys");
  if (k.enabled && c.replicas > 1) log("[config] WARN: BAB_REPLICAS is " + c.replicas + ": the key-value store is atomic only in one process, so it refuses every call");
  if (isOpen(c)) {
    log("[config] WARN: open mode, no proxy identity and no API tokens configured, callers are not authenticated");
  } else if (c.tokens !== null) {
    // A bare token only gates access: its holder still says who they are, for any address no token=email entry binds.
    log("[config] WARN: API tokens gate access but do not bind identity: /api and /mcp accept self-declared identities; use token=email entries in BAB_API_TOKENS");
  } else if (c.tokenIdentities.size === 0) {
    // Only reachable with the proxy trusted (otherwise isOpen). The proxy protects the web pages; agents on /api and /mcp still say who they are.
    log("[config] WARN: /api and /mcp accept self-declared identities; bind tokens to people with token=email entries in BAB_API_TOKENS, or keep those paths off the public network");
  }
}
