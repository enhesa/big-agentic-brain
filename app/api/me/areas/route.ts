import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { addAreaContact, areasOf, contactsForArea, removeAreaContact } from "@/lib/area-contacts";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** GET /api/me/areas — the areas you are a contact for. */
export async function GET() {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/me/areas", via: "mcp" });
  return Response.json({ areas: areasOf(user.id) });
}

/** POST /api/me/areas — { area, note? } — makes you a contact for an area; the same area again changes the note. */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "POST", path: "/api/me/areas", via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = await req.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return { status: 400, body: { error: "Body must be a JSON object" } };
      }
      const { area, note } = payload as { area?: unknown; note?: unknown };
      const mine = addAreaContact(user.id, area, note, "mcp");
      return { status: 200, body: { ...mine, contacts: contactsForArea(mine.area) } };
    } catch (err) {
      return toApiError(err);
    }
  });
}

/** DELETE /api/me/areas?area=&user= — drops you from an area. A maintainer may pass user to remove someone else. */
export async function DELETE(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "DELETE", path: "/api/me/areas", via: "mcp" });

  try {
    const params = new URL(req.url).searchParams;
    const removed = removeAreaContact(user.id, params.get("area"), params.get("user") ?? undefined, "mcp");
    return Response.json({ removed });
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}
