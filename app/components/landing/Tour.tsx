"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./tour.module.css";

/**
 * The demo as a moving diagram, not a wall of text (animated visuals,
 * dynamic diagrams, less text). Four colleagues and their agents sit around the brain;
 * five scenes show what travels along the lines: a learning going in, a search coming
 * back, a question hopping between two agents, a reminder returning on its day, and
 * every agent checking at once. One short caption per scene.
 *
 * Travellers are positioned each frame with `getPointAtLength` on the drawn paths, which
 * works in every browser and pauses cleanly (hover, focus, hidden tab, reduced motion).
 */

export const SCENE_MS = 6500;

const NAVY = "#1a3360";
const TEAL = "#00b0a1";
const AMBER = "#ffb700";

type PathId = "alice" | "carl" | "bob" | "dana";
type Glyph = "card" | "dot" | "mail" | "clock" | "bell" | "check";

/** Something moving along one of the four lines during [start, end] ms of a scene. */
type Traveller = { path: PathId; glyph: Glyph; start: number; end: number; reverse?: boolean; color?: string };
/** A moment where a badge shows near an actor or the brain. */
type Flash = { at: PathId | "brain"; kind: "ask" | "check" | "plus" | "date" | "ring"; start: number; end: number };

type Scene = { id: string; label: string; caption: string; travellers: Traveller[]; flashes: Flash[] };

const SCENES: Scene[] = [
  {
    id: "save",
    label: "Save",
    caption: "Alice's agent learns something. They approve, it is saved.",
    travellers: [{ path: "alice", glyph: "card", start: 1800, end: 3600 }],
    flashes: [
      { at: "alice", kind: "ask", start: 300, end: 1700 },
      { at: "brain", kind: "plus", start: 3600, end: 5600 },
    ],
  },
  {
    id: "find",
    label: "Find",
    caption: "Carl's agent checks the brain before it guesses.",
    travellers: [
      { path: "carl", glyph: "dot", start: 300, end: 1700 },
      { path: "carl", glyph: "card", start: 2000, end: 3800, reverse: true },
    ],
    flashes: [{ at: "carl", kind: "check", start: 3800, end: 6000 }],
  },
  {
    id: "ask",
    label: "Ask",
    caption: "Agents ask each other. People read their own threads in the inbox.",
    travellers: [
      { path: "carl", glyph: "mail", start: 300, end: 1600 },
      { path: "alice", glyph: "mail", start: 1600, end: 2900, reverse: true },
      { path: "alice", glyph: "mail", start: 3500, end: 4700, color: AMBER },
      { path: "carl", glyph: "mail", start: 4700, end: 5900, reverse: true, color: AMBER },
    ],
    flashes: [{ at: "alice", kind: "ask", start: 2900, end: 3500 }],
  },
  {
    id: "remind",
    label: "Remind",
    caption: "A reminder comes back on its day, steps included.",
    travellers: [
      { path: "bob", glyph: "clock", start: 300, end: 1700 },
      { path: "bob", glyph: "bell", start: 3700, end: 5100, reverse: true, color: AMBER },
    ],
    flashes: [
      { at: "brain", kind: "date", start: 1700, end: 3700 },
      { at: "bob", kind: "ring", start: 5100, end: 6400 },
    ],
  },
  {
    id: "everyone",
    label: "Everyone",
    caption: "Every team, every agent, one memory.",
    travellers: [
      { path: "alice", glyph: "dot", start: 200, end: 1500 },
      { path: "carl", glyph: "dot", start: 350, end: 1650 },
      { path: "bob", glyph: "dot", start: 500, end: 1800 },
      { path: "dana", glyph: "dot", start: 650, end: 1950 },
      { path: "alice", glyph: "card", start: 2300, end: 3700, reverse: true },
      { path: "carl", glyph: "card", start: 2450, end: 3850, reverse: true },
      { path: "bob", glyph: "card", start: 2600, end: 4000, reverse: true },
      { path: "dana", glyph: "card", start: 2750, end: 4150, reverse: true },
    ],
    flashes: [
      { at: "alice", kind: "check", start: 3700, end: 6200 },
      { at: "carl", kind: "check", start: 3850, end: 6200 },
      { at: "bob", kind: "check", start: 4000, end: 6200 },
      { at: "dana", kind: "check", start: 4150, end: 6200 },
    ],
  },
];

/** Agent chip positions (line start) and the person beside each. */
const ACTORS: Record<PathId, { name: string; team: string; person: [number, number]; agent: [number, number]; d: string; color: string }> = {
  alice: { name: "Alice", team: "Marketing", person: [110, 110], agent: [190, 110], d: "M190 110 C 300 110, 350 170, 402 196", color: TEAL },
  bob: { name: "Bob", team: "Sales", person: [110, 330], agent: [190, 330], d: "M190 330 C 300 330, 350 270, 402 244", color: TEAL },
  carl: { name: "Carl", team: "Engineering", person: [790, 110], agent: [710, 110], d: "M710 110 C 600 110, 550 170, 498 196", color: AMBER },
  dana: { name: "Dana", team: "Legal", person: [790, 330], agent: [710, 330], d: "M710 330 C 600 330, 550 270, 498 244", color: AMBER },
};

const BRAIN: [number, number] = [450, 220];

/** The brain mark: a small node cluster, same idea as the hero graph. */
const BRAIN_NODES: [number, number, number, string][] = [
  [0, -30, 6, TEAL],
  [-30, -12, 5, NAVY],
  [30, -14, 5, AMBER],
  [-19, 18, 5.5, NAVY],
  [19, 20, 5, TEAL],
  [0, -2, 9, NAVY],
  [40, 12, 4, TEAL],
  [-40, 14, 4, AMBER],
];
const BRAIN_EDGES: [number, number][] = [
  [0, 5],
  [1, 5],
  [2, 5],
  [3, 5],
  [4, 5],
  [1, 3],
  [2, 4],
  [4, 6],
  [3, 7],
];

function Person({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle cx={0} cy={-13} r={11} fill={NAVY} />
      <path d="M-19 20a19 19 0 0 1 38 0z" fill={NAVY} />
    </g>
  );
}

function AgentChip({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <line x1={0} y1={-24} x2={0} y2={-16} stroke={color} strokeWidth={2.4} />
      <circle cx={0} cy={-26} r={3} fill={color} />
      <rect x={-18} y={-16} width={36} height={30} rx={9} fill={color} />
      <circle cx={-6.5} cy={-1} r={3.2} fill="#fff" />
      <circle cx={6.5} cy={-1} r={3.2} fill="#fff" />
    </g>
  );
}

function GlyphShape({ glyph, color }: { glyph: Glyph; color: string }) {
  switch (glyph) {
    case "dot":
      return <circle r={6} fill={color} />;
    case "card":
      return (
        <g>
          <rect x={-16} y={-11} width={32} height={22} rx={5} fill="#fff" stroke={color} strokeWidth={2} />
          <line x1={-9} y1={-3} x2={9} y2={-3} stroke={NAVY} strokeWidth={2.2} strokeLinecap="round" />
          <line x1={-9} y1={4} x2={3} y2={4} stroke={NAVY} strokeWidth={2.2} strokeLinecap="round" opacity={0.55} />
        </g>
      );
    case "mail":
      return (
        <g>
          <rect x={-15} y={-10} width={30} height={20} rx={4} fill="#fff" stroke={color} strokeWidth={2} />
          <path d="M-13 -7 L0 3 L13 -7" fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        </g>
      );
    case "clock":
      return (
        <g>
          <circle r={11} fill="#fff" stroke={color} strokeWidth={2} />
          <path d="M0 -6 V0 H5" fill="none" stroke={NAVY} strokeWidth={2.2} strokeLinecap="round" />
        </g>
      );
    case "bell":
      return (
        <g>
          <path d="M-9 6 C-9 -2 -6 -9 0 -9 C6 -9 9 -2 9 6 Z" fill={color} />
          <rect x={-11} y={6} width={22} height={3} rx={1.5} fill={color} />
          <circle cx={0} cy={11} r={2.4} fill={color} />
        </g>
      );
    case "check":
      return (
        <g>
          <circle r={10} fill={TEAL} />
          <path d="M-5 0 L-1.5 3.5 L5.5 -4" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      );
  }
}

/** A badge near an actor or the brain. The SVG `transform` attribute positions the outer
 *  group; the CSS animation lives on an inner group, because a CSS `transform` on the
 *  same element would REPLACE the attribute and park the badge at the page origin. */
function FlashBadge({ kind, x, y }: { kind: Flash["kind"]; x: number; y: number }) {
  switch (kind) {
    case "ask":
      return (
        <g transform={`translate(${x} ${y - 44})`}>
          <g className={styles.pop}>
            <rect x={-30} y={-13} width={60} height={26} rx={13} fill="#fff" stroke={TEAL} strokeWidth={1.6} />
            <text x={-8} y={4.5} fontSize={12} fontWeight={700} fill={NAVY} fontFamily="Urbanist, Inter, sans-serif" textAnchor="middle">
              Save?
            </text>
            <g transform="translate(17 0)">
              <circle r={7.5} fill={TEAL} />
              <path d="M-3.5 0 L-1 2.5 L3.8 -2.8" fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </g>
        </g>
      );
    case "check":
      return (
        <g transform={`translate(${x + 20} ${y - 26})`}>
          <g className={styles.pop}>
            <GlyphShape glyph="check" color={TEAL} />
          </g>
        </g>
      );
    case "plus":
      return (
        <g transform={`translate(${x + 56} ${y - 40})`}>
          <g className={styles.pop}>
            <rect x={-18} y={-12} width={36} height={24} rx={12} fill={TEAL} />
            <text x={0} y={4.5} fontSize={13} fontWeight={800} fill="#fff" fontFamily="Urbanist, Inter, sans-serif" textAnchor="middle">
              +1
            </text>
          </g>
        </g>
      );
    case "date":
      return (
        <g transform={`translate(${x} ${y - 66})`}>
          <g className={styles.pop}>
            <rect x={-26} y={-16} width={52} height={32} rx={7} fill="#fff" stroke={AMBER} strokeWidth={1.8} />
            <rect x={-26} y={-16} width={52} height={9} rx={4} fill={AMBER} />
            <text x={0} y={9} fontSize={12} fontWeight={800} fill={NAVY} fontFamily="Urbanist, Inter, sans-serif" textAnchor="middle">
              1 Oct
            </text>
          </g>
        </g>
      );
    case "ring":
      return (
        <g transform={`translate(${x} ${y - 40})`}>
          <g className={styles.ring}>
            <GlyphShape glyph="bell" color={AMBER} />
          </g>
        </g>
      );
  }
}

export default function Tour() {
  const [i, setI] = useState(0);
  const [t, setT] = useState(0);
  const [reduced, setReduced] = useState(false);
  const pathRefs = useRef<Record<PathId, SVGPathElement | null>>({ alice: null, carl: null, bob: null, dana: null });
  const startRef = useRef<number | null>(null);
  const tRef = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  // The clock. It never pauses: hovering used to freeze the tour,
  // which read as the animation being broken rather than as a considerate feature.
  useEffect(() => {
    if (reduced) {
      setT(3400);
      return;
    }
    let raf = 0;
    const tick = (now: number) => {
      if (startRef.current === null) startRef.current = now - tRef.current;
      const elapsed = now - startRef.current;
      if (elapsed >= SCENE_MS) {
        tRef.current = 0;
        startRef.current = null;
        setT(0);
        setI((n) => (n + 1) % SCENES.length);
        return;
      }
      tRef.current = elapsed;
      setT(elapsed);
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [i, reduced]);

  const go = useCallback((n: number) => {
    tRef.current = 0;
    startRef.current = null;
    setT(0);
    setI(n);
  }, []);

  const scene = SCENES[i];

  const pointAt = useCallback((path: PathId, p: number): [number, number] => {
    const el = pathRefs.current[path];
    if (!el) return ACTORS[path].agent;
    const len = el.getTotalLength();
    const pt = el.getPointAtLength(Math.min(1, Math.max(0, p)) * len);
    return [pt.x, pt.y];
  }, []);

  const ease = (x: number) => 0.5 - Math.cos(Math.PI * x) / 2;

  const travellers = useMemo(
    () =>
      scene.travellers
        .filter((tr) => t >= tr.start && t <= tr.end)
        .map((tr, k) => {
          const raw = (t - tr.start) / (tr.end - tr.start);
          const p = tr.reverse ? 1 - ease(raw) : ease(raw);
          const [x, y] = pointAt(tr.path, p);
          // Where it was a moment ago: three fading dots so the eye reads direction, not a jump.
          const trail = [0.06, 0.12, 0.18]
            .map((d) => raw - d)
            .filter((r) => r > 0)
            .map((r) => pointAt(tr.path, tr.reverse ? 1 - ease(r) : ease(r)));
          return { key: `${scene.id}-${k}`, x, y, trail, glyph: tr.glyph, color: tr.color ?? ACTORS[tr.path].color };
        }),
    [scene, t, pointAt],
  );

  const flashes = scene.flashes.filter((f) => t >= f.start && t <= f.end);

  // The brain glows while anything is arriving into it or leaving it.
  const brainBusy = scene.travellers.some((tr) => {
    if (t < tr.start || t > tr.end) return false;
    const raw = (t - tr.start) / (tr.end - tr.start);
    return tr.reverse ? raw < 0.2 : raw > 0.8;
  });
  const activePaths = new Set(scene.travellers.filter((tr) => t >= tr.start && t <= tr.end).map((tr) => tr.path));
  const scenePaths = new Set<PathId>([...scene.travellers.map((tr) => tr.path), ...scene.flashes.flatMap((f) => (f.at === "brain" ? [] : [f.at]))]);

  return (
    <div
      className={styles.tour}
    >
      <ol className={styles.steps} aria-label="How it works, in five steps">
        {SCENES.map((s, n) => (
          <li key={s.id}>
            <button
              type="button"
              className={`${styles.step} ${n === i ? styles.stepOn : ""}`}
              onClick={() => go(n)}
              aria-current={n === i ? "step" : undefined}
            >
              <span className={styles.bar} aria-hidden="true">
                <span className={styles.barFill} style={{ width: n < i ? "100%" : n === i ? `${(t / SCENE_MS) * 100}%` : "0%" }} />
              </span>
              <span className={styles.stepLabel}>{s.label}</span>
            </button>
          </li>
        ))}
      </ol>

      <p key={scene.id} className={styles.caption} aria-live="polite">
        {scene.caption}
      </p>

      <svg viewBox="0 20 900 350" className={styles.svg} role="img" aria-label={`Scene ${i + 1} of 5: ${scene.caption}`}>
        <defs>
          <radialGradient id="tourGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={TEAL} stopOpacity={0.35} />
            <stop offset="100%" stopColor={TEAL} stopOpacity={0} />
          </radialGradient>
        </defs>

        {/* lines */}
        {(Object.keys(ACTORS) as PathId[]).map((id) => (
          <path
            key={id}
            d={ACTORS[id].d}
            ref={(el) => {
              pathRefs.current[id] = el;
            }}
            className={`${styles.line} ${activePaths.has(id) ? styles.lineOn : ""}`}
            pathLength={100}
          />
        ))}

        {/* brain */}
        <g transform={`translate(${BRAIN[0]} ${BRAIN[1]})`}>
          <circle r={92} fill="url(#tourGlow)" className={`${styles.glow} ${brainBusy ? styles.glowOn : ""}`} />
          {flashes.some((f) => f.at === "brain") && (
            <circle key={`${scene.id}-ripple`} r={62} fill="none" stroke={TEAL} strokeWidth={2} className={styles.ripple} />
          )}
          <circle r={62} fill="#fff" stroke={brainBusy ? TEAL : "#dfe4ec"} strokeWidth={brainBusy ? 3 : 1.5} className={styles.brainRing} />
          {BRAIN_EDGES.map(([a, b]) => (
            <line
              key={`${a}-${b}`}
              x1={BRAIN_NODES[a][0]}
              y1={BRAIN_NODES[a][1]}
              x2={BRAIN_NODES[b][0]}
              y2={BRAIN_NODES[b][1]}
              stroke={NAVY}
              strokeOpacity={0.25}
              strokeWidth={1.4}
            />
          ))}
          {BRAIN_NODES.map(([x, y, r, c], k) => (
            <circle key={k} cx={x} cy={y} r={r} fill={c} className={styles.node} style={{ animationDelay: `${k * 0.3}s` }} />
          ))}
          <text y={84} fontSize={13} fontWeight={700} fill={NAVY} fontFamily="Urbanist, Inter, sans-serif" textAnchor="middle" letterSpacing="0.06em">
            THE BRAIN
          </text>
        </g>

        {/* people + agents */}
        {(Object.keys(ACTORS) as PathId[]).map((id) => {
          const a = ACTORS[id];
          const right = a.person[0] > BRAIN[0];
          return (
            <g key={id} className={`${styles.actor} ${scenePaths.has(id) ? styles.actorOn : ""}`}>
              <Person x={a.person[0]} y={a.person[1]} />
              <AgentChip x={a.agent[0]} y={a.agent[1]} color={a.color} />
              <text
                x={right ? a.person[0] + 26 : a.person[0] - 26}
                y={a.person[1] - 4}
                fontSize={14}
                fontWeight={700}
                fill={NAVY}
                fontFamily="Urbanist, Inter, sans-serif"
                textAnchor={right ? "start" : "end"}
              >
                {a.name}
              </text>
              <text
                x={right ? a.person[0] + 26 : a.person[0] - 26}
                y={a.person[1] + 13}
                fontSize={11}
                fill="#3f5175"
                fontFamily="Inter, sans-serif"
                textAnchor={right ? "start" : "end"}
              >
                {a.team}
              </text>
            </g>
          );
        })}

        {/* travellers */}
        {travellers.flatMap((tr) =>
          tr.trail.map(([x, y], k) => (
            <circle key={`${tr.key}-t${k}`} cx={x} cy={y} r={4.5 - k} fill={tr.color ?? TEAL} opacity={0.32 - k * 0.09} />
          )),
        )}
        {travellers.map((tr) => (
          <g key={tr.key} transform={`translate(${tr.x.toFixed(1)} ${tr.y.toFixed(1)}) scale(1.6)`} className={styles.traveller}>
            <GlyphShape glyph={tr.glyph} color={tr.color} />
          </g>
        ))}

        {/* flashes */}
        {flashes.map((f, k) => {
          const [x, y] = f.at === "brain" ? BRAIN : ACTORS[f.at].agent;
          return (
            <g key={`${scene.id}-f${k}`} transform={`translate(${x} ${y}) scale(1.35) translate(${-x} ${-y})`}>
              <FlashBadge kind={f.kind} x={x} y={y} />
            </g>
          );
        })}
      </svg>

    </div>
  );
}
