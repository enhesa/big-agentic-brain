"use client";

import { useState } from "react";
import styles from "@/app/components/shell/LinkActions.module.css";

/** Posts the revoke for one device, then reloads the list. */
export default function RevokeDeviceButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/admin/links/devices/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) return window.location.reload();
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not revoke.");
    } catch {
      setError("Could not reach BAB.");
    }
    setBusy(false);
  }

  return (
    <>
      <button type="button" className={styles.btn} onClick={revoke} disabled={busy}>
        Revoke
      </button>
      {error ? <span role="alert"> {error}</span> : null}
    </>
  );
}
