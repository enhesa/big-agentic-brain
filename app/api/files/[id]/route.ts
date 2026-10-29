import { NextRequest } from "next/server";
import { auditRequest } from "@/lib/request-audit";
import { createDownloadLink, deleteFile, fileView, updateFile } from "@/lib/files";
import { requireFilesActor } from "@/lib/files-route";
import { toApiError } from "@/lib/errors";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function run(req: NextRequest, ctx: Ctx, method: string, fn: (actorId: string, id: string) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }) {
  const user = await requireFilesActor(req);
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  await auditRequest({ actor: user, method, path: `/api/files/${id}`, via: "mcp" });
  try {
    const { status, body } = await fn(user.id, id);
    return Response.json(body, { status });
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}

/** GET /api/files/:id: the file's details and a fresh short-lived download link. */
export async function GET(req: NextRequest, ctx: Ctx) {
  return run(req, ctx, "GET", (actorId, id) => ({
    status: 200,
    body: { file: fileView(actorId, id), download: createDownloadLink(actorId, id, publicOrigin(req.headers)) },
  }));
}

/** PATCH /api/files/:id { shareWith?, unshare?, orgVisible?, expiresInDays? }: owner only. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return run(req, ctx, "PATCH", async (actorId, id) => {
    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object") return { status: 400, body: { error: "Body must be a JSON object" } };
    const r = payload as Record<string, unknown>;
    return { status: 200, body: { file: updateFile(actorId, id, { shareWith: r.shareWith, unshare: r.unshare, orgVisible: r.orgVisible, expiresInDays: r.expiresInDays }, "mcp") } };
  });
}

/** DELETE /api/files/:id: owner only; the bytes go at once and the quota frees at once. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return run(req, ctx, "DELETE", (actorId, id) => ({ status: 200, body: deleteFile(actorId, id, "mcp") }));
}
