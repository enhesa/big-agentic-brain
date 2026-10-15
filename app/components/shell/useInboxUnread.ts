"use client";

import { useEffect, useState } from "react";
import { UNREAD_EVENT, parseUnreadResponse } from "@/lib/inbox-live-state";

const POLL_MS = 60_000;

/**
 * The unread count behind the nav's Inbox badge, and whether the Inbox is switched off
 * (BAB_INBOX_PAGE=0, which hides the nav item). One small GET /inbox/unread on mount, when
 * the tab becomes visible again and once a minute while it is; the Inbox page itself feeds
 * the count through UNREAD_EVENT so it needs no extra request. Anything unexpected (signed out,
 * unlinked, the SSO login page, offline) means no badge and never an error. This runs in a
 * client component so the switch is read per request: a statically rendered page would freeze it.
 */
export function useInboxUnread(): { count: number; off: boolean } {
  const [state, setState] = useState({ count: 0, off: false });

  useEffect(() => {
    let disposed = false;

    async function load() {
      try {
        const res = await fetch("/inbox/unread", { cache: "no-store", credentials: "same-origin" });
        const json = (res.headers.get("content-type") ?? "").includes("json") ? await res.json().catch(() => null) : null;
        const next = parseUnreadResponse(res.status, json);
        if (!disposed && next) setState(next);
      } catch {
        // offline or blocked: keep what is shown
      }
    }

    function onCount(event: Event) {
      const n = (event as CustomEvent<number>).detail;
      if (typeof n === "number") setState((s) => ({ ...s, count: n }));
    }
    function onVisible() {
      if (!document.hidden) void load();
    }

    void load();
    window.addEventListener(UNREAD_EVENT, onCount);
    document.addEventListener("visibilitychange", onVisible);
    const poll = setInterval(onVisible, POLL_MS);
    return () => {
      disposed = true;
      window.removeEventListener(UNREAD_EVENT, onCount);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(poll);
    };
  }, []);

  return state;
}
