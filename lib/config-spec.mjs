// Plain ESM so both lib/config.ts and scripts/docs-config.mjs can import it without a TypeScript step.
// One entry per environment variable the app reads. docs/configuration.md is generated from this.

/**
 * @typedef {{ env: string, default: string, description: string }} ConfigSpecEntry
 */

/** @type {ReadonlyArray<ConfigSpecEntry>} */
export const CONFIG_SPEC = [
  { env: "PORT", default: "3000", description: "Port the server listens on (the Dockerfile sets it; `pnpm dev` uses 4310)." },
  { env: "HOSTNAME", default: "0.0.0.0", description: "Interface the server binds to (the Dockerfile sets it)." },
  { env: "DATA_DIR", default: "/data", description: "Directory holding bab.db and snapshot.db. Set it for local runs." },
  { env: "BAB_IDENTITY_EMAIL_PATTERN", default: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", description: "Case-insensitive regular expression a long-form email must match to count as a person." },
  { env: "BAB_IDENTITY_ALIAS_PATTERN", default: "", description: "Optional pattern for a short alias of a valid address; a match only selects the 'use your long address' refusal text" },
  { env: "BAB_IDENTITY_HINT", default: "you@example.com", description: "Example address shown to callers who must identify themselves." },
  { env: "BAB_ALLOWED_EMAILS", default: "", description: "Comma-separated emails allowed to use BAB. Unset: anyone matching the email pattern." },
  { env: "BAB_MAINTAINERS", default: "", description: "Comma-separated long-form emails of the maintainers (pin and unpin house rules, feedback status, flagged standards, /usage detail, /admin/*). Re-read on every access, no restart needed. Unset: anyone can pin, nobody can change a feedback status, /admin is a 404; BAB warns at startup. In open mode a maintainer identity is only as trustworthy as the caller's self-declared headers, so pair it with bound tokens or a sign-in proxy." },
  { env: "BAB_TRUST_PROXY_IDENTITY", default: "false", description: "Trust the identity headers set by an authenticating reverse proxy (SSO) on web pages. Accepts 1/true/yes/on and 0/false/no/off." },
  { env: "BAB_TRUST_PROXY_WITHOUT_SECRET", default: "false", description: "Acknowledge that BAB_TRUST_PROXY_IDENTITY is on without BAB_PROXY_SECRET, which is safe only when the proxy is the sole way to reach BAB (anyone who can reach it directly can otherwise send the identity headers). Without this and without a secret, BAB refuses to start. Accepts 1/true/yes/on and 0/false/no/off." },
  { env: "BAB_HEADER_USER_ID", default: "x-auth-request-user", description: "Name of the proxy header that carries the user id." },
  { env: "BAB_HEADER_EMAIL", default: "x-auth-request-email", description: "Name of the proxy header that carries the user's email." },
  { env: "BAB_HEADER_NAME", default: "x-auth-request-preferred-username", description: "Name of the proxy header that carries the display name." },
  { env: "BAB_HEADER_ROLES", default: "x-auth-request-groups", description: "Name of the proxy header that carries the roles or groups." },
  { env: "BAB_PROXY_SECRET", default: "", description: "Shared secret the proxy sends in the x-bab-proxy-secret header before its identity headers are trusted. Required when BAB_TRUST_PROXY_IDENTITY is on, unless BAB_TRUST_PROXY_WITHOUT_SECRET=1. Masked in logs." },
  { env: "BAB_TRUST_PROXY", default: "false", description: "Honour X-Forwarded-Host/Proto for the public origin (links, Origin check). Does not affect the client address; see BAB_CLIENT_IP_HEADER" },
  { env: "BAB_PUBLIC_ORIGIN", default: "", description: "The app's public origin, such as https://bab.example.com (any path is dropped). Wins over forwarded headers for generated links and the Origin check on browser forms." },
  { env: "BAB_MAX_BODY_BYTES", default: "1048576", description: "Largest accepted request body, in bytes (positive integer)." },
  { env: "BAB_API_TOKENS", default: "", description: "Comma- or newline-separated API tokens; an entry may be token=email to bind a token to a person: that address then acts only with its token, never through headers, devices, connections, bab_identify or proxy headers on /api and /mcp. A bare token only gates access, so its holder still says who they are; BAB warns at startup. Unset or empty with no proxy identity: open mode; set but holding no token (blank lines only) refuses to start. Masked in logs." },
  { env: "BAB_API_TOKENS_FILE", default: "", description: "Path of a file with tokens in the same format as BAB_API_TOKENS, one per line; lines starting with # are comments. Merged with BAB_API_TOKENS when both are set." },
  { env: "BAB_REDACT_PII", default: "true", description: "Mask email addresses in stored text (other secret patterns are always masked)" },
  { env: "BAB_REDACT_DOMAINS", default: "", description: "Email domains that are NOT masked by PII redaction (colleagues' addresses). Unset: every email is masked" },
  { env: "BAB_SOURCE_HOSTS", default: "", description: "Comma-separated hosts a learning source URL may point to. Unset: any host." },
  { env: "BAB_PROJECT_KEY_PREFIXES", default: "", description: "Repo-slug prefixes stripped when deriving a project key, e.g. `acme.` so `acme.app` and `app` are one project" },
  { env: "BAB_EXTRA_APPLIES_TO", default: "", description: "Comma-separated extra platform labels for a memory's applies-to list, added to the built-in ones (lowercase letters and hyphens). A label already stored on a memory stays readable when it is not listed; only writes and filters are checked." },
  { env: "BAB_ORG_NAME", default: "BAB", description: "Organisation name shown in the UI and instructions." },
  { env: "BAB_ACCENT_COLOR", default: "#1a3360", description: "Accent colour of the web UI, lowercase #rrggbb." },
  { env: "BAB_PLUGIN_MARKETPLACE", default: "enhesa/big-agentic-brain", description: "Claude Code plugin marketplace repository handed out in the setup instructions." },
  { env: "BAB_PLUGIN_MARKETPLACE_NAME", default: "big-agentic-brain", description: "Name of that marketplace as the plugin command refers to it." },
  { env: "BAB_INSTALL_SCREENSHOT", default: "", description: "Optional image shown above the install commands on the landing page, for example a screenshot of adding the plugin in the Claude app from your own marketplace. A path on this site (/branding/install.png, served from public/) or an https URL. Unset: no image." },
  { env: "BAB_INSTALL_SCREENSHOT_ALT", default: "How to add the plugin in the Claude app", description: "Alt text for BAB_INSTALL_SCREENSHOT: describe the steps the image shows." },
  { env: "BAB_LOCALE", default: "en", description: "Locale used to format dates." },
  { env: "BAB_TIMEZONE", default: "UTC", description: "IANA time zone used to format dates." },
  { env: "BAB_STALE_AFTER_DAYS", default: "90", description: "Days a device may go unseen before it is forgotten" },
  { env: "BAB_AUDIT_RETENTION_DAYS", default: "365", description: "Days the audit log is kept (positive integer)." },
  { env: "BAB_DEVICES", default: "true", description: "Off ignores X-Bab-Device and Mcp-Session-Id: nothing is remembered, only X-Bab-Actor-* callers are served. Accepts 1/true/yes/on and 0/false/no/off." },
  { env: "BAB_INBOX_PAGE", default: "true", description: "Off switches the Inbox page and its routes off. Accepts 1/true/yes/on and 0/false/no/off." },
  { env: "BAB_CLIENT_IP_HEADER", default: "", description: "x-real-ip or x-forwarded-for-rightmost: the header that carries the client address (audit log, rate limits, device list). Unset: the address is unverified." },
];
