import { auditRequest } from "@/lib/request-audit";
import { getViewer } from "@/lib/notify-auth";
import { create, type CreateFeedbackInput } from "@/lib/feedback";
import { ApiError, ConflictError, TooManyRequestsError } from "@/lib/errors";
import { isUuid } from "@/lib/feedback";
import { forbiddenResponse, redirectTo, sameOrigin, unauthorizedResponse } from "@/lib/feedback-web";

export const dynamic = "force-dynamic";

/**
 * POST /feedback/submit: the web form's target. Outside /api so the sign-in proxy attaches the
 * viewer; an agent posts through /api/feedback or bab_feedback instead. The item is
 * filed as source "human" under the viewer's own identity, never one named in the form.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbiddenResponse();
  const viewer = await getViewer();
  if (!viewer) return unauthorizedResponse();
  await auditRequest({ actor: viewer.actor, method: "POST", path: "/feedback/submit", via: "ui" });

  const form = await req.formData().catch(() => null);
  const field = (name: string) => {
    const value = form?.get(name);
    return typeof value === "string" ? value : "";
  };

  try {
    const item = create(
      {
        authorId: viewer.ownerId,
        source: "human",
        kind: field("kind") as CreateFeedbackInput["kind"],
        area: field("area") as CreateFeedbackInput["area"],
        title: field("title"),
        body: field("body"),
        confirmNotDuplicate: field("confirmNotDuplicate") === "on",
      },
      "ui",
    );
    return redirectTo(req, `/feedback/${item.id}`);
  } catch (err) {
    // A fixed code, never message text: the form page maps it to a fixed sentence.
    const code =
      err instanceof ConflictError ? "duplicate" : err instanceof TooManyRequestsError ? "limit" : err instanceof ApiError || err instanceof Error ? "invalid" : "failed";
    const params = new URLSearchParams({ error: code });
    if (err instanceof ConflictError && err.candidates[0] && isUuid(err.candidates[0].id)) params.set("duplicate", err.candidates[0].id);
    return redirectTo(req, `/feedback/new?${params.toString()}`);
  }
}
