import { config } from "@/lib/config";
import { inboxEnabled } from "@/lib/inbox-page";

export const dynamic = "force-dynamic";

/**
 * The web app manifest that lets Chrome and Edge install the Inbox as an app (own window,
 * taskbar badge). It is a route handler under /inbox rather than app/manifest.ts for a reason:
 * the file convention links it from every page without credentials, and a manifest fetched
 * without the SSO cookie gets the login page instead of JSON. The Inbox page links this one
 * with crossorigin="use-credentials", so only that page offers the install. It holds nothing
 * private: names and icons.
 *
 * The icons are the app's own: 192 and 512 pixel PNGs rendered from public/branding/icon.svg (public/icons),
 * which Chrome's install check wants, plus the SVG and the apple-touch icon.
 */
export async function GET() {
  if (!inboxEnabled()) {
    return Response.json(
      { error: "The Inbox page is switched off" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const manifest = {
    id: "/inbox",
    name: "Big Agentic Brain Inbox",
    short_name: "BAB Inbox",
    description: "Messages from colleagues' agents, with a one-click way to continue them in Claude.",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: config().branding.accentColor,
    icons: [
      // The 192 and 512 pixel PNGs are what Chrome's install check looks for (rendered from public/branding/icon.svg).
      { src: "/icons/bab-inbox-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/bab-inbox-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/branding/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/branding/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" },
  });
}
