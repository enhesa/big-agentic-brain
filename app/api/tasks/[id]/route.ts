import { auditRequest } from "@/lib/request-audit";
import { runTasks, runTasksGet } from "@/lib/tasks";
import { answer, readJsonObject, requireTasksActor } from "@/lib/tasks-route";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/tasks/:id: one of your initiatives, whole. */
export async function GET(req: Request, { params }: Ctx) {
  const user = await requireTasksActor(req);
  if (user instanceof Response) return user;
  const { id } = await params;
  await auditRequest({ actor: user, method: "GET", path: `/api/tasks/${id}`, via: "mcp" });
  return answer(() => runTasksGet(user, id, publicOrigin(req.headers)));
}

/**
 * PUT /api/tasks/:id: publish the whole record (the publish action). Idempotent by
 * nature: the same record twice is one initiative. The id in the body, if any, must match.
 */
export async function PUT(req: Request, { params }: Ctx) {
  const user = await requireTasksActor(req);
  if (user instanceof Response) return user;
  const { id } = await params;
  await auditRequest({ actor: user, method: "PUT", path: `/api/tasks/${id}`, via: "mcp" });
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  if (body.id !== undefined && body.id !== id) {
    return Response.json({ error: `id in the body ('${String(body.id)}') must match the path ('${id}')` }, { status: 400 });
  }
  if ("action" in body) return Response.json({ error: "unknown field 'action'; PUT publishes the record, actions go to POST /api/tasks/<id>/actions" }, { status: 400 });
  return answer(() => runTasks(user, { ...body, id, action: "publish" }, "mcp", publicOrigin(req.headers)));
}

/**
 * PATCH /api/tasks/:id: change part of an existing record (the patch action). Fields left
 * out stay; tasks, questions and links merge by id (links by url), and remove: true drops one.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const user = await requireTasksActor(req);
  if (user instanceof Response) return user;
  const { id } = await params;
  await auditRequest({ actor: user, method: "PATCH", path: `/api/tasks/${id}`, via: "mcp" });
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;
  if (body.id !== undefined && body.id !== id) {
    return Response.json({ error: `id in the body ('${String(body.id)}') must match the path ('${id}')` }, { status: 400 });
  }
  if ("action" in body) return Response.json({ error: "unknown field 'action'; PATCH changes the record, actions go to POST /api/tasks/<id>/actions" }, { status: 400 });
  return answer(() => runTasks(user, { ...body, id, action: "patch" }, "mcp", publicOrigin(req.headers)));
}
