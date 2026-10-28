import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { forbiddenResponse, redirectTo, sameOrigin } from "@/lib/feedback-web";
import { readFields, wantsJson } from "@/lib/me-web";
import { checkUiRateLimit } from "@/lib/rate-limit";
import { getById, giveKudos, noteArg, vote } from "@/lib/learnings";
import { ApiError, ConflictError, ForbiddenError, NotFoundError, ValidationError, toApiError } from "@/lib/errors";
import type { ReactCode } from "@/lib/memory-react-web";

export const dynamic = "force-dynamic";

const ACTIONS = ["helpful", "not_helpful", "kudos"] as const;
type WebReaction = (typeof ACTIONS)[number];

function refusalCode(err: unknown): ReactCode {
  if (err instanceof ForbiddenError) return "own";
  if (err instanceof ConflictError) return "kudos-given";
  if (err instanceof NotFoundError) return "gone";
  // The only refusal giveKudos makes from its input is the note: too long, before or after redaction.
  if (err instanceof ValidationError) return "note";
  return "invalid";
}

/**
 * POST /memory/[id]/react {action, note?}: the Helpful, Not helpful and Kudos buttons on a memory's
 * page. The same lib functions as bab_react, with via "ui": one vote per person (helpful and not
 * helpful switch), never on your own memory, one kudos with an optional note. Flag, retire, confirm
 * and keep need evidence and stay with agents. It lives under /memory, not /api, so the sign-in
 * proxy attaches the viewer; only a browser linked to a person reacts (getViewer). The cookie makes
 * a cross-site post possible, so sameOrigin comes first. A plain form post is answered with a
 * redirect back to the page with a fixed code (?react=), a JSON caller with JSON.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return forbiddenResponse();
  const { id } = await params;
  const json = wantsJson(request);
  const back = (code: ReactCode) => redirectTo(request, `/memory/${encodeURIComponent(id)}?react=${code}`);

  const viewer = await getViewer();
  if (!viewer) return json ? notifyJson({ error: "Link your browser on /me/devices first", linkRequired: true }, 401) : back("link");
  if (!checkUiRateLimit(viewer.ownerId)) return json ? notifyJson({ error: "Too many requests; wait a minute" }, 429) : back("slow");
  await auditRequest({ actor: viewer.actor, method: "POST", path: `/memory/${id}/react`, via: "ui" });

  const { action, note } = await readFields(request);
  if (!ACTIONS.includes(action as WebReaction)) {
    return json ? notifyJson({ error: "action must be one of helpful, not_helpful, kudos" }, 400) : back("invalid");
  }
  const learning = getById(id);
  if (!learning || learning.status === "deleted") return json ? notifyJson({ error: "Learning not found" }, 404) : back("gone");

  let changed = true;
  try {
    if (action === "kudos") {
      giveKudos(id, viewer.ownerId, noteArg(note ?? null), "ui");
    } else {
      changed = vote(id, viewer.ownerId, action as "helpful" | "not_helpful", "ui").changed;
    }
  } catch (err) {
    // Anything that is not a refusal is a bug: let it surface as one, not as a friendly line.
    if (!(err instanceof ApiError)) throw err;
    if (json) {
      const { status, body } = toApiError(err);
      return notifyJson({ error: body.error }, status);
    }
    return back(refusalCode(err));
  }
  return json ? notifyJson({ ok: true, action, changed }) : back(changed ? "done" : "same");
}
