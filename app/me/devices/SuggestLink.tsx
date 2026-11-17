"use client";

import { useState } from "react";
import styles from "@/app/components/shell/LinkActions.module.css";

/**
 * The "Are you X? Yes, that's me" choice for an unlinked viewer, inside the link card
 * (app/components/LinkBrowserNotice.tsx) on every page that shows it. On success it reloads the
 * page the viewer is on. The server recomputes the suggestion on claim, so `email` here only
 * says which suggestion the viewer agreed to. It needs client JS; the typed form beside it does not.
 */
export default function SuggestLink({ email, name }: { email: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function yes() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/notify/identity/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) return window.location.reload();
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not link this browser.");
    } catch {
      setError("Could not reach BAB. Try again.");
    }
    setBusy(false);
  }

  return (
    <div role="group" aria-label="Link this browser">
      <p>
        Are you {name} ({email})?
      </p>
      <button type="button" className={styles.primary} onClick={yes} disabled={busy}>
        Yes, that&apos;s me
      </button>
      {error ? (
        <p className={styles.panelError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
