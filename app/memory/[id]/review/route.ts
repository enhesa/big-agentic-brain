import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { forbiddenResponse, redirectTo, sameOrigin } from "@/lib/feedback-web";
import { readFields, wantsJson } from "@/lib/me-web";
import { checkUiRateLimit } from "@/lib/rate-limit";
import { mayReview, REVIEW_OK_CODES, REVIEW_MESSAGES, runReviewAction, type ReviewCode } from "@/lib/review-web";

export const dynamic = "force-dynamic";

/**
 * POST /memory/[id]/review {action: confirm|keep|retire, note}: a button on the maintainer review
 * page (app/memory/review, lib/review-web.ts). Maintainers only; anyone else gets a 404, like
 * /admin. It lives under /memory so the sign-in proxy attaches the viewer. sameOrigin first: the
 * cookie makes a cross-site post possible. A form post is answered with a redirect back to the
 * review page with a fixed code (?review=), a JSON caller with JSON.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return forbiddenResponse();
  const { id } = await params;
  const json = wantsJson(request);
  const viewer = await getViewer();
  if (!viewer || !mayReview(viewer.ownerId)) return new Response("Not found", { status: 404 });
  const back = (code: ReviewCode) => redirectTo(request, `/memory/review?review=${code}`);
  if (!checkUiRateLimit(viewer.ownerId)) return json ? notifyJson({ error: REVIEW_MESSAGES.slow }, 429) : back("slow");
  await auditRequest({ actor: viewer.actor, method: "POST", path: `/memory/${id}/review`, via: "ui" });

  const { action, note } = await readFields(request);
  const code = runReviewAction(viewer.ownerId, id, action, note);
  if (json) {
    const ok = REVIEW_OK_CODES.includes(code);
    return notifyJson(ok ? { ok: true, code } : { error: REVIEW_MESSAGES[code], code }, ok ? 200 : code === "own" ? 403 : code === "gone" ? 404 : 400);
  }
  return back(code);
}
