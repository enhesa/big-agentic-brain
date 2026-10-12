import { accessSync, constants } from "node:fs";
import { getDb, resolveDataDir } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Readiness: the database answers and the data dir is writable. Liveness stays at /healthz.
 * The error is a short message only: no paths, no stack.
 */
export async function GET() {
  try {
    getDb().prepare("SELECT 1").get();
    accessSync(resolveDataDir(), constants.W_OK);
    return Response.json({ ok: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return Response.json({ ok: false, error: code ? `not ready (${code})` : "not ready" }, { status: 503 });
  }
}
