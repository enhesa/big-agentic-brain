import { gate } from "./gate";
import { requireActorForApi, type SessionUser } from "./session";
import { CC_MAX_BODY_BYTES, ccApiError } from "./command-center";

/**
 * The start of every /api/command-center route: the request gate (body size, API token), the
 * Command Center body cap, then the actor. The switch, identity rule, pace and opt-in run in
 * lib/command-center.ts runCommandCenter, so the MCP tool gets the same checks.
 */
export async function requireCommandCenterActor(req: Request): Promise<SessionUser | Response> {
  const refused = gate(req);
  if (refused) return refused;
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > CC_MAX_BODY_BYTES) return tooLarge();
  try {
    return await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

export function tooLarge(): Response {
  return Response.json({ error: `request body too large: at most ${CC_MAX_BODY_BYTES / 1024} KB for Command Center` }, { status: 413 });
}

/** Reads a JSON object body within the cap. A Response is the refusal to return. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | Response> {
  const textBody = await req.text().catch(() => "");
  if (Buffer.byteLength(textBody, "utf8") > CC_MAX_BODY_BYTES) return tooLarge();
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBody);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

/** Runs a Command Center call and answers JSON, mapping refusals (a 409 keeps the current record). */
export function answer(fn: () => unknown, okStatus = 200): Response {
  try {
    return Response.json(fn(), { status: okStatus });
  } catch (err) {
    const { status, body } = ccApiError(err);
    return Response.json(body, { status });
  }
}
