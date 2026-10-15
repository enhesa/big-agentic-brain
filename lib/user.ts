import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { config } from "./config";

export interface ProxyUser {
  id: string;
  email: string | null;
  name: string | null;
  roles: string[];
}

export const PROXY_SECRET_HEADER = "x-bab-proxy-secret";

function secretMatches(expected: string, got: string | null): boolean {
  if (got == null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Reads the signed-in user from the identity proxy headers (names come from config). Never trust a client-supplied
 * author id/email/name — this is the only source of truth for "who is acting".
 */
export async function currentUser(): Promise<ProxyUser | null> {
  const h = await headers();
  // The sign-in proxy percent-encodes any byte that is not safe ASCII, so a
  // name like "João" arrives as "Jo%C3%A3o". Decoding a plain value is a no-op.
  const read = (name: string) => {
    const raw = h.get(name);
    if (raw == null) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  const { proxy } = config();
  if (proxy.secret != null && !secretMatches(proxy.secret, h.get(PROXY_SECRET_HEADER))) return null;
  const id = read(proxy.headerUserId);
  if (!id) return null;

  const email = read(proxy.headerEmail);
  const name = read(proxy.headerName);
  const rolesHeader = read(proxy.headerRoles);
  const roles = rolesHeader ? rolesHeader.split(" ").filter(Boolean) : [];

  return { id, email, name, roles };
}

/**
 * Same as currentUser(), but throws a 401 Response when there is no signed-in user.
 * Intended for route handlers / server actions that require authentication.
 */
export async function requireUser(): Promise<ProxyUser> {
  const user = await currentUser();
  if (!user) {
    throw new Response("Unauthorized", { status: 401 });
  }
  return user;
}
