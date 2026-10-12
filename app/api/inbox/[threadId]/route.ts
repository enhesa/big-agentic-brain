import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { requireThreadForActor, markRead, getLeaseForActor } from "@/lib/messages";
import { getUsersByIds } from "@/lib/users";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/inbox/[threadId] — one thread; participant only, marks it read
 * for me. Carries the participants and the caller's own `lease` on this thread (null if none/expired).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { threadId } = await params;
  await auditRequest({ actor: user, method: "GET", path: `/api/inbox/${threadId}`, via: "mcp" });

  try {
    // Validate existence/participation first (throws 404/403 without side effects),
    // then mark read BEFORE the response-shaping read so the returned messages
    // reflect the now-updated read_at.
    requireThreadForActor(threadId, user.id);
    markRead(threadId, user.id, "mcp");
    const found = requireThreadForActor(threadId, user.id);

    const participantIds = new Set<string>([found.thread.created_by]);
    for (const m of found.messages) {
      participantIds.add(m.from_id);
      participantIds.add(m.to_id);
    }
    const userMap = getUsersByIds(Array.from(participantIds));
    const participants = Array.from(participantIds).map((id) => {
      const u = userMap.get(id);
      return { id, name: u?.name ?? null };
    });

    const lease = getLeaseForActor(threadId, user.id) ?? null;

    // fromName/toName so the thread page's LiveUpdates refresh can render
    // from this same response shape without a second name lookup.
    const messages = found.messages.map((m) => ({
      ...m,
      fromName: userMap.get(m.from_id)?.name ?? null,
      toName: userMap.get(m.to_id)?.name ?? null,
    }));

    return Response.json({ ...found, messages, participants, lease });
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}
