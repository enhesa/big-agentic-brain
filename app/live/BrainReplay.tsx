"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { BrainReplay as BrainReplayData } from "@/lib/live-replay";
import { buildReplayScene, type ReplayCounts, type ReplayScene } from "@/lib/replay-scene";
import type { ReplayView } from "./replay-scene";
import styles from "./live.module.css";

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function day(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** `unread`: the history did not arrive. `failed`: this browser cannot draw it. */
type Phase = "loading" | "playing" | "empty" | "unread" | "failed";

/** One press of an arrow key turns the brain this far, in radians. */
const KEY_TURN = 0.12;

/**
 * The Replay on the Live Brain page: the whole history of the brain, played as a brain that grows
 * (docs/spec.md "Live Brain page", Replay). Every memory is a drop of ink, in a group with its
 * project. Threads join it to its neighbours, and sparks run where a memory was reused, searched
 * for or flagged. It is for the joy of it: the numbers beside it say the same in words.
 *
 * The drawing library is loaded here, on the first press, and not with the page.
 */
export default function BrainReplay({ onClose }: { onClose: () => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<ReplayView | null>(null);
  const scene = useRef<ReplayScene | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [seconds, setSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  /** False until the replay has run once: the still picture under reduced motion has not played yet. */
  const [played, setPlayed] = useState(false);
  const [duration, setDuration] = useState(1);
  const [span, setSpan] = useState<{ from: Date; totals: BrainReplayData["totals"]; clusters: number } | null>(null);
  const [canFill, setCanFill] = useState(false);
  const [filled, setFilled] = useState(false);

  useEffect(() => {
    let closed = false;
    // The button that opened the replay is gone: the replay takes the focus, so the keyboard stays here.
    frame.current?.focus();
    (async () => {
      let data: BrainReplayData;
      try {
        const res = await fetch("/live/replay", { cache: "no-store" });
        if (!res.ok) throw new Error(`replay answered ${res.status}`);
        data = (await res.json()) as BrainReplayData;
      } catch {
        if (!closed) setPhase("unread");
        return;
      }
      if (closed || !canvas.current) return;
      if (data.neurons.born.length === 0) {
        setPhase("empty");
        return;
      }
      try {
        const drawing = await import("./replay-scene");
        if (closed || !canvas.current) return;
        const built = buildReplayScene(data);
        const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
        view.current = drawing.mountReplay(canvas.current, built, {
          still,
          onTick: (at, running) => {
            setSeconds(at);
            setPlaying(running);
          },
          onLost: () => {
            view.current = null;
            setPhase("failed");
          },
        });
        scene.current = built;
        setDuration(built.duration);
        setSeconds(still ? built.duration : 0);
        setPlaying(!still);
        setPlayed(!still);
        setSpan({ from: new Date(data.start), totals: data.totals, clusters: data.clusters });
        setPhase("playing");
      } catch {
        // No WebGL: say so in words.
        if (!closed) setPhase("failed");
      }
    })();
    return () => {
      closed = true;
      view.current?.dispose();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    setCanFill(Boolean(document.fullscreenEnabled));
    const changed = () => setFilled(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  const built = phase === "playing" ? scene.current : null;
  const counts: ReplayCounts | null = built ? built.countsAt(seconds) : null;
  const at = built ? built.dateAt(seconds) : null;
  const ended = seconds >= duration;

  const summary = span
    ? `A replay of the brain growing from ${day(span.from)} to today: ${count(span.totals.memories)} memories in ${count(span.clusters)} groups, reused ${count(span.totals.reuses)} times.`
    : "A replay of the brain growing.";

  function toggle() {
    if (!view.current) return;
    if (playing) view.current.pause();
    else {
      view.current.play();
      setPlayed(true);
    }
    setPlaying(!playing);
  }

  function fill() {
    // A browser may refuse (a phone, a frame without leave): the replay then stays as it is.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void frame.current?.requestFullscreen?.().catch(() => {});
  }

  /** The arrow keys turn the brain, plus and minus zoom. On the time bar they keep their own meaning. */
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (!view.current || e.target instanceof HTMLInputElement || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft") view.current.turn(-KEY_TURN, 0);
    else if (e.key === "ArrowRight") view.current.turn(KEY_TURN, 0);
    else if (e.key === "ArrowUp") view.current.turn(0, KEY_TURN);
    else if (e.key === "ArrowDown") view.current.turn(0, -KEY_TURN);
    else if (e.key === "+" || e.key === "=") view.current.zoom(0.9);
    else if (e.key === "-") view.current.zoom(1.1);
    else return;
    e.preventDefault();
  }

  return (
    <div className={styles.replay} ref={frame} tabIndex={-1} role="group" aria-label="Replay of the brain growing" onKeyDown={keys}>
      <canvas ref={canvas} className={styles.replayCanvas} role="img" aria-label={summary} />

      {phase === "loading" ? <p className={styles.replayNote}>Reading the history of the brain</p> : null}
      {phase === "empty" ? <p className={styles.replayNote}>No memories yet. The replay starts with the first one.</p> : null}
      {phase === "unread" ? (
        <p className={styles.replayNote} role="status">
          The history could not be read just now. Go back and try again in a minute.
        </p>
      ) : null}
      {phase === "failed" ? (
        <p className={styles.replayNote} role="status">
          This browser could not draw the replay. The numbers below say the same.
        </p>
      ) : null}

      {phase === "playing" && at && counts ? (
        <div className={styles.replayTop}>
          <p className={styles.replayDate}>{day(at)}</p>
          <p className={styles.replayCounts}>
            {count(counts.memories)} memories · {count(counts.reuses)} reuses · {count(counts.searches)} searches · {count(counts.messages)} messages
          </p>
          <p className={styles.replayHint}>Drag or use the arrow keys to turn. Scroll or press + and - to zoom.</p>
        </div>
      ) : null}

      <div className={styles.replayBar}>
        {phase === "playing" ? (
          <>
            <button type="button" className={`btn-quiet ${styles.replayButton}`} onClick={toggle}>
              {playing ? "Pause" : ended && played ? "Play again" : "Play"}
            </button>
            <input
              className={styles.replayTime}
              type="range"
              min={0}
              max={duration}
              step={0.25}
              value={seconds}
              aria-label="Time in the replay"
              aria-valuetext={at ? day(at) : undefined}
              onChange={(e) => {
                const to = Number(e.target.value);
                setSeconds(to);
                view.current?.seek(to);
              }}
            />
            {canFill ? (
              <button type="button" className={`btn-quiet ${styles.replayButton}`} onClick={fill}>
                {filled ? "Leave full screen" : "Full screen"}
              </button>
            ) : null}
          </>
        ) : (
          <span className={styles.replaySpace} />
        )}
        <button type="button" className={`btn-quiet ${styles.replayButton}`} onClick={onClose}>
          Back to live
        </button>
      </div>
    </div>
  );
}
