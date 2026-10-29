import { consumeUploadLink, putFile } from "@/lib/files";
import { gate } from "@/lib/gate";
import { audit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { toApiError } from "@/lib/errors";
import { publicOrigin } from "@/lib/origin";
import { checkRateLimit, ANON_RATE_LIMIT_PER_MINUTE, ANON_GLOBAL_LIMIT_PER_MINUTE } from "@/lib/rate-limit";
import { clientIp, clientIpVerified } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

const NOT_FOUND = "Not found (the upload link is wrong, expired or already used: make a new one with bab_files action=upload_link)";

/**
 * POST /api/files/up/:token: the file's raw bytes, sent to a single-use upload link (lib/files.ts
 * createUploadLink): curl -X POST --data-binary @file "<url>". The token is the credential: 256 random
 * bits, stored only as its hash, valid for 15 minutes and for one upload. Everything about the file was
 * fixed when the link was made; query parameters here are ignored. The link is spent before the body is
 * read, so a refused upload (too big, quota, executable, secret) needs a new link. Outside the proxy
 * matcher (proxy.ts) so Next never buffers the body; the gate runs here. Every upload check of
 * putFile applies. The token is part of the URL path, so a reverse proxy in front of BAB may log it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const refused = gate(req);
  if (refused) return refused;
  const ip = clientIpVerified() ? clientIp(req.headers) : null;
  if (!checkRateLimit("anon-global", ANON_GLOBAL_LIMIT_PER_MINUTE) || (ip && !checkRateLimit(`anon:${ip}`, ANON_RATE_LIMIT_PER_MINUTE))) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const { token } = await ctx.params;
  const link = consumeUploadLink(token);
  if (!link) return Response.json({ error: NOT_FOUND }, { status: 404 });
  audit(getDb(), link.ownerId, "file_upload_link_used", "file", "-", "mcp", { ip, details: { name: link.name } });
  const length = req.headers.get("content-length");
  try {
    const result = await putFile(
      { ...link, body: req.body, declaredSize: length == null ? null : Number(length), ip },
      "mcp",
      publicOrigin(req.headers),
    );
    return Response.json(result, { status: 201 });
  } catch (err) {
    const { status, body } = toApiError(err);
    return Response.json(body, { status });
  }
}
