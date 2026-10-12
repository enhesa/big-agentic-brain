import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { listProjects } from "@/lib/learnings";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects — every project in use across active
 * learnings, each with a count, newest activity first. Lets an agent
 * discover what project keys already exist before picking one.
 */
export async function GET() {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/projects", via: "mcp" });

  return Response.json({ projects: listProjects() });
}
