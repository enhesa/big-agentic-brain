"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import type { BeatKind, LiveBeat, LiveBrain as LiveBrainData } from "@/lib/live-brain";
import { BEAT_WORDS, CORE, PICTURE, arcPath, coreCount, coreEdge, dotPlace, otherSeat, seatOf, smoothClosed, type Point } from "@/lib/live-picture";
import { blobPoints } from "@/lib/film-story.mjs";
import BrainReplay from "./BrainReplay";
import styles from "./live.module.css";

/** How long one beat moves, and how far apart beats that arrive together start. */
export const BEAT_MS = 1900;
export const STAGGER_MS = 420;
/** The page asks for a new snapshot this often while it is visible, and shortly after a live event. */
export const POLL_MS = 10_000;
const EVENT_DEBOUNCE_MS = 400;
/** On opening, the page plays again what happened in the last hour: at most this many beats. */
export const REPLAY_MAX = 6;
const REPLAY_WINDOW_MS = 3_600_000;
/** When the picture has gone still, it plays the latest beats again after this pause, and so on. */
export const LOOP_PAUSE_MS = 2500;
/** Beats that arrive in one snapshot and are played. More than this would be a blur. */
const PLAY_MAX = 12;
/**
 * The beats the picture plays again when it has gone still: what happened in the last hour, at most
 * REPLAY_MAX, newest last. When the last hour was quiet, the latest beats of the window instead.
 */
export function loopBeats(beats: LiveBeat[], now: number): LiveBeat[] {
  const recent = beats.filter((b) => now - Date.parse(b.at) < REPLAY_WINDOW_MS);
  return (recent.length > 0 ? recent : beats).slice(-REPLAY_MAX);
}

/** Rows in the list under the picture. */
export const LATEST_MAX = 12;

/** The live events worth a new snapshot (lib/events.ts). A search has no event: the poll finds it. */
const EVENT_TYPES = ["learning.created", "learning.updated", "message.created", "kudos", "vote", "flag"];

const SWATCH: Record<BeatKind, string> = {
  save: styles.teal,
  search: styles.steel,
  reuse: styles.amber,
  message: styles.navy,
  flag: styles.coral,
};

interface Playing {
  key: number;
  beat: LiveBeat;
  delay: number;
}

function ago(iso: string, now: number): string {
  const sec = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} hr ago`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** The start and end of a moving mark, handed to the stylesheet. */
function flight(from: Point, to: Point, delay: number): CSSProperties {
  return {
    "--x0": `${from.x}px`,
    "--y0": `${from.y}px`,
    "--x1": `${to.x}px`,
    "--y1": `${to.y}px`,
    animationDelay: `${delay}ms`,
  } as CSSProperties;
}

const BRAIN_PATH = smoothClosed(blobPoints(CORE.x, CORE.y, CORE.r, CORE.r * 0.94, 3, 0, 0.05, 11) as Array<[number, number]>);

export interface LiveBrainProps {
  initial: LiveBrainData;
  /** The server's clock at render, so the first paint says the same times on both sides. */
  initialNow: string;
  dotsMax: number;
  windowHours: number;
  /** The count of people is never shown under this (lib/live-brain.ts LIVE_PEOPLE_FLOOR). */
  peopleFloor: number;
}

/**
 * The Live Brain picture and the list under it. It draws the snapshot it was given, plays the last
 * hour again, then follows along: a new snapshot from /live/feed every few seconds and right after
 * a live event. Everything the picture shows is also in the list, so nothing depends on motion.
 *
 * A dot is a seat, not a person: there are as many dots as people whose agents were at work, and
 * never fewer than the floor. The snapshot does not say who did a beat, so each mark goes to a
 * seat drawn by lot from the beat's id (lib/live-picture.ts).
 */
export default function LiveBrain({ initial, initialNow, dotsMax, windowHours, peopleFloor }: LiveBrainProps) {
  const [brain, setBrain] = useState(initial);
  const [now, setNow] = useState(() => Date.parse(initialNow));
  const [playing, setPlaying] = useState<Playing[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const lastId = useRef(initial.beats.reduce((m, b) => Math.max(m, b.id), 0));
  const nextKey = useRef(1);
  /** The Replay button swaps the picture for the whole history, drawn as a brain that grows. */
  const [replaying, setReplaying] = useState(false);
  const replayButton = useRef<HTMLButtonElement>(null);
  const wasReplaying = useRef(false);
  // The replay took the keyboard focus when it opened. Closing it hands the focus back.
  useEffect(() => {
    if (wasReplaying.current && !replaying) replayButton.current?.focus();
    wasReplaying.current = replaying;
  }, [replaying]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const play = useCallback((beats: LiveBeat[]) => {
    if (beats.length === 0) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const batch = beats.slice(-PLAY_MAX).map((beat, i) => ({ key: nextKey.current++, beat, delay: i * STAGGER_MS }));
    setPlaying((p) => [...p, ...batch]);
    const keys = new Set(batch.map((b) => b.key));
    const timer = setTimeout(
      () => {
        timers.current.delete(timer);
        setPlaying((p) => p.filter((b) => !keys.has(b.key)));
      },
      batch[batch.length - 1].delay + BEAT_MS + 400,
    );
    timers.current.add(timer);
  }, []);

  // The picture never rests: once every mark has finished, the latest beats play again after a pause.
  // A snapshot that brings a new beat starts it on its own, and the loop carries on after it. Under
  // reduced motion play() does nothing, so nothing loops. It waits while the tab is hidden or the
  // Replay is open.
  const latestBrain = useRef({ beats: initial.beats, now });
  latestBrain.current = { beats: brain.beats, now };
  const still = playing.length === 0;
  useEffect(() => {
    if (!still || replaying || brain.beats.length === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        if (document.hidden) return arm();
        play(loopBeats(latestBrain.current.beats, latestBrain.current.now));
      }, LOOP_PAUSE_MS);
    };
    arm();
    return () => clearTimeout(timer);
  }, [still, replaying, brain.beats.length, play]);

  useEffect(() => {
    const held = timers.current;
    let stopped = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    // Requests are numbered: an answer that lands after a newer one was applied is dropped.
    let asked = 0;
    let applied = 0;

    const start = Date.parse(initialNow);
    play(initial.beats.filter((b) => start - Date.parse(b.at) < REPLAY_WINDOW_MS).slice(-REPLAY_MAX));

    async function load() {
      if (stopped || document.hidden) return;
      const mine = ++asked;
      try {
        const res = await fetch("/live/feed", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const body = (await res.json()) as { now: string; brain: LiveBrainData };
        if (stopped || mine < applied) return;
        applied = mine;
        const fresh = body.brain.beats.filter((b) => b.id > lastId.current);
        lastId.current = body.brain.beats.reduce((m, b) => Math.max(m, b.id), lastId.current);
        setBrain(body.brain);
        setNow(Date.parse(body.now));
        play(fresh);
      } catch {
        // A failed poll changes nothing: the next one tries again.
      }
    }

    function soon() {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(load, EVENT_DEBOUNCE_MS);
    }

    const source = new EventSource("/api/events");
    source.onopen = () => setStatus("live");
    source.onerror = () => setStatus("reconnecting");
    for (const type of EVENT_TYPES) source.addEventListener(type, soon);
    const poll = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", soon);

    return () => {
      stopped = true;
      source.close();
      clearInterval(poll);
      if (debounce) clearTimeout(debounce);
      document.removeEventListener("visibilitychange", soon);
      for (const t of held) clearTimeout(t);
      held.clear();
    };
    // The first snapshot is read once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dots = Math.min(brain.agents, dotsMax);
  const places = useMemo(() => Array.from({ length: dots }, (_, i) => dotPlace(i, dots)), [dots]);
  const latest = useMemo(() => [...brain.beats].reverse().slice(0, LATEST_MAX), [brain.beats]);

  // At the floor the count stands for "this many or fewer", and the page says so.
  const few = brain.agents > 0 && brain.agents <= peopleFloor;
  const tiles: Array<{ label: string; value: string; swatch?: string }> = [
    { label: "People with agents at work", value: few ? `${count(peopleFloor)} or fewer` : count(brain.agents) },
    { label: "Searches", value: count(brain.counts.search), swatch: styles.steel },
    { label: "Memories saved", value: count(brain.counts.save), swatch: styles.teal },
    { label: "Memories reused", value: count(brain.counts.reuse), swatch: styles.amber },
    { label: "Messages", value: count(brain.counts.message), swatch: styles.navy },
  ];

  const summary =
    brain.agents === 0
      ? `The brain, with no agents at work in the last ${windowHours} hours.`
      : `The brain with ${dots} dots around it, for the people whose agents were at work. What was done is in the list below.`;

  return (
    <div className={styles.live}>
      {replaying ? <BrainReplay onClose={() => setReplaying(false)} /> : null}
      <div className={styles.stage} hidden={replaying}>
        <svg className={styles.picture} viewBox={`0 0 ${PICTURE.width} ${PICTURE.height}`} role="img" aria-label={summary}>
          <g className={styles.spokes}>
            {places.map((p, i) => {
              const e = coreEdge(p);
              return <line key={i} x1={e.x} y1={e.y} x2={p.x} y2={p.y} />;
            })}
          </g>

          <g>
            {playing.map(({ key, beat, delay }) => {
              // A seat drawn by lot: the snapshot does not say who did this.
              const seat = seatOf(beat.id, dots);
              const from = seat >= 0 ? places[seat] : undefined;
              const edge = from ? coreEdge(from) : undefined;
              const pulse = (tone: string, wait: number) => (
                <circle className={`${styles.pulse} ${tone}`} cx={CORE.x} cy={CORE.y} r={CORE.r} style={{ animationDelay: `${delay + wait}ms` }} />
              );
              if (beat.kind === "message") {
                const other = otherSeat(beat.id, dots, seat);
                if (!from || other < 0) return <g key={key}>{pulse(styles.navy, 0)}</g>;
                return (
                  <g key={key}>
                    <path className={styles.arc} d={arcPath(from, places[other])} pathLength={1} style={{ animationDelay: `${delay}ms` }} />
                  </g>
                );
              }
              if (!from || !edge) {
                return <g key={key}>{pulse(SWATCH[beat.kind], 0)}</g>;
              }
              if (beat.kind === "reuse") {
                return (
                  <g key={key}>
                    <circle className={`${styles.fly} ${styles.amber}`} r={8} style={flight(edge, from, delay)} />
                    <circle className={`${styles.halo} ${styles.amber}`} cx={from.x} cy={from.y} r={12} style={{ animationDelay: `${delay + BEAT_MS * 0.55}ms` }} />
                  </g>
                );
              }
              if (beat.kind === "search") {
                return (
                  <g key={key}>
                    <circle className={`${styles.fly} ${styles.steel}`} r={5} style={flight(from, edge, delay)} />
                    <circle className={`${styles.fly} ${styles.sage}`} r={5} style={flight(edge, from, delay + BEAT_MS * 0.5)} />
                  </g>
                );
              }
              const tone = beat.kind === "flag" ? styles.coral : styles.teal;
              return (
                <g key={key}>
                  <circle className={`${styles.fly} ${tone}`} r={8} style={flight(from, edge, delay)} />
                  {pulse(tone, BEAT_MS * 0.55)}
                </g>
              );
            })}
          </g>

          <path className={styles.brain} d={BRAIN_PATH} />

          <g>
            {places.map((p, i) => (
              <circle key={i} className={styles.dot} cx={p.x} cy={p.y} r={11} />
            ))}
          </g>
        </svg>

        <p className={styles.core}>
          <span className={styles.coreCount}>{coreCount(brain.memories)}</span>
          <span className={styles.coreLabel}>{brain.memories === 1 ? "memory" : "memories"}</span>
        </p>
      </div>

      <div className={styles.bar}>
        <p className={styles.status}>
          <span className={`${styles.statusDot} ${status === "live" ? styles.statusLive : styles.statusWaiting}`} aria-hidden="true" />
          {status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting"}
        </p>
        {replaying ? null : (
          <button type="button" className="btn-primary" ref={replayButton} onClick={() => setReplaying(true)}>
            Replay how the brain grew
          </button>
        )}
      </div>

      <dl className={styles.tiles}>
        {tiles.map((t) => (
          <div key={t.label} className={styles.tile}>
            <dt>
              {t.swatch ? <span className={`${styles.swatch} ${t.swatch}`} aria-hidden="true" /> : null}
              {t.label}
            </dt>
            <dd>{t.value}</dd>
          </div>
        ))}
      </dl>
      {dots > 0 ? (
        <p className={styles.note}>
          A dot stands for a person, but no dot is anyone&apos;s: which dot a mark moves to is drawn by lot.
          {few ? ` With ${count(peopleFloor)} people or fewer the picture still draws ${count(peopleFloor)} dots, so it never shows one person alone.` : ""}
          {brain.agents > dots ? ` The picture draws ${dotsMax} dots for ${count(brain.agents)} people.` : ""}
        </p>
      ) : null}

      <section className={styles.latest} aria-labelledby="live-latest">
        <h2 id="live-latest" className={styles.latestTitle}>
          Latest
        </h2>
        {latest.length === 0 ? (
          <p className="empty-state">{`Quiet for the last ${windowHours} hours. The picture moves when an agent searches, saves or reuses a memory.`}</p>
        ) : (
          <ol className={styles.list}>
            {latest.map((b) => (
              <li key={b.id} className={styles.row}>
                <span className={`${styles.swatch} ${SWATCH[b.kind]}`} aria-hidden="true" />
                <span className={styles.what}>
                  {BEAT_WORDS[b.kind]}
                  {b.memory ? (
                    <>
                      {": "}
                      <Link href={`/memory/${encodeURIComponent(b.memory.id)}`}>{b.memory.title}</Link>
                    </>
                  ) : null}
                </span>
                <time className={styles.when} dateTime={b.at}>
                  {ago(b.at, now)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
