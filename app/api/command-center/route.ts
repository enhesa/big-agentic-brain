import { auditRequest } from "@/lib/request-audit";
import { ccApiError, runCommandCenter } from "@/lib/command-center";
import { answer, readJsonObject, requireCommandCenterActor } from "@/lib/command-center-route";
import { withIdempotency } from "@/lib/idempotency";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** GET /api/command-center: your initiatives with seq, updatedAt, open questions, data health and usage (the list action). */
export async function GET(req: Request) {
  const user = await requireCommandCenterActor(req);
  if (user instanceof Response) return user;
  await auditRequest({ actor: user, method: "GET", path: "/api/command-center", via: "mcp" });
  return answer(() => runCommandCenter(user, { action: "list" }, "mcp", publicOrigin(req.headers)));
}

/** The person-level actions; each acts on the caller's own data only. */
const ACTIONS = ["delete_all", "export", "grant_export", "revoke_export"];

/**
 * POST /api/command-center { action: "delete_all" | "export" | "grant_export" | "revoke_export", id?, level? }:
 * the same actions as bab_command_center. The page has no controls for them.
 */
export async function POST(req: Request) {
  const user = await requireCommandCenterActor(req);
  if (user instanceof Response) return user;
  await auditRequest({ actor: user, method: "POST", path: "/api/command-center", via: "mcp" });
  const run = async () => {
    const body = await readJsonObject(req);
    if (body instanceof Response) return { status: body.status, body: await body.json() };
    if (typeof body.action !== "string" || !ACTIONS.includes(body.action)) {
      return { status: 400, body: { error: `action must be one of ${ACTIONS.join(", ")}; required, has no default` } };
    }
    try {
      return { status: 200, body: runCommandCenter(user, body, "mcp", publicOrigin(req.headers)) };
    } catch (err) {
      return ccApiError(err);
    }
  };
  // An export is a read that holds the whole log: never store it under an Idempotency-Key.
  const peek: unknown = await req.clone().json().catch(() => null);
  if (peek && typeof peek === "object" && (peek as { action?: unknown }).action === "export") {
    const { status, body } = await run();
    return Response.json(body, { status });
  }
  return withIdempotency(req, user.id, run);
}
