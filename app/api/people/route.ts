import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { contactsForArea, normalizeArea } from "@/lib/area-contacts";
import { peopleDirectory } from "@/lib/people-directory";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** GET /api/people: the user directory (activity and standing for maintainers only); ?area= lists the contacts for one knowledge area instead. */
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
      return Response.json({ area: normalizeArea(area), contacts: contactsForArea(area) });
    } catch (err) {
      const { status, body } = toApiError(err);
      return Response.json(body, { status });
    }
  }

  return Response.json({ users: peopleDirectory(user.id) });
}
