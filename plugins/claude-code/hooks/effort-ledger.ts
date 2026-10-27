// Measured agent effort for BAB's "Agent time saved" (docs/savings.md, "Measured savings").
// Pure helpers: no imports, so tests load this file on its own. Only numbers are kept, never prompt text.
//
// Active time is the sum of the main loop's turn durations, never idle wall time between turns.
// Tokens are billable tokens (fresh input + cache writes + output, no cache reads) of every model
// request in the session, subagents' included, counted when each request answers.

/** A discovery segment counts at most this much active time: the most recent turns, back to this cap. */
export const SEGMENT_CAP_MS = 4 * 3_600_000
/** A reuse measured over more active time than this is not sent: too long to be one reuse. */
export const REUSE_CAP_MS = SEGMENT_CAP_MS
/** The server's caps (lib/effort-cost.ts). Sent values are clamped to them. */
export const TOKENS_MAX = 50_000_000
export const USD_MAX = 1_000
/** At most this many surfaced memory ids are remembered per session; the oldest go first. */
export const SURFACED_MAX = 500

export type UsageCounts = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** Billable tokens of one response: fresh input, cache writes and output. Cache reads are left out. */
export function billableTokens(u: UsageCounts | null | undefined): number {
  if (!u) return 0
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens)
}

/** A point on the session's running totals. */
export type Position = { activeMs: number; tokens: number; usd: number | null }

/** One piece of measured effort: a whole turn, or the part of a turn on one side of a boundary. */
type Piece = { activeMs: number; tokens: number }

export type Ledger = {
  /** Closed pieces since the discovery boundary, oldest first. */
  pieces: Piece[]
  /** The main loop's turn in flight, if any. */
  open: { turnId: string; startedAt: number; pieceStartedAt: number; earlierMs: number; tokens: number } | null
  /** Tokens that arrived with no main turn open (a background subagent): they join the next piece. */
  loose: number
  /** Running totals of everything closed so far, for reuse positions. */
  closedMs: number
  closedTokens: number
  /** Session cost in USD at the discovery boundary; null when the host keeps no cost ledger. */
  boundaryUsd: number | null
  /** Turns whose requests were counted step by step, so their turn.complete usage is not added again. */
  stepped: Set<string>
  /** Memory id to the position where it was first surfaced in this session. */
  surfaced: Map<string, Position>
  /** Counts the cuts, so an undo applies only when no later cut happened. */
  cuts: number
}

export function newLedger(usd: number | null = null): Ledger {
  return { pieces: [], open: null, loose: 0, closedMs: 0, closedTokens: 0, boundaryUsd: usd, stepped: new Set(), surfaced: new Map(), cuts: 0 }
}

/** A main-loop turn began. A turn already open (a missed end) is closed at this moment. */
export function startTurn(l: Ledger, turnId: string, now: number): void {
  if (l.open) endTurn(l, l.open.turnId, now)
  l.open = { turnId, startedAt: now, pieceStartedAt: now, earlierMs: 0, tokens: l.loose }
  l.loose = 0
}

/** Billable tokens of a request: into the open turn, else held for the next piece. */
export function addTokens(l: Ledger, tokens: number, turnId?: string): void {
  const t = n(tokens)
  if (turnId) l.stepped.add(turnId)
  if (t === 0) return
  if (l.open) l.open.tokens += t
  else l.loose += t
}

/**
 * A turn ended. For any loop: its usage counts only if no step of it was counted already.
 * For the main loop it also closes the turn; its active time is the reported duration when there
 * is one, else the clock.
 */
export function completeTurn(
  l: Ledger,
  e: { turnId: string; isMain: boolean; durationMs?: number; usage?: UsageCounts | null },
  now: number,
): void {
  if (!l.stepped.delete(e.turnId)) addTokens(l, billableTokens(e.usage))
  if (e.isMain) endTurn(l, e.turnId, now, e.durationMs)
}

function endTurn(l: Ledger, turnId: string, now: number, durationMs?: number): void {
  const o = l.open
  if (!o || o.turnId !== turnId) return
  const total = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : now - o.startedAt
  pushPiece(l, { activeMs: Math.max(0, total - o.earlierMs), tokens: o.tokens })
  l.open = null
}

function pushPiece(l: Ledger, p: Piece): void {
  l.pieces.push(p)
  l.closedMs += p.activeMs
  l.closedTokens += p.tokens
}

/** The running totals now, the turn in flight included. */
export function position(l: Ledger, now: number, usd: number | null = null): Position {
  const o = l.open
  return {
    activeMs: l.closedMs + (o ? Math.max(0, now - o.pieceStartedAt) : 0),
    tokens: l.closedTokens + (o ? o.tokens : 0) + l.loose,
    usd,
  }
}

/**
 * The effort since the discovery boundary: the turn in flight up to now, then the closed turns
 * walking back, until the next one would pass `capMs` of active time. Tokens are those same
 * turns' tokens. USD only when no turn was left out and the host reports cost.
 */
export function segment(l: Ledger, now: number, usd: number | null = null, capMs = SEGMENT_CAP_MS): Position & { isCapped: boolean } {
  const o = l.open
  const pieces: Piece[] = [...l.pieces]
  if (o) pieces.push({ activeMs: Math.max(0, now - o.pieceStartedAt), tokens: o.tokens })
  let activeMs = 0
  let tokens = l.loose
  let isCapped = false
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i]!
    if (activeMs + p.activeMs > capMs) {
      isCapped = true
      // The newest turn alone is over the cap: count the cap, and its tokens in proportion.
      if (activeMs === 0 && p.activeMs > 0) {
        tokens += Math.round((p.tokens * capMs) / p.activeMs)
        activeMs = capMs
      }
      break
    }
    activeMs += p.activeMs
    tokens += p.tokens
  }
  const spent = usd !== null && l.boundaryUsd !== null && !isCapped ? Math.max(0, usd - l.boundaryUsd) : null
  return { activeMs, tokens, usd: spent, isCapped }
}

/**
 * A new discovery segment starts now: at a save or a helpful reaction. Splits the turn in flight.
 * Called before the call goes to BAB, so two saves in one step never share a segment. Returns an
 * undo for a call BAB refused: it puts the segment back, with what came since, unless another cut
 * happened in between.
 */
export function cut(l: Ledger, now: number, usd: number | null = null): () => void {
  const o = l.open
  if (o) {
    const ms = Math.max(0, now - o.pieceStartedAt)
    pushPiece(l, { activeMs: ms, tokens: o.tokens })
    o.earlierMs += ms
    o.pieceStartedAt = now
    o.tokens = 0
  }
  if (l.loose > 0) pushPiece(l, { activeMs: 0, tokens: l.loose })
  l.loose = 0
  // The pieces before the cut leave the segment; the running totals keep the reuse positions.
  const before = l.pieces
  const beforeUsd = l.boundaryUsd
  l.pieces = []
  l.boundaryUsd = usd
  const seq = ++l.cuts
  return () => {
    if (l.cuts !== seq) return
    l.pieces = [...before, ...l.pieces]
    l.boundaryUsd = beforeUsd
    l.cuts++
  }
}

/** Remembers where each memory was first surfaced in this session (a search result or a prompt notice). */
export function markSurfaced(l: Ledger, ids: readonly string[], at: Position): void {
  for (const id of ids) {
    if (l.surfaced.has(id)) continue
    if (l.surfaced.size >= SURFACED_MAX) {
      const oldest = l.surfaced.keys().next().value
      if (oldest !== undefined) l.surfaced.delete(oldest)
    }
    l.surfaced.set(id, at)
  }
}

/**
 * The effort from the first time `id` surfaced in this session until now; null when it never
 * surfaced here, or the span is longer than REUSE_CAP_MS (then the reuse is not measured).
 */
export function reuseSince(l: Ledger, id: string, now: Position): Position | null {
  const from = l.surfaced.get(id)
  if (!from) return null
  const activeMs = now.activeMs - from.activeMs
  if (activeMs < 0 || activeMs > REUSE_CAP_MS) return null
  const usd = now.usd !== null && from.usd !== null ? Math.max(0, now.usd - from.usd) : null
  return { activeMs, tokens: Math.max(0, now.tokens - from.tokens), usd }
}

/** The `cost` argument BAB accepts: minutes to 0.01, whole tokens, USD to 0.0001, each clamped to the server's caps. */
export function costArg(p: Position): { activeMinutes: number; tokens: number; usd?: number } | null {
  // A number BAB would refuse would fail the whole save or reaction: send no cost instead.
  if (!Number.isFinite(p.activeMs) || !Number.isFinite(p.tokens)) return null
  const minutes = Math.min(Math.max(0, p.activeMs) / 60_000, SEGMENT_CAP_MS / 60_000)
  const out: { activeMinutes: number; tokens: number; usd?: number } = {
    activeMinutes: Math.round(minutes * 100) / 100,
    tokens: Math.min(Math.round(Math.max(0, p.tokens)), TOKENS_MAX),
  }
  if (p.usd !== null && Number.isFinite(p.usd)) out.usd = Math.min(Math.round(Math.max(0, p.usd) * 10_000) / 10_000, USD_MAX)
  return out
}

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/

/** Memory ids in a bab_search answer (`results[].id`); none when it is not that JSON. */
export function idsFromSearchResult(text: string): string[] {
  try {
    const json = JSON.parse(text) as { results?: unknown }
    if (!Array.isArray(json.results)) return []
    return json.results.flatMap(r => {
      const id = (r as { id?: unknown } | null)?.id
      return typeof id === 'string' && ID_RE.test(id) ? [id] : []
    })
  } catch {
    return []
  }
}

const NOTICE_MARK = 'Big Agentic Brain: memories that may match this prompt'
const NOTICE_ID_RE = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}), saved /gi

/** Memory ids in BAB's per-prompt retrieval notice (app/api/hook/route.ts promptRetrievalFor). */
export function idsFromNotice(text: string): string[] {
  const at = text.indexOf(NOTICE_MARK)
  if (at < 0) return []
  return [...text.slice(at).matchAll(NOTICE_ID_RE)].map(m => m[1]!.toLowerCase())
}

/** Which of the measured BAB tools a call is, given its suffix after the own server's prefix. */
export function babToolOf(name: string, server: string | null): 'bab_learn' | 'bab_react' | 'bab_search' | null {
  if (!server) return null
  const prefix = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`
  if (!name.startsWith(prefix)) return null
  const tool = name.slice(prefix.length)
  return tool === 'bab_learn' || tool === 'bab_react' || tool === 'bab_search' ? tool : null
}

/** A reaction that says a memory helped the agent that used it: these carry a reuse cost. */
export function isReuseReaction(action: unknown): boolean {
  return action === 'helpful' || action === 'kudos'
}
