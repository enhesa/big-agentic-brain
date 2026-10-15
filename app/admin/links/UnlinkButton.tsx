"use client";

import { useState } from "react";
import styles from "@/app/components/shell/LinkActions.module.css";

/** Posts the unlink for one row, then reloads the list. */
export default function UnlinkButton({ proxyUserId }: { proxyUserId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/admin/links/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUserId }),
      });
      if (res.ok) return window.location.reload();
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not unlink.");
    } catch {
      setError("Could not reach BAB.");
    }
    setBusy(false);
  }

  return (
    <>
      <button type="button" className={styles.btn} onClick={unlink} disabled={busy}>
        Unlink
      </button>
      {error ? <span role="alert"> {error}</span> : null}
    </>
  );
}
