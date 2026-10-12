"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  SAFETY_REFRESH_MS,
  UNREAD_EVENT,
  faviconDotHref,
  inboxTitle,
  isSilent,
  nextStatus,
  statusText,
  type LiveEvent,
  type LiveStatus,
} from "@/lib/inbox-live-state";
import styles from "./inbox.module.css";

const REFRESH_DEBOUNCE_MS = 300;
const WATCHDOG_MS = 10_000;

/**
 * The Inbox page's live side: keeps one viewer-scoped stream open (GET /inbox/events), and
 * turns "something changed" into a refresh of the page, the tab title ("(2) Inbox"), a dot on
 * the favicon and the app badge. Unlike LiveUpdates it never pauses while the tab is hidden:
 * a background tab is exactly where the alert is needed.
 *
 * Nothing from a message reaches this component: the stream carries a thread id and a kind,
 * and the count comes from our own /inbox/unread. If the stream is refused (signed out, too
 * many tabs) or dies, the page still refreshes every minute and on wake.
 */
export default function InboxLive({ unread, accent }: { unread: number; accent: string }) {
  // useRouter() throws outside a mounted App Router (the pages' server-render tests); real
  // requests always have it. Same guard as LiveUpdates.
  let router: ReturnType<typeof useRouter> | null;
  try {
    router = useRouter();
  } catch {
    router = null;
  }
  const routerRef = useRef(router);
  routerRef.current = router;

  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [count, setCount] = useState(unread);

  // A server refresh brings the authoritative count.
  useEffect(() => setCount(unread), [unread]);

  // Signals: title, favicon dot, app badge, and the nav badge.
  useEffect(() => {
    document.title = inboxTitle(count);
    window.dispatchEvent(new CustomEvent(UNREAD_EVENT, { detail: count }));

    // Next re-adds its own icon links after hydration and on some refreshes, so while the dot
    // is wanted any icon link that appears later is switched too.
    const dot = faviconDotHref(count, accent);
    applyIcons(dot);
    let observer: MutationObserver | null = null;
    if (dot) {
      observer = new MutationObserver(() => applyIcons(dot));
      observer.observe(document.head, { childList: true });
    }

    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    try {
      if (count > 0) void nav.setAppBadge?.(count).catch(() => {});
      else void nav.clearAppBadge?.().catch(() => {});
    } catch {
      // The app badge is only for an installed app; nothing to do without it.
    }
    return () => observer?.disconnect();
  }, [count, accent]);

  // Leaving the page puts the normal icon back (the next page sets its own title).
  useEffect(
    () => () => {
      for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) restoreIcon(link);
    },
    [],
  );

  useEffect(() => {
    let source: EventSource | null = null;
    let lastSeen = Date.now();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let everOpened = false;
    let disposed = false;

    function update(event: LiveEvent) {
      setStatus((prev) => nextStatus(prev, event));
    }

    // The count first, straight from the server and without React in the way, so the title is
    // right even in a tab the browser is throttling; then the page itself.
    async function fetchCount() {
      try {
        const res = await fetch("/inbox/unread", { cache: "no-store" });
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return;
        const body = (await res.json()) as { unread?: unknown };
        if (typeof body.unread === "number") setCount(body.unread);
      } catch {
        // offline: the next event, wake or minute tick tries again
      }
    }

    function refreshSoon(immediate = false) {
      void fetchCount();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (immediate || document.hidden) routerRef.current?.refresh();
      else refreshTimer = setTimeout(() => routerRef.current?.refresh(), REFRESH_DEBOUNCE_MS);
    }

    function connect() {
      source?.close();
      const next = new EventSource("/inbox/events");
      source = next;
      lastSeen = Date.now();
      next.onopen = () => {
        lastSeen = Date.now();
        update("open");
        // After a reconnect something may have been missed: nothing is replayed.
        if (everOpened) refreshSoon();
        everOpened = true;
      };
      const alive = () => {
        lastSeen = Date.now();
        update("message");
      };
      next.addEventListener("ping", alive);
      next.addEventListener("inbox", () => {
        alive();
        refreshSoon();
      });
      next.onerror = () => update(next.readyState === EventSource.CLOSED ? "error-closed" : "error-retrying");
    }

    connect();

    const watchdog = setInterval(() => {
      if (source && source.readyState !== EventSource.CLOSED && isSilent(lastSeen, Date.now())) {
        update("silence");
        connect();
      }
    }, WATCHDOG_MS);
    const safety = setInterval(() => refreshSoon(true), SAFETY_REFRESH_MS);

    // Wake: the tab came back, the network came back, or the laptop woke. Refresh, and try a stopped stream again.
    function onWake() {
      if (disposed || document.hidden) return;
      refreshSoon(true);
      if (source?.readyState === EventSource.CLOSED) connect();
    }
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
      clearInterval(watchdog);
      clearInterval(safety);
      if (refreshTimer) clearTimeout(refreshTimer);
      source?.close();
    };
  }, []);

  return (
    <p className={styles.live} role="status" data-status={status}>
      <span className={`${styles.liveDot} ${styles[`live_${status}`]}`} aria-hidden="true" />
      <span>{statusText(status)}</span>
    </p>
  );
}

/** Points every icon link at the dotted icon, or puts the originals back when `dot` is null. */
function applyIcons(dot: string | null) {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
    if (!dot) {
      restoreIcon(link);
      continue;
    }
    if (link.dataset.babOriginalHref === undefined) {
      link.dataset.babOriginalHref = link.getAttribute("href") ?? "";
      link.dataset.babOriginalType = link.getAttribute("type") ?? "";
    }
    if (link.getAttribute("href") !== dot) {
      link.setAttribute("href", dot);
      link.setAttribute("type", "image/svg+xml");
    }
  }
}

function restoreIcon(link: HTMLLinkElement) {
  if (link.dataset.babOriginalHref === undefined) return;
  link.setAttribute("href", link.dataset.babOriginalHref);
  if (link.dataset.babOriginalType) link.setAttribute("type", link.dataset.babOriginalType);
  else link.removeAttribute("type");
  delete link.dataset.babOriginalHref;
  delete link.dataset.babOriginalType;
}
