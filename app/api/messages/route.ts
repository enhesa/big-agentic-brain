import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { send, validateRequest, NEW_THREAD_NEEDS_TO } from "@/lib/messages";
import { withIdempotency } from "@/lib/idempotency";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** POST /api/messages — { to, subject?, threadId?, body }. Send, or reply into a thread. */
export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  await auditRequest({ actor: user, method: "POST", path: "/api/messages", via: "mcp" });

  return withIdempotency(req, user.id, async () => {
    try {
      const payload = await req.json().catch(() => null);
      if (!payload || typeof payload !== "object") {
        return { status: 400, body: { error: "Body must be a JSON object" } };
      }
      const record = payload as Record<string, unknown>;

      const to = String(record.to ?? "").trim();
      const body = String(record.body ?? "").trim();
      const subject = record.subject == null ? undefined : String(record.subject);
      const threadId = record.threadId == null ? undefined : String(record.threadId).trim() || undefined;
      if (!body) {
        return { status: 400, body: { error: "body is required" } };
      }
      // A new thread needs a recipient; a reply can omit it (inferred from the thread).
      // Messages go to a person's inbox only: an old client's toSession is ignored.
      if (!to && !threadId) {
        return { status: 400, body: { error: NEW_THREAD_NEEDS_TO } };
      }

      const kindRaw = record.kind;
      if (kindRaw !== undefined && kindRaw !== "human") {
        return { status: 400, body: { error: 'kind must be "human"; auto replies are no longer supported' } };
      }
      const kind = undefined;
      const useLease = req.headers.get("x-bab-lease") === "1";

      if (record.request !== undefined && typeof record.request !== "object") {
        return { status: 400, body: { error: "request must be an object" } };
      }
      const request = record.request == null ? undefined : validateRequest(record.request);

      const result = send(
        { fromId: user.id, to, subject, body, threadId, kind, useLease, request },
        "mcp",
      );
      return { status: 201, body: result };
    } catch (err) {
      return toApiError(err);
    }
  });
}
