import { getInstructions } from "@/lib/instructions";

export const dynamic = "force-dynamic";

const buildTime = new Date().toISOString();

/** GET /instructions/version — content-addressed version of the instruction docs. Public document, no auth. */
export async function GET() {
  const { version } = getInstructions("https://placeholder.invalid");

  return Response.json(
    { version, updatedAt: buildTime },
    { headers: { "Cache-Control": "no-store" } }
  );
}
