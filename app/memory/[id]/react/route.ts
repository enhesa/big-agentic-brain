import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { forbiddenResponse, redirectTo, sameOrigin } from "@/lib/feedback-web";
import { readFields, wantsJson } from "@/lib/me-web";
import { checkUiRateLimit } from "@/lib/rate-limit";
import { getById, vote } from "@/lib/learnings";
import { addComment, assertMayComment, cleanCommentBody } from "@/lib/memory-comments";
import { ApiError, toApiError } from "@/lib/errors";
import { refusalCode, type ReactCode } from "@/lib/memory-react-web";

export const dynamic = "force-dynamic";

const ACTIONS = ["helpful", "not_helpful", "comment"] as const;
type WebAction = (typeof ACTIONS)[number];

/**
 * POST /memory/[id]/react {action, body?}: the vote and comment form on a memory's page.
 * helpful and not_helpful are the same vote as bab_react, with via "ui": one vote per person (the two
 * switch), never on your own memory. comment posts body as a comment (lib/memory-comments.ts);
 * anyone may comment, the author too. A vote with a non-empty body is "vote + comment", two records:
 * the comment is checked first, so a comment that would be refused writes nothing at all.
 * Kudos, flag, retire, confirm and keep stay with agents (bab_react).
 *
 * It lives under /memory, not /api, so the sign-in proxy attaches the viewer; only a browser linked
 * to a person acts (getViewer). The cookie makes a cross-site post possible, so sameOrigin comes
 * first. A plain form post is answered with a redirect back to the page with a fixed code (?react=),
 * a JSON caller with JSON.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return forbiddenResponse();
  const { id } = await params;
  const json = wantsJson(request);
  const back = (code: ReactCode, anchor = "comments") =>
    redirectTo(request, `/memory/${encodeURIComponent(id)}?react=${code}#${anchor}`);

  const viewer = await getViewer();
  if (!viewer) return json ? notifyJson({ error: "Link your browser on /me/devices first", linkRequired: true }, 401) : back("link");
  if (!checkUiRateLimit(viewer.ownerId)) return json ? notifyJson({ error: "Too many requests; wait a minute" }, 429) : back("slow");
  await auditRequest({ actor: viewer.actor, method: "POST", path: `/memory/${id}/react`, via: "ui" });

  const { action, body } = await readFields(request);
  if (!ACTIONS.includes(action as WebAction)) {
    return json ? notifyJson({ error: `action must be one of ${ACTIONS.join(", ")}` }, 400) : back("invalid");
  }
  const learning = getById(id);
  if (!learning || learning.status === "deleted") return json ? notifyJson({ error: "Learning not found" }, 404) : back("gone");

  const isVote = action !== "comment";
  if (isVote && learning.author_id === viewer.ownerId) {
    return json ? notifyJson({ error: "Cannot vote on your own learning" }, 403) : back("own");
  }
  const withComment = action === "comment" || (typeof body === "string" && body.trim() !== "");

  let changed = true;
  let commentId: string | null = null;
  try {
    if (withComment) {
      // Checked before the vote: a refused comment must not leave a vote behind on its own.
      cleanCommentBody(body ?? null);
      assertMayComment(viewer.ownerId);
    }
    if (isVote) changed = vote(id, viewer.ownerId, action as "helpful" | "not_helpful", "ui").changed;
    if (withComment) commentId = addComment(id, viewer.ownerId, body, "ui").id;
  } catch (err) {
    // Anything that is not a refusal is a bug: let it surface as one, not as a friendly line.
    if (!(err instanceof ApiError)) throw err;
    if (json) {
      const { status, body: errBody } = toApiError(err);
      return notifyJson({ error: errBody.error }, status);
    }
    return back(refusalCode(err));
  }
  if (json) return notifyJson({ ok: true, action, ...(isVote ? { changed } : {}), ...(commentId ? { commentId } : {}) });
  if (commentId) return back(isVote ? "voted-commented" : "commented", `comment-${commentId}`);
  return back(changed ? "done" : "same");
}
