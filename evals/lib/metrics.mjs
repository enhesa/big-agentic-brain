// Per-run BAB usage metrics derived from the agent's tool calls.

const RESULT_ID = /\{"id":"([0-9a-f-]{36})"/g;

/** Result ids in rank order from a raw bab_search tool result (robust to truncated or non-JSON text). */
export function resultIds(text) {
  return [...String(text).matchAll(RESULT_ID)].map((m) => m[1]);
}

/**
 * relevant: Set of learning ids that answer this task's family.
 * Returns { queried, hit, hitRank, reacted, zeroResultSearches }.
 */
export function memoryMetrics(run, relevant) {
  let hitRank = null;
  let zero = 0;
  for (const s of run.searches) {
    const ids = resultIds(s.text);
    if (!ids.length) zero++;
    ids.forEach((id, i) => {
      if (hitRank === null && relevant.has(id)) hitRank = i + 1;
    });
  }
  const reacted = run.reacts.some((r) => relevant.has(r.learningId) && ["helpful", "confirm"].includes(r.action));
  return { queried: run.searches.length > 0, hit: hitRank !== null, hitRank, reacted, zeroResultSearches: zero };
}

/** Rank-based retrieval scores for one query. rank is 1-based or null. */
export function retrievalScores(rank, ks = [1, 3, 5]) {
  const out = { rr: rank ? 1 / rank : 0 };
  for (const k of ks) out[`recall@${k}`] = rank !== null && rank <= k ? 1 : 0;
  return out;
}
