import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { get } from "@/lib/feedback";

export const dynamic = "force-dynamic";

/** GET /api/feedback/:id -> { feedback, comments } (status changes are comments of kind "status"). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const { id } = await params;
  await auditRequest({ actor: user, method: "GET", path: `/api/feedback/${id}`, via: "mcp" });

  const found = get(id);
  if (!found) return Response.json({ error: "Feedback not found" }, { status: 404 });
  return Response.json({ feedback: found.item, comments: found.comments });
}
