import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { create, list, type CreateFeedbackInput } from "@/lib/feedback";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** GET /api/feedback?status=&kind=&area=&author=&q=&sort=top|new&limit=&offset= */
export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "GET", path: "/api/feedback", via: "mcp" });

  const p = new URL(req.url).searchParams;
  try {
    const page = list({
      status: p.get("status") ?? undefined,
      kind: p.get("kind") ?? undefined,
      area: p.get("area") ?? undefined,
      author: p.get("author") ?? undefined,
      q: p.get("q") ?? undefined,
      sort: p.get("sort") === "new" ? "new" : "top",
      limit: p.has("limit") ? Number(p.get("limit")) : undefined,
      offset: p.has("offset") ? Number(p.get("offset")) : undefined,
    });
    return Response.json(page);
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}

/** POST /api/feedback { kind, area, title, body, clientVersion?, confirmNotDuplicate? } */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "POST", path: "/api/feedback", via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return { status: 400, body: { error: "Body must be a JSON object" } };
      }
      const feedback = create(
        {
          authorId: user.id,
          source: "agent",
          kind: payload.kind as CreateFeedbackInput["kind"],
          area: payload.area as CreateFeedbackInput["area"],
          title: String(payload.title ?? ""),
          body: String(payload.body ?? ""),
          clientVersion: payload.clientVersion == null ? null : String(payload.clientVersion),
          confirmNotDuplicate: payload.confirmNotDuplicate === true,
        },
        "mcp",
      );
      return { status: 201, body: { feedback } };
    } catch (err) {
      return toApiError(err);
    }
  });
}
