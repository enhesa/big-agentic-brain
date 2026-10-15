import { NextRequest } from "next/server";
import { getInstructions } from "@/lib/instructions";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** GET /instructions/skill.md — the Big Agentic Brain Claude Code skill file. Public document, no auth. */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req.headers);
  const { skill } = getInstructions(origin);

  return new Response(skill, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
