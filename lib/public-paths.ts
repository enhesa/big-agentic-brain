/**
 * Paths reachable without an API token even when BAB_API_TOKENS is set: liveness probes, the
 * agent API's own index and the static documents an agent needs before it has a token. A fixed
 * list on purpose: configuration cannot widen it. A sign-in proxy has its own public-path list,
 * which is separate. The gate only runs for /api and /mcp, so entries outside those two never
 * reach it; they are listed for documentation.
 */
export const PUBLIC_PATHS = [
  "/healthz",
  "/readyz",
  "/api",
  // Reachable without a token so hooks never fail. In token mode the route returns nothing without a valid bearer (hookMayServe in lib/gate.ts).
  "/api/hook",
  "/instructions/",
  "/branding/",
  "/icons/",
  "/favicon.ico",
  "/sw.js",
  // browser EventSource cannot send Authorization; payload is public by design, per-IP capped
  "/api/events",
  // Short-lived file download links: the 256-bit token in the path is the credential (lib/files.ts createDownloadLink).
  "/api/files/dl/",
  // Single-use upload links: the 256-bit token in the path is the credential (lib/files.ts createUploadLink).
  "/api/files/up/",
];

/** Exact match, or prefix match for entries that end with "/". */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p));
}
