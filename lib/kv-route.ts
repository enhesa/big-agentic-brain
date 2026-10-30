import { gate } from "./gate";
import { requireActorForApi, type SessionUser } from "./session";
import { assertKvEnabled, assertKvIdentity } from "./kv";
import { toApiError } from "./errors";

/**
 * The start of every /api/kv route: the request gate (body size, API token), then the actor, then
 * the switch and the identity rule of the key-value store (lib/kv.ts assertKvIdentity). The proxy
 * runs the gate too; it runs here again so the route never depends on the proxy matcher to be safe.
 * A refusal comes back as the Response to return.
 */
export async function requireKvActor(req: Request): Promise<SessionUser | Response> {
  const refused = gate(req);
  if (refused) return refused;
  let user: SessionUser;
  try {
    user = await requireActorForApi();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  try {
    assertKvEnabled();
    assertKvIdentity(user);
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
  return user;
}
