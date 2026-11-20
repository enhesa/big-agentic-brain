"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../../landing.module.css";

/**
 * Pause, play and restart for the animated film (FilmSvg).
 *
 * The film plays without this: its animation is SVG's own. This adds what a moving picture
 * owes its viewer: a way to stop it, a start from the first scene when it scrolls into view,
 * and no work while it is off screen.
 *
 * People who ask their device for less motion see the still poster (landing.module.css hides
 * the film for them). For them the film waits, and Play is how they choose to watch it.
 */
export default function FilmControls({ target }: { target: string }) {
  const [paused, setPaused] = useState(false);
  // What the viewer asked for, kept apart from what scrolling does.
  const wantsPlay = useRef(true);
  const started = useRef(false);
  // Whether the film is on screen. True until the page says otherwise.
  const inView = useRef(true);

  const film = () => document.getElementById(target) as SVGSVGElement | null;

  /** Plays the film, and shows it to someone who was looking at the poster. */
  const play = (svg: SVGSVGElement, fromStart: boolean) => {
    svg.parentElement?.setAttribute("data-chosen", "");
    if (fromStart || !started.current) svg.setCurrentTime(0);
    started.current = true;
    wantsPlay.current = true;
    // Off screen it waits: it starts when it scrolls back into view.
    if (inView.current) svg.unpauseAnimations();
    setPaused(false);
  };

  useEffect(() => {
    const svg = document.getElementById(target) as SVGSVGElement | null;
    if (!svg) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      wantsPlay.current = false;
      svg.pauseAnimations();
      setPaused(true);
    }
    if (typeof IntersectionObserver === "undefined") return;
    svg.pauseAnimations();
    const seen = new IntersectionObserver(
      ([entry]) => {
        inView.current = entry.isIntersecting;
        if (!entry.isIntersecting) {
          svg.pauseAnimations();
          return;
        }
        if (!started.current) {
          started.current = true;
          svg.setCurrentTime(0);
        }
        if (wantsPlay.current) svg.unpauseAnimations();
      },
      { threshold: 0.35 },
    );
    // The stage, not the film: the film itself is not laid out while the poster stands in.
    seen.observe(svg.parentElement ?? svg);
    return () => seen.disconnect();
  }, [target]);

  const toggle = () => {
    const svg = film();
    if (!svg) return;
    if (paused) {
      play(svg, false);
      return;
    }
    wantsPlay.current = false;
    svg.pauseAnimations();
    setPaused(true);
  };

  const restart = () => {
    const svg = film();
    if (svg) play(svg, true);
  };

  return (
    <div className={styles.filmControls}>
      <button type="button" className={styles.filmButton} onClick={toggle} aria-controls={target}>
        {paused ? "Play" : "Pause"}
      </button>
      <button type="button" className={styles.filmButton} onClick={restart} aria-controls={target}>
        Restart
      </button>
    </div>
  );
}
