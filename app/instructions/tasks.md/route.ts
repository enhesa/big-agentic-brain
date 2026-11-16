import { NextRequest } from "next/server";
import { getTasksInstructions } from "@/lib/instructions";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** GET /instructions/tasks.md: the optional bab-tasks skill. Public document, no auth. */
export async function GET(req: NextRequest) {
  return new Response(getTasksInstructions(publicOrigin(req.headers)), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
  });
}
