import { auditRequest } from "@/lib/request-audit";
import { CC_RETIRED_ACTIONS, ccApiError, runTasks } from "@/lib/tasks";
import { readJsonObject, requireTasksActor } from "@/lib/tasks-route";
import { withIdempotency } from "@/lib/idempotency";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

const ACTIONS = ["remove"];

/** POST /api/tasks/:id/actions { action: "remove" }. comment, health and clear_question are gone: publish instead. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireTasksActor(req);
  if (user instanceof Response) return user;
  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/tasks/${id}/actions`, via: "mcp" });
  return withIdempotency(req, user.id, async () => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return { status: body.status, body: await body.json() };
    if (typeof body.action === "string" && Object.hasOwn(CC_RETIRED_ACTIONS, body.action)) {
      return { status: 400, body: { error: CC_RETIRED_ACTIONS[body.action] } };
    }
    if (typeof body.action !== "string" || !ACTIONS.includes(body.action)) {
      return { status: 400, body: { error: `action must be one of ${ACTIONS.join(", ")}; required, has no default` } };
    }
    if (body.id !== undefined && body.id !== id) {
      return { status: 400, body: { error: `id in the body ('${String(body.id)}') must match the path ('${id}')` } };
    }
    try {
      return { status: 200, body: runTasks(user, { ...body, id }, "mcp", publicOrigin(req.headers)) };
    } catch (err) {
      return ccApiError(err);
    }
  });
}
