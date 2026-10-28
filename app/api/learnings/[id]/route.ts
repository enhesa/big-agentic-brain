import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { readAppliesTo } from "@/lib/applies-to";
import {
  getById,
  voteCounts,
  findSupersededBy,
  standingsFor,
  recentNotes,
  lastRetire,
  recordAgentRead,
} from "@/lib/learnings";
import { commentDigestFor } from "@/lib/memory-comments";

export const dynamic = "force-dynamic";

/** GET /api/learnings/[id] */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;
  await auditRequest({ actor: user, method: "GET", path: `/api/learnings/${id}`, via: "mcp" });

  // Archived (and any other status) still fetchable directly by id, with `status`
  // visible so the caller knows it's not part of the default active list.
  const learning = getById(id);
  if (!learning) {
    return Response.json({ error: "Learning not found" }, { status: 404 });
  }

  // An agent fetched this memory by id: a read (lib/learnings.ts touchRead; an archived one is ignored there).
  recordAgentRead([id]);

  const superseder = findSupersededBy(id);
  const supersededBy = superseder ? { id: superseder.id, title: superseder.title } : undefined;

  const s = standingsFor([learning]).get(id)!;

  return Response.json({
    learning: { ...learning, appliesTo: readAppliesTo(learning.applies_to), standing: s.standing, standingReason: s.standingReason },
    votes: voteCounts(id),
    recentNotes: recentNotes(id),
    // Who retired or restored it, when and why: its own field, so five later notes cannot push it out.
    lastRetire: lastRetire(learning),
    supersededBy,
    // Colleagues' comments (count and the newest few), only when there are any.
    comments: learning.status === "deleted" ? undefined : commentDigestFor([id]).get(id),
  });
}
