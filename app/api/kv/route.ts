import { auditRequest } from "@/lib/request-audit";
import { runKv } from "@/lib/kv";
import { requireKvActor } from "@/lib/kv-route";
import { toApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

function answer(fn: () => unknown): Response {
  try {
    return Response.json(fn());
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}

/** GET /api/kv?key=<key> reads one key; GET /api/kv?prefix=<prefix> (or no query) lists keys with their TTL. */
export async function GET(req: Request) {
  const user = await requireKvActor(req);
  if (user instanceof Response) return user;
  await auditRequest({ actor: user, method: "GET", path: "/api/kv", via: "mcp" });
  const q = new URL(req.url).searchParams;
  const key = q.get("key");
  return answer(() => runKv(user, key != null ? { action: "get", key } : { action: "list", prefix: q.get("prefix") ?? "" }, "mcp"));
}

/**
 * POST /api/kv { action, key, ... }: the same actions and fields as the bab_kv tool. No
 * Idempotency-Key replay: answers carry lock tokens and values, which must not be kept in the
 * database, and the store has its own safe retries (set with ifAbsent, cas, unlock with a token).
 */
export async function POST(req: Request) {
  const user = await requireKvActor(req);
  if (user instanceof Response) return user;
  await auditRequest({ actor: user, method: "POST", path: "/api/kv", via: "mcp" });
  const payload = (await req.json().catch(() => null)) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Body must be a JSON object: { action, key, ... }" }, { status: 400 });
  }
  return answer(() => runKv(user, payload as Record<string, unknown>, "mcp"));
}
