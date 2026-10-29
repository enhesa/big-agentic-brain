import { gate } from "./gate";
import { requireActorForApi, type SessionUser } from "./session";
import { assertFilesIdentity } from "./files";
import { toApiError } from "./errors";

/**
 * The start of every /api/files route that needs an identity: the request gate (body size, API
 * token), then the actor, then the file store's identity rule (lib/files.ts assertFilesIdentity).
 * The gate runs here even where proxy.ts also runs it: POST /api/files is outside the proxy matcher
 * so its body can stream, and a route must not depend on the matcher to be safe. A refusal comes
 * back as the Response to return.
 */
export async function requireFilesActor(req: Request): Promise<SessionUser | Response> {
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
    assertFilesIdentity(user);
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
  return user;
}
