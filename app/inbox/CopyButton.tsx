"use client";

import { useState } from "react";
import styles from "./inbox.module.css";

/**
 * Copies a string the server already built (the fixed hand-off command). Nothing is sent
 * anywhere and nothing is read from the page: the text is the prop, so a message cannot
 * change what gets copied. `data-command` carries it in the markup for the same reason the
 * visible fallback below the button does: when the clipboard is blocked, the user can still
 * select it.
 */
export default function CopyButton({ text, label, doneLabel = "Copied" }: { text: string; label: string; doneLabel?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("failed");
    }
  }

  return (
    <button type="button" className={styles.btn} data-command={text} onClick={copy}>
      {state === "copied" ? doneLabel : state === "failed" ? "Copy failed, select the command" : label}
    </button>
  );
}
