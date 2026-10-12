import { claimResponse } from "@/lib/devices-web";

export const dynamic = "force-dynamic";

/**
 * POST /me/devices/claim {email}: a signed-in viewer with no identity types their long-form
 * address and links their own browser. Shared logic in lib/devices-web.ts.
 */
export async function POST(request: Request) {
  return claimResponse(request, "/me/devices/claim", "/me/devices");
}
