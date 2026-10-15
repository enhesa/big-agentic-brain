"use client";

import { useState } from "react";
import styles from "@/app/components/shell/LinkActions.module.css";

/**
 * The "Are you X? Yes, that's me" choice for an unlinked viewer on /me/devices (the only page
 * that links a browser by hand now; /reminders just points here). The server recomputes the
 * suggestion on claim, so `email` here only says which suggestion the viewer agreed to.
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
