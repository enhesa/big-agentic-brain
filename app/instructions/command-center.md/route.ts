import { NextRequest } from "next/server";
import { getCommandCenterInstructions } from "@/lib/instructions";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** GET /instructions/command-center.md: the optional command-center skill. Public document, no auth. */
export async function GET(req: NextRequest) {
  return new Response(getCommandCenterInstructions(publicOrigin(req.headers)), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
  });
}
