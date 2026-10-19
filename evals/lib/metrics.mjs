// Per-run BAB usage metrics derived from the agent's tool calls.

const RESULT_ID = /\{"id":"([0-9a-f-]{36})"/g;

/** Result ids in rank order from a bab_search tool result. Prefer JSON; fall back to regex if truncated. */
export function resultIds(text) {
  const s = String(text);
  try {
    const j = JSON.parse(s);
    const results = j.results ?? j;
    if (Array.isArray(results)) return results.map((r) => r?.id).filter((id) => typeof id === "string");
  } catch {}
  return [...s.matchAll(RESULT_ID)].map((m) => m[1]);
}

/**
 * relevant: Set of learning ids that answer this task's family.
 * Returns { queried, hit, hitRank, reacted, zeroResultSearches, ... }.
 */
export function memoryMetrics(run, relevant, hazard = new Set()) {
  let hitRank = null;
  let zero = 0;
  let hazardSeen = (run.injected ?? []).some((id) => hazard.has(id));
  for (const s of run.searches) {
    const ids = resultIds(s.text);
    if (!ids.length) zero++;
    ids.forEach((id, i) => {
      if (hitRank === null && relevant.has(id)) hitRank = i + 1;
      if (hazard.has(id)) hazardSeen = true;
    });
  }
  const reacted = run.reacts.some((r) => relevant.has(r.learningId) && ["helpful", "confirm"].includes(r.action));
  const injectedRelevant = (run.injected ?? []).some((id) => relevant.has(id));
  return {
    queried: run.searches.length > 0, hit: hitRank !== null, hitRank, reacted, zeroResultSearches: zero,
    injectedRelevant, relevantSeen: hitRank !== null || injectedRelevant, hazardSeen,
    hazardFlagged: run.reacts.some((r) => hazard.has(r.learningId) && ["flag", "not_helpful", "retire"].includes(r.action)),
    hazardEndorsed: run.reacts.some((r) => hazard.has(r.learningId) && ["helpful", "confirm"].includes(r.action)),
  };
}

/** Rank-based retrieval scores for one query. rank is 1-based or null. */
export function retrievalScores(rank, ks = [1, 3, 5]) {
  const out = { rr: rank ? 1 / rank : 0 };
  for (const k of ks) out[`recall@${k}`] = rank !== null && rank <= k ? 1 : 0;
  return out;
}
