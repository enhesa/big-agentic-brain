import { ForbiddenError } from "./errors";

/** The identity of a caller, as far as the file store and the key-value store need it (lib/session.ts SessionUser). */
export interface BoundCaller {
  source: "proxy" | "declared" | "device" | "connection";
  tokenBound?: true;
}

/**
 * Refuses a caller whose identity is only their own word in this request: X-Bab-Actor-* headers
 * or an MCP connection. Those can name anyone, so they must not reach a store that keeps a person's
 * own data. Allowed: a bound device, the sign-in proxy, a token bound to the person. `allowDeclared`
 * (a setting for local development) lifts it. `what` names the store in the refusal.
 */
export function assertBoundIdentity(caller: BoundCaller, allowDeclared: boolean, what: string): void {
  if (caller.source === "proxy" || caller.source === "device" || caller.tokenBound) return;
  if (allowDeclared) return;
  throw new ForbiddenError(
    `${what} needs an identity BAB remembers or checks: the BAB plugin's device, the sign-in proxy, or an API token bound to you. ` +
      "An identity sent only in headers, or said with bab_identify on a connection with no device, is refused. " +
      (caller.source === "connection"
        ? "BAB knows you on this connection but not this machine's device yet: call bab_identify once with the user's own work email (it links the device the BAB plugin sends), then retry."
        : "Install the BAB plugin and call bab_identify once with the user's own work email, or ask a BAB maintainer for a token bound to you."),
  );
}
