import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { findSimilar } from "@/lib/learnings";

export const dynamic = "force-dynamic";

/**
 * GET /api/learnings/similar?title=&body=&tags=a,b — pre-check for the
 * duplicate guard (docs/spec.md "Garbage collection": dedup at write time).
 * Never 409s: it just returns the candidates for the caller to show the
 * human before deciding whether to post.
 */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/learnings/similar", via: "mcp" });

  const { searchParams } = new URL(req.url);
  const title = searchParams.get("title") ?? "";
  const body = searchParams.get("body") ?? "";
  const tagsRaw = searchParams.get("tags") ?? "";
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const candidates = findSimilar({ title, body, tags });

  return Response.json({ candidates });
}
