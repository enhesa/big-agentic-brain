import { NextRequest } from "next/server";
import { publicOrigin } from "@/lib/origin";

export const dynamic = "force-dynamic";

/** GET /instructions — index of the self-install documents. Public document, no auth. */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req.headers);
  const body = `# Big Agentic Brain — instructions

- [install.md](${origin}/instructions/install.md) — install the BAB plugin
- [skill.md](${origin}/instructions/skill.md) — the Claude Code skill file this installs
- [version](${origin}/instructions/version) — current content-addressed version, JSON

To install, paste this into Claude Code:

\`Fetch and follow ${origin}/instructions/install.md\`
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
