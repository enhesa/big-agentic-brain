import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { forbiddenResponse, redirectTo, sameOrigin } from "@/lib/feedback-web";
import { readFields, wantsJson } from "@/lib/me-web";
import { checkUiRateLimit } from "@/lib/rate-limit";
import { editComment, removeComment } from "@/lib/memory-comments";
import { ApiError, toApiError } from "@/lib/errors";
import { refusalCode, type ReactCode } from "@/lib/memory-react-web";

export const dynamic = "force-dynamic";

/**
 * POST /memory/[id]/comments/[commentId] {action: edit | delete, body?}: change or remove a comment
 * from the memory's page. The comment's author edits or deletes it; a maintainer may delete any
 * (lib/memory-comments.ts). The same guards as the vote form: sameOrigin first, then a linked
 * browser (getViewer), then the UI rate limit. A form post gets a redirect with a fixed ?react= code.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; commentId: string }> }) {
  if (!sameOrigin(request)) return forbiddenResponse();
  const { id, commentId } = await params;
  const json = wantsJson(request);
  const page = `/memory/${encodeURIComponent(id)}`;
  const back = (code: ReactCode, anchor: string) => redirectTo(request, `${page}?react=${code}#${anchor}`);

  const viewer = await getViewer();
  if (!viewer) return json ? notifyJson({ error: "Link your browser on /me/devices first", linkRequired: true }, 401) : back("link", "comments");
  if (!checkUiRateLimit(viewer.ownerId)) return json ? notifyJson({ error: "Too many requests; wait a minute" }, 429) : back("slow", "comments");
  await auditRequest({ actor: viewer.actor, method: "POST", path: `/memory/${id}/comments/${commentId}`, via: "ui" });

  const { action, body } = await readFields(request);
  if (action !== "edit" && action !== "delete") {
    return json ? notifyJson({ error: "action must be one of edit, delete" }, 400) : back("invalid", "comments");
  }
  try {
    if (action === "edit") {
      const { changed } = editComment(id, commentId, viewer.ownerId, body ?? null, "ui");
      return json ? notifyJson({ ok: true, action, changed }) : back("edited", `comment-${commentId}`);
    }
    removeComment(id, commentId, viewer.ownerId, "ui");
    return json ? notifyJson({ ok: true, action }) : back("removed", `comment-${commentId}`);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (json) {
      const { status, body: errBody } = toApiError(err);
      return notifyJson({ error: errBody.error }, status);
    }
    return back(refusalCode(err), "comments");
  }
}
