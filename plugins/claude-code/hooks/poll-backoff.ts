// Pure helpers for the inbox poll's back-off and its pause when the host refuses the tool call.
// No imports: tests load this file on its own.

/** The delay after a first failed poll; it doubles per failure up to BACKOFF_MAX_MS. */
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 300_000

/** Extra wait after `failures` failed polls in a row, on top of the 15 s tick: 0 for none, then 30 s, 60 s ... up to 5 minutes. */
export function backoffMs(failures: number): number {
  if (!Number.isFinite(failures) || failures <= 0) return 0
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10), BACKOFF_MAX_MS)
}

// What a host says when a person (or a policy) declines a tool call. BAB's own refusals ("not found",
// "does not know you") and timeouts do not match, so they keep the retry behaviour.
const REFUSAL_RE =
  /permission (?:was )?denied|(?:was|were|been) denied|denied by|user (?:denied|declined|rejected|refused)|declined by (?:the )?user|(?:the )?user (?:doesn'?t|does not) want|rejected by (?:the )?user|not allowed to use|requires? (?:approval|permission)|tool use was (?:denied|rejected)|tool call (?:was )?(?:denied|rejected|blocked)|blocked by (?:policy|a hook|permission)/i

/** True when an error text looks like the host refusing the call, not a broken connection or a BAB-side error. */
export function looksLikeRefusal(text: string): boolean {
  return REFUSAL_RE.test(text.slice(0, 500))
}

/**
 * True for a BAB tool on this plugin's own MCP server (`server` as $.mcp.connect names it, such as
 * plugin:bab:bab), which the plugin approves itself (register.tsx, tool.check). The host spells the
 * tool mcp__<server, other characters as _>__<tool>, so another plugin's server named bab never matches.
 */
export function isOwnBabTool(name: string, server: string | null): boolean {
  if (!server) return false
  const prefix = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`
  return name.startsWith(prefix) && /^bab_[a-z_]+$/.test(name.slice(prefix.length))
}

/** What the panel says while polling is paused. */
export const PAUSED_TEXT = 'BAB paused: allow its tools to see new messages and reminders. /bab-check resumes.'

/** The configured server URL ends with "/": hosts such as Forge's proxy answer a `//` path with 400. */
export function hasTrailingSlash(url: unknown): boolean {
  return typeof url === 'string' && url.trim().endsWith('/')
}

export const SLASH_WARNING = 'BAB: remove the trailing slash from bab_url in the plugin settings, then restart Claude.'
