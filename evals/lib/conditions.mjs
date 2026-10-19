// Conditions: which memory a run's BAB starts from, and how the agent is wired to BAB (the integration).
// Memory snapshots are built by memory.mjs; integration variants are applied by agent.mjs.
//   memory: null (no BAB) | distractors | colleague | handwritten | autorecord | stale | conflict | wrong
//   integration: tools full|lean, instructions default|lean|fixed, searchFirst (prompt nudge), autoRetrieve (top-k)
const DEFAULT = { tools: "full", instructions: "default", searchFirst: false, autoRetrieve: 0 };

export const CONDITIONS = {
  A: { label: "A: no BAB", memory: null },
  B: { label: "B: BAB + colleague memory", memory: "colleague" },
  C: { label: "C: BAB, no relevant memory", memory: "distractors" },
  H: { label: "H: BAB + hand-written notes", memory: "handwritten" },
  // Integration ablations, all on B's memory.
  L: { label: "L: B + lean toolset (3 tools, short descriptions and instructions)", memory: "colleague", integration: { tools: "lean", instructions: "lean" } },
  F: { label: "F: B + fixed search advice (no kind filter)", memory: "colleague", integration: { instructions: "fixed" } },
  N: { label: "N: B + search-first nudge in the prompt", memory: "colleague", integration: { searchFirst: true } },
  R: { label: "R: B + auto-retrieval (top 3 injected before start)", memory: "colleague", integration: { autoRetrieve: 3 } },
  // Memory-source ablation: what the colleague's finish summary gives when recorded automatically.
  AR: { label: "AR: BAB + auto-recorded memory (colleague finish summaries)", memory: "autorecord" },
  // Hazards.
  ST: { label: "ST: BAB + stale memory only (backdated, outdated fact)", memory: "stale" },
  CF: { label: "CF: BAB + conflicting memory (stale + colleague)", memory: "conflict" },
  WR: { label: "WR: BAB + wrong memory only (plausible wrong fix)", memory: "wrong" },
};

export function conditionSpec(name) {
  const c = CONDITIONS[name];
  if (!c) throw new Error(`unknown condition ${name}; use ${Object.keys(CONDITIONS).join(",")}`);
  return { ...c, integration: { ...DEFAULT, ...(c.integration ?? {}) } };
}

/** Memory snapshots a set of conditions needs. */
export function memoriesFor(conditions) {
  return [...new Set(conditions.map((c) => conditionSpec(c).memory).filter(Boolean))];
}
