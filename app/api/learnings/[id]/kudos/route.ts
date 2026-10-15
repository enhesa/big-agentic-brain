import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { giveKudos } from "@/lib/learnings";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/learnings/[id]/kudos — { note? }. One per identity per learning, never your own. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/learnings/${id}/kudos`, via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = await req.json().catch(() => ({}));
      const noteRaw = (payload as { note?: unknown } | null)?.note;
      const note = noteRaw == null ? null : String(noteRaw);

      const learning = giveKudos(id, user.id, note, "mcp");
      return { status: 200, body: { learning } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
