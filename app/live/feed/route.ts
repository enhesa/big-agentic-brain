import { headers } from "next/headers";
import { clientIp, clientIpVerified } from "@/lib/client-ip";
import { cachedLiveBrain } from "@/lib/live-brain";
import { NO_STORE, getViewer } from "@/lib/notify-auth";
import { checkUiRateLimit, linkAddressLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /live/feed: the snapshot the Live Brain page draws, as JSON. The page asks for it every few
 * seconds and after each live event. Open to whoever may open /live, and it holds what that page
 * shows: counts, and the titles of live memories. It says nothing about who did what. It writes no
 * audit row, so an open page does not fill the log.
 *
 * A signed-in browser spends its own bucket, as the Inbox badge does. Anyone else spends the
 * anonymous bucket of their address, and only when that address is verified: a guessed address
 * could be changed at will, and one shared bucket would let a single caller lock out the rest.
 * The snapshot is cached, so an unlimited caller costs one read per LIVE_CACHE_MS at most.
 */
export async function GET() {
  const viewer = await getViewer();
  if (viewer) {
    if (!checkUiRateLimit(viewer.ownerId)) {
      return Response.json({ error: "Too many requests; wait a minute" }, { status: 429, headers: NO_STORE });
    }
  } else {
    const limited = linkAddressLimit(clientIpVerified() ? clientIp(await headers()) : null);
    if (limited) {
      limited.headers.set("Cache-Control", "no-store");
      return limited;
    }
  }
  return Response.json({ now: new Date().toISOString(), brain: cachedLiveBrain() }, { headers: NO_STORE });
}
