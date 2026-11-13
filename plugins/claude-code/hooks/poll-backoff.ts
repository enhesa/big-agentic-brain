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
 * The bare BAB tool name (bab_inbox) when `name` is a tool on this plugin's own MCP server (`server` as
 * $.mcp.connect names it, such as plugin:bab:bab), else null. The host spells the tool
 * mcp__<server, other characters as _>__<tool>, so another plugin's server named bab never matches.
 */
export function ownBabTool(name: string, server: string | null): string | null {
  if (!server) return null
  const prefix = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`
  if (!name.startsWith(prefix)) return null
  const tool = name.slice(prefix.length)
  return /^bab_[a-z_]+$/.test(tool) ? tool : null
}

/** True for a BAB tool on this plugin's own MCP server. */
export function isOwnBabTool(name: string, server: string | null): boolean {
  return ownBabTool(name, server) !== null
}

/**
 * The BAB tools the plugin approves itself (register.tsx, tool.check): reads, your own identity and
 * session link, and your private reminders. Sending, files, keys and feedback are not here: they reach
 * colleagues or shared state, so they keep the host's normal ask.
 */
export const AUTO_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'bab_search',
  'bab_inbox',
  'bab_identify',
  'bab_link_session',
  'bab_remind',
])

/**
 * Tools approved only for some actions. bab_react: votes and checks the agent makes on autopilot, not
 * retire, delete, pin or unpin, which hide a memory or change house rules. bab_command_center: publish and
 * list, which the Command Center skill calls on every turn on the person's own private page; removing,
 * erasing and export grants keep the ask. bab_feedback: reading; posts, votes and comments ask.
 */
export const AUTO_ALLOWED_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  bab_react: new Set(['helpful', 'not_helpful', 'kudos', 'confirm', 'keep', 'flag', 'label', 'comment']),
  bab_command_center: new Set(['publish', 'list']),
  bab_feedback: new Set(['list', 'get']),
}

/** The call's arguments as an object, or null when the host passed something else. */
function args(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null
}

/** An argument the model left out: absent, null or an empty string. */
const isUnset = (v: unknown): boolean => v === undefined || v === null || v === ''

/**
 * Tools approved by their arguments. bab_people: reading the directory only; set_home_team, add_contact
 * and remove_contact change a profile, so they ask. bab_learn: a plain learning or practice; a decision,
 * a standard or a supersedes (which archives other entries) asks.
 */
const AUTO_ALLOWED_WHEN: Readonly<Record<string, (a: Record<string, unknown>) => boolean>> = {
  bab_people: a => isUnset(a.action) && isUnset(a.user),
  bab_learn: a => {
    const supersedes = a.supersedes
    const hasSupersedes = Array.isArray(supersedes) ? supersedes.length > 0 : !isUnset(supersedes)
    return !hasSupersedes && (isUnset(a.kind) || a.kind === 'learning' || a.kind === 'practice')
  },
}

/**
 * True when the plugin may turn the host's ask into an allow for this call: a tool on its own server,
 * in the low-risk set, a listed action of a tool approved per action, or arguments a per-tool rule
 * accepts. Anything else, an unknown tool or missing or unknown arguments included, keeps the ask.
 */
export function isAutoAllowed(name: string, server: string | null, input: unknown): boolean {
  const tool = ownBabTool(name, server)
  if (!tool) return false
  if (AUTO_ALLOWED_TOOLS.has(tool)) return true
  const a = args(input)
  if (!a) return false
  const when = AUTO_ALLOWED_WHEN[tool]
  if (when) return when(a)
  const actions = AUTO_ALLOWED_ACTIONS[tool]
  return !!actions && typeof a.action === 'string' && actions.has(a.action)
}

/** What the panel says while polling is paused. */
export const PAUSED_TEXT = 'BAB paused: allow its tools, or check your network or VPN. /bab-check resumes.'

/** The configured server URL ends with "/": hosts such as Forge's proxy answer a `//` path with 400. */
export function hasTrailingSlash(url: unknown): boolean {
  return typeof url === 'string' && url.trim().endsWith('/')
}

export const SLASH_WARNING = 'BAB: remove the trailing slash from bab_url in the plugin settings, then restart Claude.'
