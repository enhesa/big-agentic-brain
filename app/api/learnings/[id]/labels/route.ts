import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { setLabels } from "@/lib/learnings";
import { readAppliesTo } from "@/lib/applies-to";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * POST /api/learnings/[id]/labels: { appliesTo }. Sets the memory's "applies to" labels in place
 * ([] means it holds anywhere). Anyone identified, any active memory; archived or deleted is a 409.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/learnings/${id}/labels`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = await req.json().catch(() => ({}));
      const appliesTo = (payload as { appliesTo?: unknown } | null)?.appliesTo;

      const { learning, changed } = setLabels(id, user.id, appliesTo, "mcp");
      return { status: 200, body: { learning: { ...learning, appliesTo: readAppliesTo(learning.applies_to) }, changed } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
