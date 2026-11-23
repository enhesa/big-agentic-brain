import { headers } from "next/headers";
import { clientIp, clientIpVerified } from "@/lib/client-ip";
import { REPLAY_LIMIT_PER_MINUTE, REPLAY_UNKNOWN_LIMIT_PER_MINUTE, cachedBrainReplayJson } from "@/lib/live-replay";
import { NO_STORE, getViewer } from "@/lib/notify-auth";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /live/replay: the whole history of the brain as plain numbers, for the Replay on the Live
 * Brain page. Open to whoever may open /live. It holds no person, no id, no title and no text
 * (lib/live-replay.ts). It writes no audit row, like /live/feed: the page view is already there.
 *
 * The answer can be several megabytes, so it has limits of its own, and every caller meets one.
 * A signed-in browser and a verified address each get REPLAY_LIMIT_PER_MINUTE: the page asks once
 * a press. Callers with no verified address share one bucket of REPLAY_UNKNOWN_LIMIT_PER_MINUTE.
 * One of them can spend it for the others, and then the replay, a thing for the joy of it, waits
 * a minute. The answer is read and written as text once per REPLAY_CACHE_MS, so a caller inside
 * the limits costs the bytes and nothing else.
 */
export async function GET() {
  const viewer = await getViewer();
  const address = viewer || !clientIpVerified() ? null : clientIp(await headers());
  const allowed = viewer
    ? checkRateLimit(`live-replay:viewer:${viewer.ownerId}`, REPLAY_LIMIT_PER_MINUTE)
    : address
      ? checkRateLimit(`live-replay:address:${address}`, REPLAY_LIMIT_PER_MINUTE)
      : checkRateLimit("live-replay:unknown", REPLAY_UNKNOWN_LIMIT_PER_MINUTE);
  if (!allowed) {
    return Response.json({ error: "Too many requests; wait a minute" }, { status: 429, headers: NO_STORE });
  }
  return new Response(cachedBrainReplayJson(), { headers: { ...NO_STORE, "Content-Type": "application/json" } });
}
