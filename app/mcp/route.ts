import { headers } from "next/headers";
import { requireActorForApi, deviceState, connectionState, type SessionUser } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { LEAN_TOOL_NAMES, mcpInstructions, findTool, toolsFor, type McpToolset } from "@/lib/mcp";
import { config } from "@/lib/config";
import { publicOrigin } from "@/lib/origin";
import { clientIp, clientIpVerified } from "@/lib/client-ip";
import { checkRateLimit, ANON_RATE_LIMIT_PER_MINUTE, ANON_GLOBAL_LIMIT_PER_MINUTE } from "@/lib/rate-limit";
import { deviceLabelFrom, devicesEnabled } from "@/lib/devices";
import { DEVICE_ERROR_RE, identify, identifyRequiredText } from "@/lib/identify";
import { identityHint } from "@/lib/identity";
import { callerKey } from "@/lib/caller-key";
import { createConnection } from "@/lib/mcp-connections";
import { isTokenBoundEmail, tokenBoundMessage, tokenIdentityFor } from "@/lib/gate";

export const dynamic = "force-dynamic";

// Deliberately no GET or DELETE handler here: this transport has no server-initiated
// messages (see the POST doc comment below), so there's no SSE stream to open with GET
// and no session to tear down with DELETE. A 405 on either is the intended response, not
// a missing feature.

/**
 * POST /mcp — a hand-rolled JSON-RPC 2.0 endpoint speaking MCP's Streamable
 * HTTP transport, one plain response per POST. No SSE stream: nothing here
 * is server-initiated (the plugin delivery design "The
 * skill shrinks"), so a bare JSON-RPC response is the whole transport this
 * needs — the three runtime dependencies in package.json stay three.
 *
 * Identity is an honour system: the deployment must sit on a private network,
 * behind an authenticating proxy, or use bound tokens. Who a request
 * is, in order: a known device secret (X-Bab-Device), a known connection (the Mcp-Session-Id
 * issued on initialize), the X-Bab-Actor-* headers. A caller that is none of those still
 * connects, lists tools and acks notifications (a server that fails to connect never loads its
 * tools); every tool call except bab_identify answers with one fixed text telling it to call
 * bab_identify. bab_identify names the person and BAB remembers it on the device, else the
 * connection, else for the one call (lib/identify.ts).
 */

interface JsonRpcBody {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown, extraHeaders?: Record<string, string>): Response {
  if (!extraHeaders) return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

// Near-fixed on purpose: it satisfies both identity-failure test cases (a short-alias
// address, and headers that are present but invalid) without the route needing to
// distinguish *why* requireActorForApi() refused — the underlying Response already carries
// the specific reason to a human reading logs; the agent only needs to be told what to
// send instead.
function identityErrorMessage(): string {
  return `Identity rejected: set both X-Bab-Actor-Email (${identityHint()}) and X-Bab-Actor-Name, or neither and call bab_identify.`;
}

/** Anonymous callers hitting their per-address limit are logged at most once a minute, whoever they are. */
let lastAnonLimitLogAt = 0;
function noteAnonymousLimit(ip: string | null): void {
  const now = Date.now();
  if (now - lastAnonLimitLogAt < 60_000) return;
  lastAnonLimitLogAt = now;
  console.warn(`bab: anonymous /mcp rate limit hit for ${ip ?? "an unknown address"} (logged once a minute)`);
}

// Distinct from -32001: a rate-limited caller has a fine identity and must
// back off and retry, not resend different headers. Conflating the two (as
// mapping every thrown Response to -32001 did) sends it into a retry loop
// with the same headers forever.
const RATE_LIMIT_ERROR_CODE = -32029;

/** The audit `path` for a request: distinguishes tools/call by which tool, same as each app/api/**\/route.ts uses its own literal path. */
function auditPath(method: string | undefined, params: unknown): string {
  if (method === "tools/call") {
    const name = (params as { name?: unknown } | null)?.name;
    return `/mcp#tools/call:${typeof name === "string" && name ? name : "unknown"}`;
  }
  return `/mcp#${method ?? "unknown"}`;
}

/**
 * A bab_learn call carries which device or connection made it (`cx`), so /admin/usage can count
 * distinct sessions. Only that tool: every other row stays as small as it was.
 */
function learnCallerDetails(
  method: string | undefined,
  params: unknown,
  deviceId: string | null,
  connectionId: string | null,
): { cx: string } | undefined {
  if (method !== "tools/call" || (params as { name?: unknown } | null)?.name !== "bab_learn") return undefined;
  const cx = callerKey(deviceId, connectionId);
  return cx ? { cx } : undefined;
}

/** A bab_inbox tools/call with no threadId: the list, not a thread open. */
function isInboxList(method: string | undefined, params: unknown): boolean {
  if (method !== "tools/call") return false;
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (p.name !== "bab_inbox") return false;
  const args = (p.arguments ?? {}) as { threadId?: unknown };
  const threadId = args.threadId == null ? "" : String(args.threadId).trim();
  return threadId === "";
}

export async function POST(req: Request): Promise<Response> {
  let body: JsonRpcBody;
  try {
    body = (await req.json()) as JsonRpcBody;
  } catch {
    return rpcError(null, -32700, "Parse error: body must be JSON");
  }
  // `null`/a bare string/a number/an array each parse fine as JSON but aren't a JSON-RPC
  // request object: without this guard, `body.params` below (a plain property read, not
  // optional-chained) throws on a `null` body and Next.js turns that into a 500 — the
  // same class of bug Task 3 fixed for POST /api/hook's session_id. The id can't be
  // determined from a non-object body, so this always answers with id: null, same as a
  // parse error.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return rpcError(null, -32600, "Invalid Request: body must be a JSON object");
  }
  const id = body?.id ?? null;
  const method = body?.method;

  // The tool list is chosen per connection by ?tools=lean or ?tools=full on the MCP URL;
  // without it BAB_MCP_TOOLS decides (default full). An unknown value is refused, not guessed.
  const rawTools = new URL(req.url).searchParams.get("tools");
  const toolsParam = rawTools === null ? null : rawTools.trim().toLowerCase();
  if (toolsParam !== null && toolsParam !== "lean" && toolsParam !== "full") {
    return rpcError(id, -32602, `Unknown tools value "${(rawTools ?? "").slice(0, 20)}": use ?tools=lean or ?tools=full.`);
  }
  const toolset: McpToolset = toolsParam ?? config().mcpTools;

  const h = await headers();
  const origin = publicOrigin(h);
  const ip = clientIp(h);
  const device = await deviceState();
  const connection = await connectionState();

  // Every method needs a resolved actor first, same as every other agent API
  // route — this is what inherits rate limiting and the maintenance sweep
  // (see lib/session.ts's requireActorForApi()), not reimplemented here.
  //
  // Exception, so a connection that has no identity yet still loads its tools: no actor, and
  // either no X-Bab-Actor-* at all or a device or session id the caller sent. Only tools/call is
  // answered differently, below. Invalid actor headers on their own are still -32001.
  let actor: SessionUser | null = null;
  let anonymous = false;
  try {
    actor = await requireActorForApi();
  } catch (e) {
    if (!(e instanceof Response)) throw e;
    if (e.status === 429) {
      const message = await e
        .json()
        .then((b) => (typeof b?.error === "string" ? b.error : "Rate limit exceeded"))
        .catch(() => "Rate limit exceeded");
      return rpcError(id, RATE_LIMIT_ERROR_CODE, message);
    }
    const sentActorHeaders = !!(h.get("x-bab-actor-email") || h.get("x-bab-actor-name"));
    if (sentActorHeaders && !device && !connection) {
      const claimed = h.get("x-bab-actor-email") ?? "";
      return rpcError(id, -32001, isTokenBoundEmail(claimed) ? tokenBoundMessage(claimed) : identityErrorMessage());
    }
    anonymous = true;
  }

  // Nobody is identified, so the usual per-identity limit has nothing to key on: limit by
  // address. Anonymous callers are cheap to make.
  // A caller-controlled address header proves nothing, so the per-address key is used only when the
  // address is verified (BAB_CLIENT_IP_HEADER). Otherwise key on the MCP session id, and with neither
  // skip the per-caller limit: one shared bucket would let one client lock out everyone.
  const verifiedIp = clientIpVerified() ? ip : null;
  const sessionId = h.get("mcp-session-id");
  const anonKey = verifiedIp ? `anon:${verifiedIp}` : sessionId ? `anon-session:${sessionId}` : null;
  // The process-wide anonymous bucket applies whenever there is no verified address (a rotating
  // Mcp-Session-Id is free), so anonymous traffic is always bounded.
  if (anonymous && !verifiedIp && !checkRateLimit("anon-global", ANON_GLOBAL_LIMIT_PER_MINUTE)) {
    noteAnonymousLimit(ip);
    return rpcError(id, RATE_LIMIT_ERROR_CODE, `Rate limit exceeded: ${ANON_GLOBAL_LIMIT_PER_MINUTE} anonymous requests/minute`);
  }
  if (anonymous && anonKey && !checkRateLimit(anonKey, ANON_RATE_LIMIT_PER_MINUTE)) {
    noteAnonymousLimit(ip);
    return rpcError(id, RATE_LIMIT_ERROR_CODE, `Rate limit exceeded: ${ANON_RATE_LIMIT_PER_MINUTE} requests/minute per address`);
  }

  // Every REST handler writes one audit_log "request" row via this same
  // helper; MCP reads (bab_search, bab_inbox, bab_people) would otherwise
  // leave no trace at all now that MCP is the primary surface. Anonymous
  // initialize, tools/list and notifications are not audited: any caller can make them in
  // bulk, and they say nothing. Anonymous tool calls are.
  const deviceError = h.get("x-bab-device-error");
  if (!anonymous || method === "tools/call") {
    await auditRequest({
      actor,
      method: "POST",
      path: auditPath(method, body.params),
      via: "mcp",
      details: anonymous
        ? { anonymous: "unknown", ...(deviceError && DEVICE_ERROR_RE.test(deviceError) ? { deviceError } : {}) }
        : learnCallerDetails(method, body.params, device?.device?.id ?? null, connection?.id ?? null),
      // An inbox LIST (no threadId) is polled every 15 seconds per open session: audited once per
      // 5 minutes per identity. Opening a thread and every other tool stay audited every time.
      coalesce: actor && isInboxList(method, body.params) ? { minutes: 5 } : undefined,
    });
  }

  switch (method) {
    case "initialize": {
      // The MCP session id: a known one the client sends is kept (it keeps what it said it was);
      // otherwise a new one is minted, WITHOUT a row (the row appears when the client calls
      // bab_identify). None at all when BAB_DEVICES=0, since nothing could be remembered on it.
      const sessionId = !devicesEnabled() ? null : connection?.known ? connection.id : createConnection();
      return rpcResult(
        id,
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "bab", version: "1" },
          instructions: mcpInstructions(origin, toolset),
        },
        sessionId ? { "Mcp-Session-Id": sessionId } : undefined,
      );
    }

    case "notifications/initialized":
      // A notification per JSON-RPC: no response body, only an ack.
      return new Response(null, { status: 202 });

    case "tools/list":
      return rpcResult(id, {
        tools: toolsFor(toolset).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case "tools/call": {
      const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown };
      const toolName = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments ?? {}) as Record<string, unknown>;

      // The one tool a caller BAB does not know can call. It also works for a caller that is
      // known, to say who they are instead (the honour system).
      if (toolName === "bab_identify") {
        try {
          const result = identify(args, {
            deviceHash: device?.hash ?? null,
            deviceLabel: deviceLabelFrom(h),
            connectionId: connection?.id ?? null,
            ip,
            tokenEmail: tokenIdentityFor(h),
          });
          return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (err) {
          if (err instanceof Error) return rpcResult(id, { content: [{ type: "text", text: err.message }], isError: true });
          throw err;
        }
      }

      if (!actor) {
        // Fixed server text, never colleague content.
        return rpcResult(id, { content: [{ type: "text", text: identifyRequiredText(deviceError) }], isError: false });
      }
      const tool = findTool(toolName);
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      if (toolset === "lean" && !LEAN_TOOL_NAMES.includes(toolName)) {
        return rpcResult(id, {
          content: [{ type: "text", text: `${toolName} is not in the lean tool list. Connect to ${origin}/mcp?tools=full (the full URL) to use it.` }],
          isError: true,
        });
      }
      try {
        const text = tool.run(actor, args, { origin });
        return rpcResult(id, { content: [{ type: "text", text }] });
      } catch (err) {
        // A business refusal is a tool-level failure, not a broken request:
        // MCP reports it inside the result with isError so the agent sees it
        // like any other tool response, the same way toApiError() (lib/errors.ts)
        // maps any Error to a clean 400 for REST. This deliberately catches
        // Error broadly, not just ApiError: lib/redact.ts's assertMaxLength/
        // assertSize throw plain Errors on an over-length field (title, body,
        // note, ...), and those are routine input, not a crash. A non-Error
        // throw is left to propagate as an actual protocol/server failure.
        if (err instanceof Error) {
          return rpcResult(id, { content: [{ type: "text", text: err.message }], isError: true });
        }
        throw err;
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
