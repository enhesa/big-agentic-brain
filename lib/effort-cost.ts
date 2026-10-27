import { getDb } from "./db";
import { ValidationError } from "./errors";

/**
 * The measured agent effort the Claude Code plugin attaches to bab_learn (discovery cost) and to a
 * helpful or kudos bab_react (reuse cost). Numbers only, never text. Self-reported by the client,
 * so it is used for the "Agent time saved" numbers on /usage and nothing else (docs/savings.md).
 */
export interface EffortCost {
  /** Active agent time: the sum of turn durations, in milliseconds. */
  activeMs: number;
  /** Billable tokens: fresh input, cache writes and output (no cache reads). */
  tokens: number;
  /** Session cost in USD over the same span, when the client reports one. */
  usd: number | null;
}

/** The plugin caps a segment at 4 hours of active time (plugins/claude-code/hooks/effort-ledger.ts). */
export const COST_MINUTES_MAX = 240;
export const COST_TOKENS_MAX = 50_000_000;
export const COST_USD_MAX = 1_000;

const KEYS = new Set(["activeMinutes", "tokens", "usd"]);

function bounded(name: string, v: unknown, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) {
    throw new ValidationError(`cost.${name} must be a number from 0 to ${max}`);
  }
  return v;
}

/**
 * Reads the optional `cost` argument: absent or null is no measurement. Anything else must be
 * `{ activeMinutes, tokens, usd? }` with finite non-negative numbers under the caps, tokens whole.
 */
export function parseCost(raw: unknown): EffortCost | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("cost must be an object { activeMinutes, tokens, usd? }");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!KEYS.has(k)) throw new ValidationError(`cost.${k} is not a known field; use activeMinutes, tokens, usd`);
  }
  const minutes = bounded("activeMinutes", o.activeMinutes, COST_MINUTES_MAX);
  const tokens = bounded("tokens", o.tokens, COST_TOKENS_MAX);
  if (!Number.isInteger(tokens)) throw new ValidationError("cost.tokens must be a whole number");
  const usd = o.usd == null ? null : bounded("usd", o.usd, COST_USD_MAX);
  return { activeMs: Math.round(minutes * 60_000), tokens, usd };
}

/*
 * `cost` is not in the bab_learn and bab_react input schemas on purpose: only the plugin fills it in
 * (its tool.call hook adds it), a model that saw it might invent numbers, and every agent loads the
 * tool list (tests/mcp-lean.test.ts caps its size). The server still reads and validates it.
 */

/** Stores the discovery cost of a memory just saved. Once per memory; a later call is ignored. */
export function recordDiscoveryCost(learningId: string, cost: EffortCost | null): void {
  if (!cost) return;
  getDb()
    .prepare("INSERT OR IGNORE INTO learning_costs (learning_id, active_ms, tokens, usd) VALUES (?, ?, ?, ?)")
    .run(learningId, cost.activeMs, cost.tokens, cost.usd);
}

/**
 * Stores the reuse cost on a helpful or kudos reaction that exists. A repeat helpful fills in a cost
 * the first one lacked and never replaces one already stored.
 */
export function recordReuseCost(learningId: string, voterId: string, kind: "helpful" | "kudos", cost: EffortCost | null): void {
  if (!cost) return;
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO reuse_costs (learning_id, voter_id, kind, active_ms, tokens, usd)
       SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM votes WHERE learning_id = ? AND voter_id = ? AND kind = ?)`,
    )
    .run(learningId, voterId, kind, cost.activeMs, cost.tokens, cost.usd, learningId, voterId, kind);
}

/** The measured discovery cost of one memory, or null when none was measured. */
export function discoveryCostOf(learningId: string): EffortCost | null {
  const r = getDb().prepare("SELECT active_ms, tokens, usd FROM learning_costs WHERE learning_id = ?").get(learningId) as
    | { active_ms: number; tokens: number; usd: number | null }
    | undefined;
  return r ? { activeMs: Number(r.active_ms), tokens: Number(r.tokens), usd: r.usd == null ? null : Number(r.usd) } : null;
}
