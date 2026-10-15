"use client";

import Link from "next/link";
import { useCallback, useRef } from "react";
import styles from "../../landing.module.css";

type Props = {
  href: string;
  children: React.ReactNode;
  className?: string;
};

/** Navy pill that leans up to 4px toward the cursor. Purely decorative. */
export default function MagneticButton({ href, children, className }: Props) {
  const ref = useRef<HTMLAnchorElement | null>(null);
  const reduced = useRef<boolean | null>(null);

  const isReduced = () => {
    if (reduced.current === null) {
      reduced.current =
        typeof window !== "undefined" &&
        !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    }
    return reduced.current;
  };

  const onMove = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    const el = ref.current;
    if (!el || isReduced()) return;
    const box = el.getBoundingClientRect();
    const dx = ((e.clientX - box.left) / box.width - 0.5) * 8;
    const dy = ((e.clientY - box.top) / box.height - 0.5) * 8;
    el.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`;
  }, []);

  const onLeave = useCallback(() => {
    const el = ref.current;
    if (el) el.style.transform = "";
  }, []);

  return (
    <Link
      ref={ref}
      href={href}
      className={[styles.btnNavy, className].filter(Boolean).join(" ")}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onBlur={onLeave}
    >
      {children}
    </Link>
  );
}
