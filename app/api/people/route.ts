import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { listUsers, learningCountsByAuthor, publicUser } from "@/lib/users";

export const dynamic = "force-dynamic";

/** GET /api/people — the user directory. */
export async function GET() {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/people", via: "mcp" });

  const counts = learningCountsByAuthor();
  const users = listUsers().map((u) => ({
    ...publicUser(u),
    learningCount: counts[u.id] ?? 0,
  }));

  return Response.json({ users });
}
