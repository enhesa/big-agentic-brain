import { NextRequest } from "next/server";
import { getBoardInstructions } from "@/lib/instructions";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** GET /instructions/board.md: the optional board-memory skill. Public document, no auth. */
export async function GET(req: NextRequest) {
  return new Response(getBoardInstructions(publicOrigin(req.headers)), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
  });
}
