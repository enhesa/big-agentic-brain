import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { listUsers, learningCountsByAuthor, publicUser } from "@/lib/users";
import { areasByUser, contactsForArea } from "@/lib/area-contacts";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** GET /api/people — the user directory; ?area= lists the contacts for one knowledge area instead. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/people", via: "mcp" });

  const area = new URL(req.url).searchParams.get("area");
  if (area?.trim()) {
    try {
      return Response.json({ area, contacts: contactsForArea(area) });
    } catch (err) {
      const { status, body } = toApiError(err);
      return Response.json(body, { status });
    }
  }

  const counts = learningCountsByAuthor();
  const areas = areasByUser();
  const users = listUsers().map((u) => ({
    ...publicUser(u),
    learningCount: counts[u.id] ?? 0,
    homeTeam: u.home_team,
    areas: (areas.get(u.id) ?? []).map((a) => a.area),
  }));

  return Response.json({ users });
}
