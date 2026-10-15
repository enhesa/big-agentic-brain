// Shared helpers for the e2e suite: real HTTP against the standalone server
// booted by global-setup.ts.
export function origin(): string {
  const o = process.env.BAB_E2E_ORIGIN;
  if (!o) throw new Error("BAB_E2E_ORIGIN not set — did global setup run?");
  return o;
}

export const ALICE = { email: "alice.example@example.com", name: "Alice Example" };
export const BOB = { email: "bob.example@example.com", name: "Bob Example" };
export const CARL = { email: "carl.example@example.com", name: "Carl Example" };

export function actorHeaders(actor: { email: string; name: string }): Record<string, string> {
  return { "X-Bab-Actor-Email": actor.email, "X-Bab-Actor-Name": actor.name };
}

export async function api(
  path: string,
  opts: {
    method?: string;
    actor?: { email: string; name: string };
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.actor) Object.assign(headers, actorHeaders(opts.actor));
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${origin()}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export function uniqueTitle(prefix: string): string {
  return `${prefix} ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
}

/** Letters-only random suffix, since the long-form email pattern (lib/identity.ts) requires
 * each dot-separated local-part segment to be [a-z]+ — no digits allowed. */
function alphaSuffix(len = 8): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < len; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

/** A fresh, valid long-form identity: "prefix.<random letters>@example.com". */
export function uniqueActor(prefix: string): { email: string; name: string } {
  const local = prefix.toLowerCase().replace(/[^a-z]+/g, "");
  return {
    email: `${local}.${alphaSuffix()}@example.com`,
    name: `${prefix} Test`,
  };
}

/**
 * A user row only exists after that identity's own first request
 * (lib/session.ts upsertUser on getSessionUser()). send() looks up the
 * recipient and 400s "Unknown recipient" otherwise, so any freshly
 * generated actor that will be used as a message `to` target must be
 * registered first.
 */
export async function registerActor(actor: { email: string; name: string }): Promise<void> {
  await api("/api/me", { actor });
}
