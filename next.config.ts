import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // No page uses next/image, so the image optimizer (and its attack surface) stays off.
  images: { unoptimized: true },
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
