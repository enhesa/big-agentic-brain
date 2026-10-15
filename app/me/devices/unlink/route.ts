import { unlinkOwnResponse } from "@/lib/unlink-own-web";

export const dynamic = "force-dynamic";

/**
 * POST /me/devices/unlink: a signed-in viewer unlinks their own browser. Devices connected
 * through this browser are revoked with the link (lib/forge-links.ts). Shared logic, own
 * redirect.
 */
export async function POST(request: Request) {
  return unlinkOwnResponse(request, "/me/devices/unlink", "/me/devices");
}
