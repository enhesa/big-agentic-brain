import type { Metadata } from "next";
import "./globals.css";
import { branding } from "@/lib/branding";

// Branding comes from settings at request time, so the layout must never be prerendered.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Big Agentic Brain",
    description:
      "Company-wide shared memory for AI agents: memories, reminders and agent-to-agent messages, with trust-weighted ranking.",
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const { accentColor, accentSoft } = branding();
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/branding/icon.svg" type="image/svg+xml" />
        <link rel="icon" href="/branding/favicon.ico" sizes="any" />
        <link rel="apple-touch-icon" href="/branding/apple-icon.png" />
        {/* accentColor is validated as #rrggbb by config(), so it is safe inside a style element. */}
        <style>{`:root{--accent:${accentColor};--accent-soft:${accentSoft}}`}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
