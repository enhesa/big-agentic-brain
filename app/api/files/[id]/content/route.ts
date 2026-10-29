import { auditRequest } from "@/lib/request-audit";
import { fileForActor, openForDownload } from "@/lib/files";
import { requireFilesActor } from "@/lib/files-route";
import { downloadHeaders } from "@/lib/file-download";
import { toApiError } from "@/lib/errors";
import { clientIp, clientIpVerified } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

/** GET /api/files/:id/content: the file's bytes, for its owner and the people it is shared with. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireFilesActor(req);
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  await auditRequest({ actor: user, method: "GET", path: `/api/files/${id}/content`, via: "mcp" });
  try {
    const file = fileForActor(user.id, id);
    const headers = downloadHeaders(file);
    const ip = clientIpVerified() ? clientIp(req.headers) : null;
    return new Response(openForDownload(file, user.id, "mcp", "direct", ip), { status: 200, headers });
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}
