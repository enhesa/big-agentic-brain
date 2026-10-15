"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./LiveUpdates.module.css";

/** Every event type the bus emits (lib/events.ts) — what LiveUpdates listens for by default. */
const ALL_EVENT_TYPES = [
  "learning.created",
  "learning.updated",
  "message.created",
  "todo.changed",
  "kudos",
  "vote",
  "flag",
  "feedback.created",
  "feedback.updated",
];

const REFRESH_DEBOUNCE_MS = 300;

export interface LiveUpdatesProps {
  /**
   * Comma-separated topic prefixes to subscribe to (matches `lib/events.ts`
   * `BabEventType`s, e.g. "learnings,messages" or a full type like
   * "todo.changed"). Omit to subscribe to everything.
   */
  topics?: string;
}

/**
 * Realtime companion for the read-only web UI (docs/spec.md "Realtime").
 * Opens an SSE connection to `GET /api/events`, and on any matching event
 * calls `router.refresh()` (debounced) so the server components on the
 * current page re-render with fresh data. Renders a tiny status dot: teal
 * while connected, amber while reconnecting. Reconnection itself is native
 * `EventSource` behavior (the server sends a `retry:` hint); this component
 * just reflects readyState.
 *
 * Pauses refreshing while the tab is hidden (`document.hidden`) and does
 * one refresh on return, so a backgrounded tab doesn't burn cycles
 * re-rendering pages nobody is looking at.
 */
export default function LiveUpdates({ topics }: LiveUpdatesProps) {
  // useRouter() throws outside a mounted App Router (e.g. these pages'
  // renderToReadableStream tests, which render server components directly
  // without Next's own runtime). Real app requests always have the router
  // mounted; this guard only ever fires in that kind of test harness.
  let router: ReturnType<typeof useRouter> | null;
  try {
    router = useRouter();
  } catch {
    router = null;
  }
  const [status, setStatus] = useState<"live" | "reconnecting">("reconnecting");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const qs = topics ? `?topics=${encodeURIComponent(topics)}` : "";
    const source = new EventSource(`/api/events${qs}`);

    function scheduleRefresh() {
      if (document.hidden) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (!document.hidden) router?.refresh();
      }, REFRESH_DEBOUNCE_MS);
    }

    source.onopen = () => setStatus("live");
    source.onerror = () => setStatus("reconnecting");
    for (const type of ALL_EVENT_TYPES) source.addEventListener(type, scheduleRefresh);

    function onVisibilityChange() {
      if (!document.hidden) router?.refresh();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timerRef.current) clearTimeout(timerRef.current);
      source.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics]);

  return (
    <span className={styles.wrap} title={status === "live" ? "Live" : "Reconnecting"}>
      <span className={`${styles.dot} ${status === "live" ? styles.live : styles.reconnecting}`} />
    </span>
  );
}
