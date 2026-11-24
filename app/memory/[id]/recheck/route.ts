import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { forbiddenResponse, redirectTo, sameOrigin } from "@/lib/feedback-web";
import { readFields, wantsJson } from "@/lib/me-web";
import { checkUiRateLimit } from "@/lib/rate-limit";
import { RECHECK_MESSAGES, RECHECK_OK_CODES, runRecheckAction, type RecheckCode } from "@/lib/recheck-web";

export const dynamic = "force-dynamic";

/**
 * POST /memory/[id]/recheck {answer: yes|no|unsure|agent|later, note}: a button in the "Waiting for
 * you" view of /memory/review (lib/recheck-web.ts). Anyone signed in. It lives under /memory so the
 * sign-in proxy attaches the viewer. sameOrigin first: the cookie makes a cross-site post possible.
 * A form post is answered with a redirect back with a fixed code (?check=), a JSON caller with JSON.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request)) return forbiddenResponse();
  const { id } = await params;
  const json = wantsJson(request);
  const viewer = await getViewer();
  if (!viewer) return new Response("Not found", { status: 404 });
  const back = (code: RecheckCode) => redirectTo(request, `/memory/review?check=${code}#waiting`);
  if (!checkUiRateLimit(viewer.ownerId)) return json ? notifyJson({ error: RECHECK_MESSAGES.slow }, 429) : back("slow");
  await auditRequest({ actor: viewer.actor, method: "POST", path: `/memory/${id}/recheck`, via: "ui" });

  const { answer, note } = await readFields(request);
  const code = runRecheckAction(viewer.ownerId, id, answer, note);
  if (json) {
    const ok = RECHECK_OK_CODES.includes(code);
    return notifyJson(ok ? { ok: true, code, message: RECHECK_MESSAGES[code] } : { error: RECHECK_MESSAGES[code], code }, ok ? 200 : code === "gone" ? 404 : code === "streak" ? 409 : 400);
  }
  return back(code);
}
