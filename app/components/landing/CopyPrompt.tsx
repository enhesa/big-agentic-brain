"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../../landing.module.css";

/**
 * Renders the install prompt and a copy button.
 * When the clipboard is unavailable (insecure origin, older browser, denied
 * permission) it selects the prompt text instead so it can still be copied.
 */
export default function CopyPrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const selectPrompt = useCallback(() => {
    const el = textRef.current;
    if (!el || typeof window === "undefined") return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  const onCopy = useCallback(async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      selectPrompt();
    }
  }, [selectPrompt, text]);

  /* Same 4px lean toward the cursor as the hero button. Decorative. */
  const onMove = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const el = btnRef.current;
    if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const box = el.getBoundingClientRect();
    const dx = ((e.clientX - box.left) / box.width - 0.5) * 8;
    const dy = ((e.clientY - box.top) / box.height - 0.5) * 8;
    el.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`;
  }, []);

  const onLeave = useCallback(() => {
    const el = btnRef.current;
    if (el) el.style.transform = "";
  }, []);

  return (
    <div className={styles.promptRow}>
      <span className={styles.promptText} ref={textRef}>
        {text}
      </span>

      <button
        type="button"
        ref={btnRef}
        className={`${styles.btnNavy} ${styles.btnNavySm} ${styles.copyBtn}`}
        onClick={onCopy}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        onBlur={onLeave}
      >
        {copied ? (
          <span className={styles.copyLabel}>
            <svg
              className={styles.copyCheck}
              viewBox="0 0 16 13"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M1.5 6.5 5.6 11 14.5 1.6" />
            </svg>
            Copied
          </span>
        ) : (
          <span className={styles.copyLabel}>Copy</span>
        )}
      </button>

      <span aria-live="polite" className={styles.srOnly}>
        {copied ? "Prompt copied" : ""}
      </span>
    </div>
  );
}
