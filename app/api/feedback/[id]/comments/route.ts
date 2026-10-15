import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { comment } from "@/lib/feedback";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/feedback/:id/comments { body } -> 201 { comment } */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/feedback/${id}/comments`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = (await req.json().catch(() => null)) as { body?: unknown } | null;
      const created = comment(id, user.id, typeof payload?.body === "string" ? payload.body : "", "mcp");
      return { status: 201, body: { comment: created } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
