import { NextResponse } from "next/server";
import { gate } from "@/lib/gate";

/** Next 16 request proxy (formerly middleware), Node runtime: the logic lives in lib/gate.ts. */
export default function proxy(req: Request) {
  return gate(req) ?? NextResponse.next();
}

export const config = { matcher: ["/api/:path*", "/mcp"] };
