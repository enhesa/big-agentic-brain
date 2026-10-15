import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { snooze } from "@/lib/todos";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/todos/[id]/snooze — owner only, +7 days. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/todos/${id}/snooze`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const todo = snooze(id, user.id, "mcp");
      return { status: 200, body: { todo } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
