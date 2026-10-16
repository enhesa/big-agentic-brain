import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { learningCountsByAuthor, renameUser, publicUser } from "@/lib/users";
import { listMine } from "@/lib/todos";
import { unreadCountFor } from "@/lib/messages";
import { areasOf } from "@/lib/area-contacts";
import { getUser } from "@/lib/users";

export const dynamic = "force-dynamic";

/** GET /api/me — echo of the resolved actor plus their counts. */
export async function GET() {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/me", via: "mcp" });

  const counts = {
    learnings: learningCountsByAuthor()[user.id] ?? 0,
    todosOpen: listMine(user.id, "open").length,
    unreadMessages: unreadCountFor(user.id),
  };

  return Response.json({ actor: user, counts, homeTeam: getUser(user.id)?.home_team ?? null, areas: areasOf(user.id) });
}

/** POST /api/me — { name } — the one deliberate, audited way to change your display name. */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "POST", path: "/api/me", via: "mcp" });

  const payload = await req.json().catch(() => null);
  const nameRaw = (payload as { name?: unknown } | null)?.name;
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (name.length < 2 || name.length > 80) {
    return Response.json({ error: "name must be 2-80 characters" }, { status: 400 });
  }

  const updated = renameUser(user.id, name, "mcp");
  return Response.json({ actor: publicUser(updated) });
}
