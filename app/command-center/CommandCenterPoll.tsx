"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 15_000;

/**
 * Keeps the open Command Center page current: every 15 seconds, while the tab is visible, it asks
 * /command-center/state for the stamp and refreshes the server-rendered page when it changed.
 * Not SSE: /api/events is public, and even an id-only event would leak one person's activity.
 */
export default function CommandCenterPoll({ stamp }: { stamp: string }) {
  // useRouter() throws outside a mounted App Router (page render tests); real requests have one.
  let router: ReturnType<typeof useRouter> | null;
  try {
    router = useRouter();
  } catch {
    router = null;
  }

  useEffect(() => {
    let stopped = false;
    async function check() {
      if (stopped || document.hidden) return;
      try {
        const res = await fetch("/command-center/state", { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) return;
        const body = (await res.json()) as { stamp?: unknown };
        if (typeof body.stamp === "string" && body.stamp !== stamp) router?.refresh();
      } catch {
        // Offline or signed out: try again at the next tick.
      }
    }
    const timer = setInterval(check, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  return null;
}
