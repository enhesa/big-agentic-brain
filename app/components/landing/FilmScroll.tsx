"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../../landing.module.css";
import { ACT_MARKS, FRAME, LAST_SECOND, actAt, filmTimeAt, glide, nightAt, scrollProgress } from "@/lib/film-scroll";
import { useScrub } from "./useScrub";

export type Act = { title: string; text: string };

/**
 * The film's acts in words, and the film's clock on a wide screen.
 *
 * The acts say what each scene means; what it draws is said elsewhere, for screen readers.
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
    // When the last frame was drawn. 0 while the film rests.
    let drawn = 0;
    const draw = (stamp: number) => {
      frame = 0;
      // A long gap (a hidden tab) counts as a few frames, not a leap.
      const ms = drawn ? Math.min(stamp - drawn, FRAME * 6) : FRAME;
      now = now < 0 ? goal : glide(now, goal, ms);
      drawn = now === goal ? 0 : stamp;
      svg.setCurrentTime(now);
      root.current?.style.setProperty("--film-at", (now / LAST_SECOND).toFixed(4));
      setAct(actAt(now));
      // The film's night spills over the page: the words beside it turn light while it lasts.
      section.toggleAttribute("data-night", nightAt(now));
      if (now !== goal) frame = requestAnimationFrame(draw);
    };
    // How far below the top of the window the film is pinned: under the top bar, as tall as it
    // really is (a larger font or a wrapped menu makes it taller than the stylesheet's figure).
    const pin = section.querySelector<HTMLElement>(`.${styles.filmPin}`);
    const bar = document.querySelector<HTMLElement>(`.${styles.topbar}`);
    let pinTop = 0;
    const measure = () => {
      const box = section.getBoundingClientRect();
      goal = filmTimeAt(scrollProgress(box.top, box.height, window.innerHeight, pinTop));
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const size = () => {
      const tall = bar ? Math.ceil(bar.getBoundingClientRect().height) : 0;
      if (tall > 0) section.style.setProperty("--bar", `${tall}px`);
      pinTop = (pin && parseFloat(getComputedStyle(pin).top)) || 0;
      measure();
    };
    size();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", size);
    // The page can change shape without a scroll or a resize: a font arrives, the menu wraps.
    const shape = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
    shape?.observe(document.body);
    if (bar) shape?.observe(bar);
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", size);
      shape?.disconnect();
      cancelAnimationFrame(frame);
      section.removeAttribute("data-night");
      section.style.removeProperty("--bar");
      root.current?.style.removeProperty("--film-at");
      // Handed back to the player, the film starts from its first scene.
      svg.setCurrentTime(0);
    };
  }, [scrub, target]);

  return (
    <div className={styles.filmActs} ref={root}>
      <ol className={styles.actList} aria-label="The film, act by act">
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
