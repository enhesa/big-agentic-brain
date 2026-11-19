import { auditRequest } from "@/lib/request-audit";
import { getViewer, notifyJson } from "@/lib/notify-auth";
import { forbiddenResponse, redirectTo, sameOrigin } from "@/lib/feedback-web";
import { readFields, wantsJson } from "@/lib/me-web";
import { checkUiRateLimit } from "@/lib/rate-limit";
import { answerRequest } from "@/lib/messages";
import { ApiError, toApiError } from "@/lib/errors";
import { inboxEnabled } from "@/lib/inbox-page";
import { getDb } from "@/lib/db";
import { answerRefusalCode, type AnswerCode } from "@/lib/inbox-answer-web";

export const dynamic = "force-dynamic";

const MESSAGE_ID_RE = /^[0-9a-f-]{36}$/i;

/**
 * POST /inbox/answer {messageId, option, note?}: the answer form under a question with options.
 * `option` is the number of the chosen option. Only a person the message went to may answer
 * (answerRequest), and a later pick replaces the earlier one.
 *
 * It lives under /inbox so the sign-in proxy attaches the viewer; only a browser linked to a
 * person acts (getViewer). The cookie makes a cross-site post possible, so sameOrigin comes
 * first. A plain form post is answered with a 303 back to the thread with a fixed code
 * (?answered=), a JSON caller with JSON.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenResponse();
  const json = wantsJson(request);
  if (!inboxEnabled()) return notifyJson({ error: "The Inbox page is switched off" }, 503);

  const fields = await readFields(request);
  const messageId = MESSAGE_ID_RE.test(fields.messageId ?? "") ? fields.messageId : "";
  // The thread link only ever points at a thread the viewer is in: no hint about anyone else's.
  let threadId: string | null = null;
  const back = (code: AnswerCode) =>
    redirectTo(request, `${threadId ? `/inbox?thread=${encodeURIComponent(threadId)}&` : "/inbox?"}answered=${code}${threadId ? `#m-${messageId}` : ""}`);

  const viewer = await getViewer();
  if (!viewer) return json ? notifyJson({ error: "Link your browser on /me/devices first", linkRequired: true }, 401) : back("link");
  if (!checkUiRateLimit(viewer.ownerId)) return json ? notifyJson({ error: "Too many requests; wait a minute" }, 429) : back("slow");
  await auditRequest({ actor: viewer.actor, method: "POST", path: "/inbox/answer", via: "ui" });

  const row = messageId
    ? (getDb()
        .prepare(
          `SELECT m.thread_id FROM messages m
           JOIN thread_participants p ON p.thread_id = m.thread_id AND p.user_id = ?
           WHERE m.id = ?`,
        )
        .get(viewer.ownerId, messageId) as { thread_id: string } | undefined)
    : undefined;
  if (!row) return json ? notifyJson({ error: "Message not found" }, 404) : back("gone");
  threadId = row.thread_id;

  try {
    const result = answerRequest(messageId, viewer.ownerId, { option: fields.option, note: fields.note }, "ui");
    if (json) return notifyJson({ ok: true, answer: result.answer, changed: result.changed, unchanged: result.unchanged });
    return back(result.unchanged ? "unchanged" : result.changed ? "changed" : "saved");
  } catch (err) {
    // Anything that is not a refusal is a bug: let it surface as one, not as a friendly line.
    if (!(err instanceof ApiError)) throw err;
    if (json) {
      const { status, body } = toApiError(err);
      return notifyJson({ error: body.error }, status);
    }
    return back(answerRefusalCode(err));
  }
}
