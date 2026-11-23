/*
 * The showcase film's story: its size, colours, timing, words, figures and shapes.
 *
 * Two things draw from it, so they cannot drift apart:
 *   showcase/film.js                        draws it on a canvas, for the video
 *   app/components/landing/FilmSvg.tsx      draws it as an animated SVG, for the landing page
 *
 * Everything here is plain data or a pure function: no clock, no random numbers, no DOM.
 * After a change, render the video again: node showcase/render.mjs
 */

export const FILM = { width: 1280, height: 720, fps: 30, seconds: 45 };

export const COLORS = {
  paper: "#fafaf7",
  ink: "#1a3360",
  steel: "#3f5175",
  teal: "#00b0a1",
  amber: "#ffb700",
  coral: "#ff4423",
  sage: "#aedad4",
  sand: "#f0f0eb",
};

/** Scene by scene, in seconds. Neighbours overlap by 0.4 seconds to cross-fade. */
export const SCENES = [
  { id: "alone", start: 0, end: 5.7 },
  { id: "again", start: 5.3, end: 11.7 },
  { id: "learns", start: 11.3, end: 18.3 },
  { id: "knows", start: 17.9, end: 25.1 },
  { id: "holds", start: 24.7, end: 33.3 },
  { id: "measured", start: 32.9, end: 39.3 },
  { id: "name", start: 38.9, end: FILM.seconds + 1 },
];

/** The words on screen. */
export const WORDS = {
  alone: "Every agent starts from zero.",
  again: "The same problem, solved again. And again.",
  learns: "One agent learns.",
  knows: "The whole swarm knows.",
  holds: "One place for what agents know, say and do.",
  measured: {
    eyebrow: "MEASURED",
    title: ["Bugs that need", "team knowledge,", "fixed."],
    note: ["Claude Sonnet 5.5, 24 runs per bar.", "Details and caveats in the README."],
  },
  name: {
    title: "Big Agentic Brain",
    line: "One brain. Every agent.",
    facts: ["Open source", "Self-hosted", "One container"],
  },
};

/** What BAB holds: five small machines, one after another. */
export const HOLDS = ["Memory", "Messages", "Reminders", "Files", "Tasks"].map((name, i) => ({
  name,
  x: 160 + i * 240,
  begin: 0.5 + i * 1.25,
}));

/** The measured result. The shares repeat the README's figures: change both together. */
export const MEASURED = {
  base: 520,
  full: 370,
  bars: [
    { x: 760, share: 0.12, color: "steel", label: "without BAB", at: 0.9 },
    { x: 980, share: 0.79, color: "teal", label: "with BAB", at: 1.7 },
  ],
};

/** The three dots of the mark: where each rests and where it flies in from. */
export const MARK = [
  { x: 640, y: 168, from: [640, -60] },
  { x: 580, y: 282, from: [-60, 420] },
  { x: 700, y: 282, from: [1340, 420] },
];

/* ---------- maths ---------- */

export const TAU = Math.PI * 2;
export const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const lerp = (a, b, k) => a + (b - a) * k;
export const prog = (t, a, b) => clamp01((t - a) / (b - a));

export function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- shapes ---------- */

/** The corner points of a closed, slightly uneven shape, like a paper cut-out. */
export function blobPoints(cx, cy, rx, ry, seed, boil, amount = 0.06, n = 9) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const still = hash(seed * 17 + i * 3.1) - 0.5;
    const moving = hash(seed * 29 + i * 5.3 + boil * 0.731) - 0.5;
    const k = 1 + amount * 2 * (0.7 * still + 0.3 * moving);
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return pts;
}

/* The problem every agent meets: a tangle, and the short way through it. */

export const PATH_POINTS = 220;

export function tangle(seed) {
  const pts = [];
  for (let i = 0; i <= PATH_POINTS; i++) {
    const u = i / PATH_POINTS;
    const env = Math.sin(Math.PI * u);
    const a = u * TAU * 3.5 + seed;
    pts.push([
      u + 0.15 * env * Math.sin(a) + 0.06 * env * Math.sin(a * 2.3 + 1.3),
      0.3 * env * Math.cos(a + 0.6) + 0.11 * env * Math.sin(a * 1.7),
    ]);
  }
  return pts;
}

export function shortcut() {
  const pts = [];
  for (let i = 0; i <= PATH_POINTS; i++) {
    const u = i / PATH_POINTS;
    pts.push([u, -0.09 * Math.sin(Math.PI * u)]);
  }
  return pts;
}

export const TANGLE = tangle(0.4);
export const SHORT = shortcut();

/** Twelve agents, each with its own tangle, a place on the grid and a moment to start. */
export const GRID = Array.from({ length: 12 }, (_, i) => ({
  points: tangle(0.4 + hash(i + 1) * 0.5),
  ox: 110 + (i % 4) * 282,
  oy: 112 + Math.floor(i / 4) * 172,
  begin: 0.35 + hash(i * 7 + 2) * 1.3,
  odd: i === 5,
}));

/** Where the one big tangle sits in the frame. */
export const BIG = (x, y) => [180 + x * 920, 300 + y * 430];

/** The brain. */
export const HUB = { x: 640, y: 300, r: 84 };

/** The twelve agents around the brain. */
export const SWARM = (() => {
  const random = mulberry32(7);
  const out = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + (random() - 0.5) * 0.25 - Math.PI / 2;
    const reach = 0.82 + random() * 0.3;
    out.push({ x: HUB.x + Math.cos(a) * 440 * reach, y: HUB.y + Math.sin(a) * 205 * reach, reach, a });
  }
  return out;
})();

/** When the first ring of knowledge passes an agent, in seconds into its scene. */
export const litAt = (agent) => 0.9 + 2.6 * (1 - Math.cbrt(1 - clamp01((agent.reach - 0.2) / 1.25)));
