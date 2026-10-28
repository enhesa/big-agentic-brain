import { NextResponse } from "next/server";
import { gate } from "@/lib/gate";

/** Next 16 request proxy (formerly middleware), Node runtime: the logic lives in lib/gate.ts. */
export default function proxy(req: Request) {
  return gate(req) ?? NextResponse.next();
}

/**
 * Every /api path and /mcp, except /api/files itself: for a path the proxy matches, Next copies the
 * whole request body into memory before the route runs (10 MB by default, cut silently past that).
 * A file upload must stream to disk instead, so app/api/files/route.ts calls gate() itself.
 */
export const config = { matcher: ["/api", "/api/((?!files$).*)", "/mcp"] };
