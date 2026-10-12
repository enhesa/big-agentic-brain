/**
 * Pure text-similarity helpers used to detect duplicate/similar learnings at
 * write time (docs/spec.md "Garbage collection": "Dedup at write time (FTS
 * similarity first; embeddings later)"). No I/O, no DB access.
 */

/** A learning scoring at or above this against a draft is a likely duplicate. */
export const DUPLICATE_THRESHOLD = 0.55;
/** A learning scoring at or above this (but below DUPLICATE_THRESHOLD) is worth surfacing as related. */
export const SIMILAR_THRESHOLD = 0.35;

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "but",
  "not",
  "you",
  "all",
  "can",
  "her",
  "was",
  "one",
  "our",
  "out",
  "day",
  "get",
  "has",
  "him",
  "his",
  "how",
  "man",
  "new",
  "now",
  "old",
  "see",
  "two",
  "way",
  "who",
  "boy",
  "did",
  "its",
  "let",
  "put",
  "say",
  "she",
  "too",
  "use",
  "with",
  "that",
  "this",
  "from",
  "your",
  "have",
  "more",
  "will",
  "when",
  "then",
  "than",
  "them",
  "they",
  "into",
  "over",
  "some",
  "such",
  "what",
  "were",
  "been",
  "being",
  "about",
  "after",
  "again",
  "there",
  "these",
  "those",
  "where",
  "which",
  "while",
]);

/**
 * Lowercases, strips punctuation, drops stopwords and tokens under 3 chars.
 * Digits are kept (e.g. "8443", "3.10").
 */
export function normalizeTokens(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Jaccard similarity of two token lists: |intersection| / |union|, in 0..1. */
export function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const BODY_PREFIX_CHARS = 400;

export interface SimilarityInput {
  title: string;
  body: string;
  tags?: string[];
}

export interface PrecomputedTokens {
  titleTokens: string[];
  bodyTokens: string[];
  tags: string[];
}

/** Tokenizes a learning once so a pairwise loop over N rows doesn't re-tokenize O(n^2) times. */
export function precomputeTokens(input: SimilarityInput): PrecomputedTokens {
  return {
    titleTokens: normalizeTokens(input.title),
    bodyTokens: normalizeTokens(input.body.slice(0, BODY_PREFIX_CHARS)),
    tags: (input.tags ?? []).map((t) => t.toLowerCase()),
  };
}

/** Same weighting as similarityScore(), but from already-tokenized inputs. */
export function similarityScoreFromTokens(a: PrecomputedTokens, b: PrecomputedTokens): number {
  const titleScore = jaccard(a.titleTokens, b.titleTokens);
  const bodyScore = jaccard(a.bodyTokens, b.bodyTokens);
  const tagScore = jaccard(a.tags, b.tags);
  const score = 0.6 * titleScore + 0.25 * bodyScore + 0.15 * tagScore;
  return Math.max(0, Math.min(1, score));
}

/**
 * Weighted similarity between a candidate and a draft learning, in 0..1:
 * 0.6 title-token Jaccard + 0.25 body-token Jaccard (first 400 chars each) +
 * 0.15 tag overlap (Jaccard over lowercased tag sets).
 */
export function similarityScore(candidate: SimilarityInput, draft: SimilarityInput): number {
  return similarityScoreFromTokens(precomputeTokens(candidate), precomputeTokens(draft));
}

/** Quotes a token for FTS5 MATCH (escape embedded quotes by doubling them). */
export function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}
