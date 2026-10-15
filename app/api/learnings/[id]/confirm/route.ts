import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { confirm, noteArg } from "@/lib/learnings";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/learnings/[id]/confirm: { note }. "I checked this and it holds"; note required, never your own. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/learnings/${id}/confirm`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = await req.json().catch(() => ({}));
      const noteRaw = (payload as { note?: unknown } | null)?.note;
      const note = noteArg(noteRaw);

      const { learning, changed } = confirm(id, user.id, note, "mcp");
      return { status: 200, body: { learning, changed } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
