"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../../landing.module.css";

type RevealProps = {
  children: React.ReactNode;
  /** Extra class names applied to the wrapper element. */
  className?: string;
  /** Stagger in milliseconds before the reveal transition starts. */
  delay?: number;
  as?: "div" | "li" | "section" | "figure";
};

/**
 * Fades its children in when they first scroll into view.
 * Purely decorative: content is rendered server-side and stays readable
 * even when IntersectionObserver is unavailable.
 */
export default function Reveal({ children, className, delay = 0, as = "div" }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Anything already at or above the fold when we mount (deep link, restored
    // scroll position, slow hydration) is shown straight away: it may never
    // intersect again on the way down.
    if (
      typeof IntersectionObserver === "undefined" ||
      node.getBoundingClientRect().top < window.innerHeight
    ) {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );

    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, []);

  const Tag = as as "div";
  const classes = [styles.reveal, shown ? styles.revealed : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag
      ref={ref as React.RefObject<HTMLDivElement>}
      className={classes}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
