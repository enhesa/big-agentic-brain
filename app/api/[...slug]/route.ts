export const dynamic = "force-dynamic";

/**
 * Catch-all for unknown /api/* paths: every other API error is `{ error }` JSON, so an unknown
 * path must be too (an agent parsing the reply would otherwise get the HTML not-found page).
 * Next resolves static and dynamic segments before a catch-all, so real routes are never shadowed.
 * No identity is resolved: the answer is the same for everyone and reads nothing.
 */
function notFound(_req?: Request): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
