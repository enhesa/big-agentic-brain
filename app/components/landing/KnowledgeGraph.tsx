"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../../landing.module.css";

const NAVY = "#1a3360";
const TEAL = "#00b0a1";
const AMBER = "#ffb700";
const CORAL = "#ff4423";

const VW = 440;
const VH = 420;

type Node = {
  /** Base position on the 440x420 grid. */
  x: number;
  y: number;
  r: number;
  c: string;
  label: string;
  /** Lissajous drift: amplitude, frequency and phase per axis. */
  ax: number;
  ay: number;
  fx: number;
  fy: number;
  ph: number;
};

/** Decorative only: 18 agents drifting around a brain silhouette. Nothing here is data. */
const NODES: Node[] = [
  { x: 150, y: 74, r: 11, c: NAVY, label: "memory", ax: 4, ay: 4, fx: 0.22, fy: 0.33, ph: 1.1 },
  { x: 216, y: 58, r: 6, c: AMBER, label: "tag", ax: 4, ay: 3, fx: 0.27, fy: 0.19, ph: 2.3 },
  { x: 286, y: 66, r: 8, c: CORAL, label: "flag", ax: 4, ay: 4, fx: 0.18, fy: 0.29, ph: 3.0 },
  { x: 346, y: 96, r: 6, c: TEAL, label: "agent", ax: 4, ay: 3, fx: 0.25, fy: 0.21, ph: 0.7 },
  { x: 384, y: 148, r: 7, c: AMBER, label: "due", ax: 3, ay: 4, fx: 0.28, fy: 0.22, ph: 2.9 },
  { x: 372, y: 204, r: 6, c: NAVY, label: "repo", ax: 4, ay: 3, fx: 0.2, fy: 0.31, ph: 1.9 },
  { x: 318, y: 240, r: 7, c: AMBER, label: "thread", ax: 4, ay: 4, fx: 0.26, fy: 0.24, ph: 3.3 },
  { x: 252, y: 258, r: 9, c: TEAL, label: "colleague", ax: 3, ay: 4, fx: 0.19, fy: 0.25, ph: 1.5 },
  { x: 186, y: 268, r: 6, c: TEAL, label: "search", ax: 4, ay: 4, fx: 0.3, fy: 0.2, ph: 2.1 },
  { x: 150, y: 300, r: 6, c: NAVY, label: "audit", ax: 3, ay: 4, fx: 0.32, fy: 0.21, ph: 3.6 },
  { x: 142, y: 340, r: 7, c: CORAL, label: "vote", ax: 3, ay: 3, fx: 0.21, fy: 0.3, ph: 0.6 },
  { x: 84, y: 286, r: 8, c: NAVY, label: "team", ax: 4, ay: 4, fx: 0.23, fy: 0.27, ph: 0.9 },
  { x: 62, y: 222, r: 6, c: CORAL, label: "note", ax: 4, ay: 4, fx: 0.29, fy: 0.23, ph: 1.7 },
  { x: 78, y: 142, r: 7, c: TEAL, label: "agent", ax: 4, ay: 4, fx: 0.31, fy: 0.24, ph: 0.2 },
  { x: 160, y: 140, r: 12, c: NAVY, label: "message", ax: 3, ay: 3, fx: 0.17, fy: 0.28, ph: 1.3 },
  { x: 232, y: 118, r: 13, c: TEAL, label: "you", ax: 3, ay: 3, fx: 0.16, fy: 0.26, ph: 2.6 },
  { x: 300, y: 152, r: 9, c: AMBER, label: "reminder", ax: 3, ay: 3, fx: 0.24, fy: 0.18, ph: 0.4 },
  { x: 238, y: 196, r: 6, c: TEAL, label: "agent", ax: 4, ay: 3, fx: 0.27, fy: 0.23, ph: 2.5 },
];

const EDGES: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 10],
  [9, 11],
  [11, 12],
  [12, 13],
  [13, 0],
  [13, 14],
  [14, 15],
  [15, 16],
  [16, 4],
  [14, 17],
  [17, 16],
  [8, 11],
];

/** Edge index, speed and starting offset for each travelling particle. */
const PARTICLES = [
  { e: 2, s: 0.22, t: 0.0, c: TEAL },
  { e: 6, s: 0.18, t: 0.35, c: AMBER },
  { e: 11, s: 0.26, t: 0.6, c: TEAL },
  { e: 14, s: 0.16, t: 0.15, c: AMBER },
  { e: 18, s: 0.2, t: 0.8, c: TEAL },
];

/** Order in which nodes get the simulated hover; hops around the canvas. */
const SPOTLIGHT = [15, 7, 0, 11, 16, 2, 9, 14, 4, 12, 6, 1, 17, 10, 3, 8, 5, 13];

export default function KnowledgeGraph() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<SVGGElement | null>(null);
  const nodeRefs = useRef<(SVGCircleElement | null)[]>([]);
  const haloRefs = useRef<(SVGCircleElement | null)[]>([]);
  const labelRefs = useRef<(SVGTextElement | null)[]>([]);
  const edgeRefs = useRef<(SVGLineElement | null)[]>([]);
  const partRefs = useRef<(SVGCircleElement | null)[]>([]);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let t0 = 0;
    const px = new Float32Array(NODES.length);
    const py = new Float32Array(NODES.length);
    const progress = PARTICLES.map((p) => p.t);

    const frame = (now: number) => {
      if (!t0) t0 = now;
      const t = (now - t0) / 1000;

      for (let i = 0; i < NODES.length; i += 1) {
        const n = NODES[i];
        px[i] = n.x + n.ax * Math.sin(n.fx * 2 * Math.PI * 0.16 * t * 6 + n.ph);
        py[i] = n.y + n.ay * Math.cos(n.fy * 2 * Math.PI * 0.16 * t * 6 + n.ph);
        const c = nodeRefs.current[i];
        if (c) {
          c.setAttribute("cx", px[i].toFixed(2));
          c.setAttribute("cy", py[i].toFixed(2));
        }
        const h = haloRefs.current[i];
        if (h) {
          h.setAttribute("cx", px[i].toFixed(2));
          h.setAttribute("cy", py[i].toFixed(2));
        }
        const l = labelRefs.current[i];
        if (l) {
          l.setAttribute("x", px[i].toFixed(2));
          l.setAttribute("y", (py[i] + NODES[i].r + 16).toFixed(2));
        }
      }

      for (let i = 0; i < EDGES.length; i += 1) {
        const [a, b] = EDGES[i];
        const line = edgeRefs.current[i];
        if (!line) continue;
        line.setAttribute("x1", px[a].toFixed(2));
        line.setAttribute("y1", py[a].toFixed(2));
        line.setAttribute("x2", px[b].toFixed(2));
        line.setAttribute("y2", py[b].toFixed(2));
      }

      for (let i = 0; i < PARTICLES.length; i += 1) {
        const p = PARTICLES[i];
        progress[i] = (progress[i] + p.s * 0.016) % 1;
        const [a, b] = EDGES[p.e];
        const k = progress[i];
        const dot = partRefs.current[i];
        if (!dot) continue;
        dot.setAttribute("cx", (px[a] + (px[b] - px[a]) * k).toFixed(2));
        dot.setAttribute("cy", (py[a] + (py[b] - py[a]) * k).toFixed(2));
        const fade = Math.sin(k * Math.PI);
        dot.setAttribute("opacity", (0.25 + 0.75 * fade).toFixed(3));
      }

      raf = window.requestAnimationFrame(frame);
    };

    const start = () => {
      if (!raf) {
        t0 = 0;
        raf = window.requestAnimationFrame(frame);
      }
    };
    const stop = () => {
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Simulated hover: nodes take turns lighting up (grow + halo + label), no
  // real pointer interaction. Order is spread across the canvas so the eye
  // wanders rather than sweeping.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let timer = 0;
    let step = 0;
    const HOLD = 1600;
    const GAP = 350;

    const next = () => {
      const i = SPOTLIGHT[step % SPOTLIGHT.length];
      step += 1;
      setActive(i);
      timer = window.setTimeout(() => {
        setActive(-1);
        timer = window.setTimeout(next, GAP);
      }, HOLD);
    };

    const stop = () => {
      window.clearTimeout(timer);
      timer = 0;
      setActive(-1);
    };
    const start = () => {
      if (!timer) timer = window.setTimeout(next, GAP);
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div ref={wrapRef} className={styles.graphPanel}>
      <svg
        className={styles.graph}
        viewBox={`0 0 ${VW} ${VH}`}
        role="img"
        aria-label="A living network of agents sharing memories, reminders and messages"
      >
        <defs>
          <filter id="babGlow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g ref={panRef} className={styles.graphPan}>
          {EDGES.map(([a, b], i) => (
            <line
              key={`e${a}-${b}`}
              ref={(el) => {
                edgeRefs.current[i] = el;
              }}
              className={styles.gedge}
              x1={NODES[a].x}
              y1={NODES[a].y}
              x2={NODES[b].x}
              y2={NODES[b].y}
            />
          ))}

          {PARTICLES.map((p, i) => {
            const [a, b] = EDGES[p.e];
            return (
              <circle
                key={`p${i}`}
                ref={(el) => {
                  partRefs.current[i] = el;
                }}
                className={styles.gparticle}
                cx={NODES[a].x + (NODES[b].x - NODES[a].x) * p.t}
                cy={NODES[a].y + (NODES[b].y - NODES[a].y) * p.t}
                r={3.2}
                fill={p.c}
                filter="url(#babGlow)"
              />
            );
          })}

          {NODES.map((n, i) => (
            <circle
              key={`h${i}`}
              ref={(el) => {
                haloRefs.current[i] = el;
              }}
              className={`${styles.ghalo} ${active === i ? styles.ghaloOn : ""}`}
              cx={n.x}
              cy={n.y}
              r={n.r + 9}
              fill={n.c}
            />
          ))}

          {NODES.map((n, i) => (
            <circle
              key={`n${i}`}
              ref={(el) => {
                nodeRefs.current[i] = el;
              }}
              className={`${styles.gnode} ${active === i ? styles.gnodeOn : ""}`}
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill={n.c}
            />
          ))}

          {NODES.map((n, i) => (
            <text
              key={`l${i}`}
              ref={(el) => {
                labelRefs.current[i] = el;
              }}
              className={`${styles.glabel} ${active === i ? styles.glabelOn : ""}`}
              x={n.x}
              y={n.y + n.r + 16}
              textAnchor="middle"
            >
              {n.label}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}
