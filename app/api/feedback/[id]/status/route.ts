import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { setStatus, type FeedbackStatus } from "@/lib/feedback";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/feedback/:id/status { status, note?, duplicateOf? } -> { feedback }. Maintainers only (BAB_MAINTAINERS). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/feedback/${id}/status`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      const feedback = setStatus(
        id,
        user,
        payload?.status as FeedbackStatus,
        {
          note: typeof payload?.note === "string" ? payload.note : null,
          duplicateOf: typeof payload?.duplicateOf === "string" ? payload.duplicateOf : null,
        },
        "mcp",
      );
      return { status: 200, body: { feedback } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
