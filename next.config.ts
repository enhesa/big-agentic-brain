import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // No page uses next/image, so the image optimizer (and its attack surface) stays off.
  images: { unoptimized: true },
  // The request proxy (proxy.ts) sees /api/*, and Next cuts a body it buffers for a proxy at 10 MB by
  // default. File uploads (POST /api/files) may be up to BAB_FILES_MAX_FILE_BYTES, which config caps at
  // 50 MB; lib/gate.ts and lib/files.ts enforce the real limits.
  experimental: { proxyClientMaxBodySize: "50mb" },
  outputFileTracingIncludes: {
    "/instructions/**": ["./content/instructions/*"],
  },
  // Personal tokens are gone; the page that managed them is Your devices now.
  async redirects() {
    return [
      { source: "/me/token", destination: "/me/devices", permanent: true },
      // The usage page is open to everyone now. Temporary (307), not permanent.
      { source: "/admin/usage", destination: "/usage", permanent: false },
      // The Chats list is gone; the thread pages under /conversations stay,
      // because handoff links point at them. The Inbox page stays too, just not in the nav.
      { source: "/conversations", destination: "/inbox", permanent: false },
      // The Users page is a section of /usage now.
      { source: "/people", destination: "/usage#users", permanent: false },
      { source: "/me/token/:path*", destination: "/me/devices", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        // Clickjacking: the forms on /me/devices (Forget, Unlink) are state-changing POSTs
        // behind the viewer's SSO cookie, so no other site may frame any BAB page. Every path,
        // so no page is forgotten; /mcp and /api are JSON and do not care. Both headers: the
        // CSP one is the standard, X-Frame-Options covers older browsers.
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          // No script or style CSP on purpose: Next's inline styles and scripts would break under one.
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Must never be served from a stale cache, or the self-destruct worker would not
        // reach browsers that still hold the old notification worker.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ];
  },
};

export default nextConfig;
