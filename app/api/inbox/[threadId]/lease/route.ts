import { NextRequest } from "next/server";
import { requireActorForApi } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { recordLease, LEASE_MAX_TURNS, LEASE_MAX_MINUTES } from "@/lib/messages";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * POST /api/inbox/[threadId]/lease — { turns: <=10, minutes: <=60 }
 * Records that the caller pre-approved up to `turns` of their own future
 * replies in this thread, expiring after `minutes`. The server does not
 * enforce approvals itself; it decrements turnsLeft on each lease-backed
 * send (X-Bab-Lease: 1) and refuses further ones at 0.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  let user;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { threadId } = await params;
  await auditRequest({ actor: user, method: "POST", path: `/api/inbox/${threadId}/lease`, via: "mcp" });

  const payload = await req.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  const record = payload as Record<string, unknown>;

  const turns = Number(record.turns);
  const minutes = Number(record.minutes);
  if (!Number.isFinite(turns) || turns <= 0 || turns > LEASE_MAX_TURNS) {
    return Response.json({ error: `turns must be 1-${LEASE_MAX_TURNS}` }, { status: 400 });
  }
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > LEASE_MAX_MINUTES) {
    return Response.json({ error: `minutes must be 1-${LEASE_MAX_MINUTES}` }, { status: 400 });
  }

  try {
    const lease = recordLease(threadId, user.id, turns, minutes);
    return Response.json({ lease });
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}
