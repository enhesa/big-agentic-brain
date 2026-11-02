import { auditRequest } from "@/lib/request-audit";
import { runCommandCenter, runCommandCenterGet } from "@/lib/command-center";
import { answer, readJsonObject, requireCommandCenterActor } from "@/lib/command-center-route";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/command-center/:id: one of your initiatives, whole. */
export async function GET(req: Request, { params }: Ctx) {
  const user = await requireCommandCenterActor(req);
  if (user instanceof Response) return user;
  const { id } = await params;
  await auditRequest({ actor: user, method: "GET", path: `/api/command-center/${id}`, via: "mcp" });
  return answer(() => runCommandCenterGet(user, id, publicOrigin(req.headers)));
}

/**
 * PUT /api/command-center/:id: publish the whole record (the publish action). Idempotent by
 * nature: the same record twice is one initiative. The id in the body, if any, must match.
 */
export async function PUT(req: Request, { params }: Ctx) {
  const user = await requireCommandCenterActor(req);
  if (user instanceof Response) return user;
  const { id } = await params;
  await auditRequest({ actor: user, method: "PUT", path: `/api/command-center/${id}`, via: "mcp" });
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  if (body.id !== undefined && body.id !== id) {
    return Response.json({ error: `id in the body ('${String(body.id)}') must match the path ('${id}')` }, { status: 400 });
  }
  if ("action" in body) return Response.json({ error: "unknown field 'action'; PUT publishes the record, actions go to POST /api/command-center/<id>/actions" }, { status: 400 });
  return answer(() => runCommandCenter(user, { ...body, id, action: "publish" }, "mcp", publicOrigin(req.headers)));
}
