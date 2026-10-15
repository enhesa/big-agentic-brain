import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { vote, type VoteChoice } from "@/lib/learnings";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const VOTE_KINDS: VoteChoice[] = ["helpful", "not_helpful"];

/** POST /api/learnings/[id]/vote — { kind: "helpful" | "not_helpful" } */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/learnings/${id}/vote`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = await req.json().catch(() => null);
      const kind = (payload as { kind?: unknown } | null)?.kind;
      if (typeof kind !== "string" || !VOTE_KINDS.includes(kind as VoteChoice)) {
        return { status: 400, body: { error: 'kind must be "helpful" or "not_helpful"' } };
      }

      const { learning, changed } = vote(id, user.id, kind as VoteChoice, "mcp");
      return { status: 200, body: { learning, changed } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
