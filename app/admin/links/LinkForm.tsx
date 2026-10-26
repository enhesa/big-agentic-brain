"use client";

import { useState } from "react";
import styles from "@/app/components/shell/LinkActions.module.css";

/** Links one refused sign-in user's browser to the address typed here, then reloads the list. */
export default function LinkForm({ proxyUserId, typed }: { proxyUserId: string; typed: string | null }) {
  const [email, setEmail] = useState(typed ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/admin/links/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUserId, email }),
      });
      if (res.ok) return window.location.reload();
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not link.");
    } catch {
      setError("Could not reach BAB.");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={link}>
      <input
        type="email"
        aria-label={`Long address for ${proxyUserId}`}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />{" "}
      <button type="submit" className={styles.btn} disabled={busy}>
        Link
      </button>
      {error ? <span role="alert"> {error}</span> : null}
    </form>
  );
}
