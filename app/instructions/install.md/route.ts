import { NextRequest } from "next/server";
import { getInstructions } from "@/lib/instructions";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** GET /instructions/install.md — self-installer prompt for Claude Code. Public document, no auth. */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req.headers);
  const { install } = getInstructions(origin);

  return new Response(install, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
