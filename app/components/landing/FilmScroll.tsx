"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../../landing.module.css";
import { ACT_MARKS, LAST_SECOND, actAt, filmTimeAt, glide, scrollProgress } from "@/lib/film-scroll";
import { useScrub } from "./useScrub";

export type Act = { title: string; text: string };

/**
 * The film's acts in words, and the film's clock on a wide screen.
 *
 * Every act is in the page from the server, so it reads as a numbered list on a phone, for
 * people who ask for less motion, and without script. On a wide screen (useScrub) the film is
 * pinned and this component is its projector: it reads how far the page has scrolled through
 * the film's section, sets the film to that moment, and shows the act that moment belongs to.
 *
 * One clock: the scroll position. One writer: a single animation frame callback, which glides
 * the film toward the scroll position and stops when it gets there.
 */
export default function FilmScroll({ target, acts }: { target: string; acts: Act[] }) {
  const root = useRef<HTMLDivElement | null>(null);
  const scrub = useScrub();
  const [act, setAct] = useState(0);

  useEffect(() => {
    if (!scrub) return;
    const svg = document.getElementById(target) as SVGSVGElement | null;
    const section = root.current?.closest("section");
    if (!svg || !section) return;
    svg.pauseAnimations();

    let frame = 0;
    let now = -1;
    let goal = 0;
    const draw = () => {
      frame = 0;
      now = now < 0 ? goal : glide(now, goal);
      svg.setCurrentTime(now);
      root.current?.style.setProperty("--film-at", (now / LAST_SECOND).toFixed(4));
      setAct(actAt(now));
      if (now !== goal) frame = requestAnimationFrame(draw);
    };
    const measure = () => {
      const box = section.getBoundingClientRect();
      goal = filmTimeAt(scrollProgress(box.top, box.height, window.innerHeight));
      if (!frame) frame = requestAnimationFrame(draw);
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      cancelAnimationFrame(frame);
    };
  }, [scrub, target]);

  return (
    <div className={styles.filmActs} ref={root}>
      <ol className={styles.actList} aria-label="What the film shows">
        {acts.map((a, i) => (
          <li key={a.title} className={`${styles.act} ${i === act ? styles.actOn : ""}`}>
            <span className={styles.actNo} aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className={styles.actWords}>
              <strong className={styles.actTitle}>{a.title}</strong>
              <span className={styles.actText}>{a.text}</span>
            </span>
          </li>
        ))}
      </ol>
      {/* How far the film is, with a notch where each act begins. Decoration: the acts say it in words. */}
      <div className={styles.rail} aria-hidden="true">
        <span className={styles.railFill} />
        {ACT_MARKS.map((at) => (
          <span key={at} className={styles.railMark} style={{ left: `${(at * 100).toFixed(2)}%` }} />
        ))}
      </div>
    </div>
  );
}
