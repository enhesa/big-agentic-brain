import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { abandon } from "@/lib/todos";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/todos/[id]/abandon — owner only. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/todos/${id}/abandon`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const todo = abandon(id, user.id, "mcp");
      return { status: 200, body: { todo } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
