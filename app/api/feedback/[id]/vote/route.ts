import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { vote } from "@/lib/feedback";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/feedback/:id/vote -> { feedback, changed }. One vote per identity; the author's own vote is a no-op. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/feedback/${id}/vote`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const { item, changed } = vote(id, user.id, "mcp");
      return { status: 200, body: { feedback: item, changed } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
