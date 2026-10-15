import { auditRequest } from "@/lib/request-audit";
import { getViewer } from "@/lib/notify-auth";
import { get, vote } from "@/lib/feedback";
import { forbiddenResponse, redirectTo, sameOrigin, unauthorizedResponse } from "@/lib/feedback-web";

export const dynamic = "force-dynamic";

/** POST /feedback/[id]/vote: a human vote from the detail page. Same rules as /feedback/submit. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return forbiddenResponse();
  const viewer = await getViewer();
  if (!viewer) return unauthorizedResponse();

  const { id } = await params;
  await auditRequest({ actor: viewer.actor, method: "POST", path: `/feedback/${id}/vote`, via: "ui" });
  if (!get(id)) return new Response("Feedback not found", { status: 404 });

  vote(id, viewer.ownerId, "ui");
  return redirectTo(req, `/feedback/${id}`);
}
