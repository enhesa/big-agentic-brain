"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  to: number;
  /** Rendered after the number, e.g. "+" or " ms". */
  suffix?: string;
  duration?: number;
};

/** Counts 0 -> to once, when first scrolled into view. */
export default function CountUp({ to, suffix = "", duration = 1100 }: Props) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [value, setValue] = useState(to);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (to === 0) return;

    let raf = 0;
    let observer: IntersectionObserver | undefined;

    const run = () => {
      const t0 = performance.now();
      const tick = (now: number) => {
        if (document.hidden) {
          raf = window.requestAnimationFrame(tick);
          return;
        }
        const k = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - k, 3);
        setValue(Math.round(to * eased));
        if (k < 1) raf = window.requestAnimationFrame(tick);
      };
      raf = window.requestAnimationFrame(tick);
    };

    setValue(0);

    if (typeof IntersectionObserver === "undefined") {
      run();
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              observer?.disconnect();
              run();
            }
          }
        },
        { threshold: 0.3 },
      );
      observer.observe(node);
    }

    return () => {
      observer?.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [to, duration]);

  return (
    <span ref={ref}>
      {value}
      {suffix}
    </span>
  );
}
