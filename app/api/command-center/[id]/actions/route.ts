import { auditRequest } from "@/lib/request-audit";
import { ccApiError, runCommandCenter } from "@/lib/command-center";
import { readJsonObject, requireCommandCenterActor } from "@/lib/command-center-route";
import { withIdempotency } from "@/lib/idempotency";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

const ACTIONS = ["clear_question", "comment", "health", "remove"];

/** POST /api/command-center/:id/actions { action: clear_question | comment | health | remove, ... } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireCommandCenterActor(req);
  if (user instanceof Response) return user;
  const { id } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/command-center/${id}/actions`, via: "mcp" });
  return withIdempotency(req, user.id, async () => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return { status: body.status, body: await body.json() };
    if (typeof body.action !== "string" || !ACTIONS.includes(body.action)) {
      return { status: 400, body: { error: `action must be one of ${ACTIONS.join(", ")}; required, has no default` } };
    }
    if (body.id !== undefined && body.id !== id) {
      return { status: 400, body: { error: `id in the body ('${String(body.id)}') must match the path ('${id}')` } };
    }
    try {
      return { status: 200, body: runCommandCenter(user, { ...body, id }, "mcp", publicOrigin(req.headers)) };
    } catch (err) {
      return ccApiError(err);
    }
  });
}
