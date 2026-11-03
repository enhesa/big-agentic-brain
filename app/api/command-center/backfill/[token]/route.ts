import { gate } from "@/lib/gate";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { config } from "@/lib/config";
import { publicOrigin } from "@/lib/origin";
import { CC_BACKFILL_MAX_BYTES, ccApiError, ccBackfill, consumeBackfillLink } from "@/lib/command-center";
import { checkRateLimit, ANON_RATE_LIMIT_PER_MINUTE, ANON_GLOBAL_LIMIT_PER_MINUTE } from "@/lib/rate-limit";
import { clientIp, clientIpVerified } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

const NOT_FOUND = "Not found (the backfill link is wrong, expired or already used: make a new one with bab_command_center action=backfill_link)";
const TOO_LARGE = `request body too large: at most ${CC_BACKFILL_MAX_BYTES} bytes per backfill upload; split it and use a new link for the rest`;

/** Reads the body up to `max` bytes; null when it is longer (the read stops there). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * POST /api/command-center/backfill/:token: one upload of historic worked lines from the person's
 * local backfill tool, to a single-use link from bab_command_center action=backfill_link. The token
 * is the credential: 256 random bits, stored only as its hash, valid for 15 minutes and for one
 * upload. The owner was fixed when the link was made; nothing in the request names a person. A
 * declared Content-Length over the cap is refused before the link is spent; after that the link is
 * spent before the body is read, so any later refusal needs a new link. The token is part of the
 * URL path, so a reverse proxy in front of BAB may log it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const refused = gate(req);
  if (refused) return refused;
  const ip = clientIpVerified() ? clientIp(req.headers) : null;
  if (!checkRateLimit("anon-global", ANON_GLOBAL_LIMIT_PER_MINUTE) || (ip && !checkRateLimit(`anon:${ip}`, ANON_RATE_LIMIT_PER_MINUTE))) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  if (!config().commandCenter) return Response.json({ error: "Command Center is switched off on this BAB" }, { status: 404 });
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CC_BACKFILL_MAX_BYTES) return Response.json({ error: TOO_LARGE }, { status: 413 });
  const { token } = await ctx.params;
  const now = Date.now();
  const link = consumeBackfillLink(token, now);
  if (!link) return Response.json({ error: NOT_FOUND }, { status: 404 });
  // Written before the body is read, so a spent link whose upload then fails is still visible.
  audit(getDb(), link.ownerId, "cc_backfill_link_used", "command_center", "-", "mcp", { ip });
  const raw = await readCapped(req, CC_BACKFILL_MAX_BYTES).catch(() => "");
  if (raw === null) return Response.json({ error: TOO_LARGE }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'Body must be JSON: { "v": 1, "entries": [...] }' }, { status: 400 });
  }
  try {
    return Response.json(ccBackfill(link.ownerId, body, "mcp", publicOrigin(req.headers), now), { status: 200 });
  } catch (err) {
    const { status, body: answer } = ccApiError(err);
    return Response.json(answer, { status });
  }
}
