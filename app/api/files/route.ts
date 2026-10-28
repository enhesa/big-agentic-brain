import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { listFiles, putFile } from "@/lib/files";
import { toApiError } from "@/lib/errors";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

async function actorOr(): Promise<Awaited<ReturnType<typeof requireActorForApi>> | Response> {
  try {
    return await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

/** GET /api/files: my live files, files shared with me, and my quota use. */
export async function GET() {
  const user = await actorOr();
  if (user instanceof Response) return user;
  await auditRequest({ actor: user, method: "GET", path: "/api/files", via: "mcp" });
  try {
    return Response.json(listFiles(user.id));
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}

/**
 * POST /api/files?name=report.md[&expiresInDays=7][&shareWith=a@x,b@x][&orgVisible=true][&to=a@x][&subject=..][&note=..]
 * The request body is the file's raw bytes (curl --data-binary @file). No Idempotency-Key support:
 * that would buffer the whole body; a retried upload is a second file, which the owner can delete.
 */
export async function POST(req: NextRequest) {
  const user = await actorOr();
  if (user instanceof Response) return user;
  await auditRequest({ actor: user, method: "POST", path: "/api/files", via: "mcp" });
  const q = new URL(req.url).searchParams;
  const length = req.headers.get("content-length");
  try {
    const result = await putFile(
      {
        ownerId: user.id,
        name: q.get("name"),
        body: req.body,
        declaredSize: length == null ? null : Number(length),
        expiresInDays: q.get("expiresInDays"),
        shareWith: q.get("shareWith"),
        orgVisible: q.get("orgVisible"),
        to: q.get("to"),
        subject: q.get("subject"),
        note: q.get("note"),
      },
      "mcp",
      publicOrigin(req.headers),
    );
    return Response.json(result, { status: 201 });
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}
