import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { setHomeTeam } from "@/lib/area-contacts";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/me/team — { team } — sets your own home team (a team tag); an empty string or null clears it, a missing team is a 400. */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "POST", path: "/api/me/team", via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = await req.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return { status: 400, body: { error: "Body must be a JSON object" } };
      }
      const team = (payload as { team?: unknown }).team;
      if (team !== null && team !== undefined && typeof team !== "string") {
        return { status: 400, body: { error: "team must be a string" } };
      }
      return { status: 200, body: { homeTeam: setHomeTeam(user.id, team, "mcp") } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
