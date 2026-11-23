import { headers } from "next/headers";
import { clientIp } from "@/lib/client-ip";
import { cachedLiveBrain } from "@/lib/live-brain";
import { NO_STORE } from "@/lib/notify-auth";
import { checkUiRateLimit } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * GET /live/feed: the snapshot the Live Brain page draws, as JSON. The page asks for it every few
 * seconds and after each live event. Open to whoever may open /live, and it holds what that page
 * shows: counts, anonymous dots, and the titles of live memories. It writes no audit row, so an
 * open page does not fill the log.
 */
export async function GET() {
  const actor = await getSessionUser();
  const bucket = actor?.id ?? `live:${clientIp(await headers()) ?? "unknown"}`;
  if (!checkUiRateLimit(bucket)) {
    return Response.json({ error: "Too many requests; wait a minute" }, { status: 429, headers: NO_STORE });
  }
  return Response.json({ now: new Date().toISOString(), brain: cachedLiveBrain() }, { headers: NO_STORE });
}
