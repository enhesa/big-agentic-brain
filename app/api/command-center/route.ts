import { auditRequest } from "@/lib/request-audit";
import { runCommandCenter } from "@/lib/command-center";
import { answer, requireCommandCenterActor } from "@/lib/command-center-route";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** GET /api/command-center: your initiatives with seq, updatedAt, open questions, data health and usage (the list action). */
export async function GET(req: Request) {
  const user = await requireCommandCenterActor(req);
  if (user instanceof Response) return user;
  await auditRequest({ actor: user, method: "GET", path: "/api/command-center", via: "mcp" });
  return answer(() => runCommandCenter(user, { action: "list" }, "mcp", publicOrigin(req.headers)));
}
