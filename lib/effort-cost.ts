import { getDb } from "./db";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";

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

/**
 * An older plugin adds `cost` to the bab_learn or bab_react input itself. Read for those clients
 * only: a value BAB would refuse is no measurement, never a failed save or reaction.
 */
export function legacyCost(raw: unknown): EffortCost | null {
  try {
    return parseCost(raw);
  } catch {
    return null;
  }
}

/*
 * `cost` is not in the bab_learn and bab_react input schemas on purpose, and neither is bab_react's
 * `cost` action: only the plugin sends them, a model that saw them might invent numbers, and every
 * agent loads the tool list (tests/mcp-lean.test.ts caps its size). The plugin sends the cost in a
 * follow-up call after BAB accepted the save or reaction (attachCost below), so the input that auto
 * mode reviewed is the input that runs.
 */

/** What a follow-up cost belongs to: the caller's own new memory, or its own helpful or kudos reaction. */
export type CostTarget = "learn" | "helpful" | "kudos";
const TARGETS: readonly CostTarget[] = ["learn", "helpful", "kudos"];

/**
 * Attaches a measured cost to the caller's own memory (discovery cost) or to its own helpful or
 * kudos reaction on a memory (reuse cost). Once each: a later attach is ignored, and so is one for
 * a reaction the caller never made. Returns whether this call stored the cost.
 */
export function attachCost(learningId: string, actorId: string, target: unknown, raw: unknown): boolean {
  if (!TARGETS.includes(target as CostTarget)) throw new ValidationError(`for must be one of ${TARGETS.join(", ")}`);
  const cost = parseCost(raw);
  if (!cost) throw new ValidationError("cost is required: { activeMinutes, tokens, usd? }");
  const db = getDb();
  if (target === "learn") {
    const row = db.prepare("SELECT author_id FROM learnings WHERE id = ?").get(learningId) as { author_id: string } | undefined;
    if (!row) throw new NotFoundError("learning not found");
    if (row.author_id.toLowerCase() !== actorId.toLowerCase()) throw new ForbiddenError("only the author attaches a discovery cost");
    return (
      db
        .prepare("INSERT OR IGNORE INTO learning_costs (learning_id, active_ms, tokens, usd) VALUES (?, ?, ?, ?)")
        .run(learningId, cost.activeMs, cost.tokens, cost.usd).changes > 0
    );
  }
  return insertReuseCost(learningId, actorId, target as "helpful" | "kudos", cost);
}

/** Stores the discovery cost of a memory just saved. Once per memory; a later call is ignored. */
export function recordDiscoveryCost(learningId: string, cost: EffortCost | null): void {
  if (!cost) return;
  bestEffort(() =>
    getDb()
      .prepare("INSERT OR IGNORE INTO learning_costs (learning_id, active_ms, tokens, usd) VALUES (?, ?, ?, ?)")
      .run(learningId, cost.activeMs, cost.tokens, cost.usd),
  );
}

/**
 * The memory or the vote is already saved when its cost is written: a failure here must not turn
 * that success into an error the agent would retry. The number is lost, and the reuse counts as
 * not measured.
 */
function bestEffort(write: () => unknown): void {
  try {
    write();
  } catch (err) {
    console.warn(`effort cost not stored: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Stores the reuse cost on a helpful or kudos reaction that exists. A repeat helpful fills in a cost
 * the first one lacked and never replaces one already stored.
 */
export function recordReuseCost(learningId: string, voterId: string, kind: "helpful" | "kudos", cost: EffortCost | null): void {
  if (!cost) return;
  bestEffort(() => insertReuseCost(learningId, voterId, kind, cost));
}

/** Stores a reuse cost only on a reaction that exists, once. */
function insertReuseCost(learningId: string, voterId: string, kind: "helpful" | "kudos", cost: EffortCost): boolean {
  return (
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO reuse_costs (learning_id, voter_id, kind, active_ms, tokens, usd)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM votes WHERE learning_id = ? AND voter_id = ? AND kind = ?)`,
      )
      .run(learningId, voterId, kind, cost.activeMs, cost.tokens, cost.usd, learningId, voterId, kind).changes > 0
  );
}

/** The measured discovery cost of one memory, or null when none was measured. */
export function discoveryCostOf(learningId: string): EffortCost | null {
  const r = getDb().prepare("SELECT active_ms, tokens, usd FROM learning_costs WHERE learning_id = ?").get(learningId) as
    | { active_ms: number; tokens: number; usd: number | null }
    | undefined;
  return r ? { activeMs: Number(r.active_ms), tokens: Number(r.tokens), usd: r.usd == null ? null : Number(r.usd) } : null;
}
