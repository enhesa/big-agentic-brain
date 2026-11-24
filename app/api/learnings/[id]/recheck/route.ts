import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { recheck } from "@/lib/checks";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * POST /api/learnings/[id]/recheck: { answer: yes|no|unsure|agent|later, note }. A person's answer to
 * "Is this still true?" (lib/checks.ts), the same as bab_react recheck. A Yes on someone else's
 * memory is a confirm and needs a note.
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
  await auditRequest({ actor: user, method: "POST", path: `/api/learnings/${id}/recheck`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = ((await req.json().catch(() => ({}))) ?? {}) as { answer?: unknown; note?: unknown };
      const { learning, answer, changed, next } = recheck(id, user.id, payload.answer, payload.note, "mcp");
      return { status: 200, body: { learning, answer, changed, next } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
