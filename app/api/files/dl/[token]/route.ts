import { resolveDownloadLink, openForDownload } from "@/lib/files";
import { downloadHeaders } from "@/lib/file-download";
import { gate } from "@/lib/gate";
import { checkRateLimit, ANON_RATE_LIMIT_PER_MINUTE, ANON_GLOBAL_LIMIT_PER_MINUTE } from "@/lib/rate-limit";
import { clientIp, clientIpVerified } from "@/lib/client-ip";

export const dynamic = "force-dynamic";

/**
 * GET /api/files/dl/:token: a short-lived download link (lib/files.ts createDownloadLink). The
 * token is the credential: 256 random bits, stored only as its hash, valid for an hour and only
 * while its maker may still see the file. Anyone holding the link can fetch the file in that hour,
 * which is what a link is for. No identity is resolved. Every unknown, expired or malformed token
 * gets the same 404. Rate-limited like other anonymous calls. The token is part of the URL path, so
 * a reverse proxy or access log in front of BAB may record it (docs/files.md); BAB itself never
 * writes it to its log or an audit row. The audit row names the link's maker and the verified
 * client address, the same one the rate limit uses.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  // A public path: the gate lets it through in token mode, but its body-size cap still applies.
  const refused = gate(req);
  if (refused) return refused;
  const ip = clientIpVerified() ? clientIp(req.headers) : null;
  if (!checkRateLimit("anon-global", ANON_GLOBAL_LIMIT_PER_MINUTE) || (ip && !checkRateLimit(`anon:${ip}`, ANON_RATE_LIMIT_PER_MINUTE))) {
    return Response.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const { token } = await ctx.params;
  const link = resolveDownloadLink(token);
  if (!link) return Response.json({ error: "Not found (the link is wrong or has expired)" }, { status: 404 });
  try {
    const headers = downloadHeaders(link.file);
    return new Response(openForDownload(link.file, link.createdBy, "mcp", "link", ip), { status: 200, headers });
  } catch {
    return Response.json({ error: "Not found (the link is wrong or has expired)" }, { status: 404 });
  }
}
