import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { fileForActor, openForDownload } from "@/lib/files";
import { downloadHeaders } from "@/lib/file-download";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** GET /api/files/:id/content: the file's bytes, for its owner and the people it is shared with. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const { id } = await ctx.params;
  await auditRequest({ actor: user, method: "GET", path: `/api/files/${id}/content`, via: "mcp" });
  try {
    const file = fileForActor(user.id, id);
    const stream = openForDownload(file, user.id, "mcp", "direct");
    return new Response(stream, { status: 200, headers: downloadHeaders(file) });
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}
