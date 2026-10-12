import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { getDb } from "@/lib/db";
import {
  precomputeTokens,
  jaccard,
  DUPLICATE_THRESHOLD,
} from "@/lib/similarity";
import type { LearningRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const SCAN_LIMIT = 300;

/**
 * GET /api/learnings/duplicates — pairs of existing active learnings that
 * look like duplicates of each other (docs/spec.md "Garbage collection").
 * O(n^2) over at most the newest 300 active learnings, fine at that size.
 */
export async function GET() {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/learnings/duplicates", via: "mcp" });

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM learnings WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`,
    )
    .all(SCAN_LIMIT) as unknown as LearningRow[];

  // Tokenize each row exactly once up front, instead of re-tokenizing per
  // pair inside an O(n^2) loop.
  const tokens = rows.map((r) => precomputeTokens({ title: r.title, body: r.body, tags: JSON.parse(r.tags) }));

  const pairs: { a: LearningRow; b: LearningRow; score: number }[] = [];

  // similarityScoreFromTokens weighs title 0.6 / body 0.25 / tags 0.15, so
  // with titleScore == 0 the ceiling is 0.25 + 0.15 = 0.4 < DUPLICATE_THRESHOLD
  // (0.55) no matter how similar the body/tags are — skip the rest of the
  // pair's scoring work entirely in that (common) case.
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const titleScore = jaccard(tokens[i].titleTokens, tokens[j].titleTokens);
      if (titleScore === 0) continue;
      const bodyScore = jaccard(tokens[i].bodyTokens, tokens[j].bodyTokens);
      const tagScore = jaccard(tokens[i].tags, tokens[j].tags);
      const score = Math.max(0, Math.min(1, 0.6 * titleScore + 0.25 * bodyScore + 0.15 * tagScore));
      if (score >= DUPLICATE_THRESHOLD) {
        pairs.push({ a: rows[i], b: rows[j], score });
      }
    }
  }

  // Newest first: by the more recent of the pair's two created_at timestamps.
  pairs.sort((x, y) => {
    const xNewest = x.a.created_at > x.b.created_at ? x.a.created_at : x.b.created_at;
    const yNewest = y.a.created_at > y.b.created_at ? y.a.created_at : y.b.created_at;
    return xNewest < yNewest ? 1 : xNewest > yNewest ? -1 : 0;
  });

  return Response.json({ pairs });
}
