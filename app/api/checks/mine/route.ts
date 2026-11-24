import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { waitingFor } from "@/lib/checks";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/**
 * GET /api/checks/mine: the memories waiting for the caller's check (lib/checks.ts), as JSON. The
 * feed a team can connect to its own chat or email; BAB itself sends no email. Each item has the
 * memory's exact text (at most 5 lines; `truncated` when longer) and its address. Answer with POST
 * /api/learnings/:id/recheck or bab_react recheck.
 */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/checks/mine", via: "mcp" });
  const origin = publicOrigin(req.headers);
  const checks = waitingFor(user.id).map((c) => ({ ...c, url: `${origin}/memory/${c.id}` }));
  return Response.json({
    checks,
    total: checks.length,
    answers: ["yes", "no", "unsure", "agent", "later"],
    answerWith: "POST /api/learnings/:id/recheck { answer, note }",
  });
}
