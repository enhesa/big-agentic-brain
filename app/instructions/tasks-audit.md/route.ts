import { NextRequest } from "next/server";
import { getTasksAuditInstructions } from "@/lib/instructions";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** GET /instructions/tasks-audit.md: the optional bab-tasks-audit skill. Public document, no auth. */
export async function GET(req: NextRequest) {
  return new Response(getTasksAuditInstructions(publicOrigin(req.headers)), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store" },
  });
}
