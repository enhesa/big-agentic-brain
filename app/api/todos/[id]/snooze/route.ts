import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { snooze } from "@/lib/todos";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/todos/[id]/snooze — owner only. Optional { dueAt }; else +7 days. */
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
      // No body means the default snooze. A body that is not a JSON object is a client error, never a silent default.
      const text = await req.text();
      let dueAt: unknown;
      if (text.trim() !== "") {
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          return { status: 400, body: { error: "Body must be a JSON object" } };
        }
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          return { status: 400, body: { error: "Body must be a JSON object" } };
        }
        dueAt = (payload as Record<string, unknown>).dueAt;
      }
      const todo = snooze(id, user.id, "mcp", dueAt);
      return { status: 200, body: { todo } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
