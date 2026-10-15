import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { inboxFor } from "@/lib/messages";

export const dynamic = "force-dynamic";

/** GET /api/inbox — my threads with unread counts. */
export async function GET() {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  // The list is polled often (a mod, every 15 seconds per open session): one audit row per 5 minutes is enough.
  await auditRequest({ actor: user, method: "GET", path: "/api/inbox", via: "mcp", coalesce: { minutes: 5 } });

  const threads = inboxFor(user.id);
  return Response.json({ threads });
}
