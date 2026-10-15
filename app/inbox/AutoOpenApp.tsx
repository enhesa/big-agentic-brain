"use client";

import { useEffect, useRef } from "react";
import styles from "./inbox.module.css";

// The only place BAB navigates on its own. Re-checked here, not just on the server, so a future
// caller cannot point this at anything but the Claude app's new-session link.
const APP_LINK_PREFIX = "claude://code/new?q=";

/**
 * Starts a new Claude desktop session by opening the app deep link once on mount. The Inbox renders
 * this only for `?open=app` and a participant of the thread. The link pre-fills BAB's fixed
 * prompt and never sends it, so nothing happens until the person presses Enter in Claude.
 */
export default function AutoOpenApp({ url }: { url: string }) {
  // StrictMode runs effects twice in development; a second navigation would open a second session.
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current || !url.startsWith(APP_LINK_PREFIX)) return;
    opened.current = true;
    // Drop open=app from the address first, so a reload or a back navigation does not open yet
    // another Claude session.
    try {
      const here = new URL(window.location.href);
      here.searchParams.delete("open");
      window.history.replaceState(window.history.state, "", here.pathname + here.search + here.hash);
    } catch {
      // A browser without the History API just keeps the parameter.
    }
    window.location.href = url;
  }, [url]);

  return (
    <p className={styles.note} role="status">
      Opening Claude… If nothing happens, use Continue in Claude app below.
    </p>
  );
}
