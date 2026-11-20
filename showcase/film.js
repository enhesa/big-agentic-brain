"use strict";
/*
 * The BAB showcase film: 45 seconds, 1280x720, 30 frames a second.
 *
 * Every frame is a pure function of its number: no wall clock and no Math.random, so
 * `node showcase/render.mjs` produces the same video every time. Open index.html in a browser
 * (through any static server at the repository root) to watch it play live.
 *
 * Story: one agent alone, many agents solving the same problem, one agent learns, the whole
 * swarm knows, what BAB holds, the measured result, the name.
 */

const W = 1280;
const H = 720;
const FPS = 30;
const SECONDS = 45;
const FRAMES = FPS * SECONDS;
const TAU = Math.PI * 2;

const C = {
  paper: "#f5f2ea",
  ink: "#1a3360",
  steel: "#3f5175",
  teal: "#00b0a1",
  amber: "#ffb700",
  coral: "#ff4423",
  sage: "#aedad4",
  sand: "#e9e3d3",
};

const HEAD = '"Urbanist", system-ui, sans-serif';
const BODY = '"Inter", system-ui, sans-serif';

const canvas = document.getElementById("film");
const ctx = canvas.getContext("2d");

/* ---------- maths ---------- */

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, k) => a + (b - a) * k;
const prog = (t, a, b) => clamp01((t - a) / (b - a));
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOutBack = (k) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
};

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(hexA, hexB, k) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const ch = (shift) => Math.round(lerp((a >> shift) & 255, (b >> shift) & 255, k));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

/* ---------- drawing ---------- */

/** A closed, slightly uneven shape, like a paper cut-out. `boil` steps a few times a second. */
function blob(cx, cy, rx, ry, seed, boil, amount = 0.06, n = 9) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const still = hash(seed * 17 + i * 3.1) - 0.5;
    const moving = hash(seed * 29 + i * 5.3 + boil * 0.731) - 0.5;
    const k = 1 + amount * 2 * (0.7 * still + 0.3 * moving);
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % n];
    if (i === 0) {
      const last = pts[n - 1];
      ctx.moveTo((last[0] + p0[0]) / 2, (last[1] + p0[1]) / 2);
    }
    ctx.quadraticCurveTo(p0[0], p0[1], (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
  }
  ctx.closePath();
}

function fillBlob(cx, cy, rx, ry, seed, boil, color, amount, n) {
  blob(cx, cy, rx, ry, seed, boil, amount, n);
  ctx.fillStyle = color;
  ctx.fill();
}

function dot(x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, TAU);
  ctx.fillStyle = color;
  ctx.fill();
}

function ring(x, y, r, color, width) {
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, TAU);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function line(x0, y0, x1, y1, color, width) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** The point at fraction p along a list of points, after `map`. */
function pointAt(pts, p, map) {
  const n = pts.length - 1;
  const f = clamp01(p) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const k = f - i;
  return map(lerp(pts[i][0], pts[i + 1][0], k), lerp(pts[i][1], pts[i + 1][1], k));
}

/** Strokes the part of a path between two fractions, with a slight hand-drawn wobble. */
function strokePath(pts, from, to, map, color, width, boil) {
  const n = pts.length - 1;
  const a = clamp01(from) * n;
  const b = clamp01(to) * n;
  if (b - a < 0.001) return;
  const wobble = (f, xy) => [
    xy[0] + Math.sin(f * 0.21 + boil * 1.7) * 0.9,
    xy[1] + Math.cos(f * 0.17 + boil * 2.3) * 0.9,
  ];
  ctx.beginPath();
  const start = wobble(a, pointAt(pts, a / n, map));
  ctx.moveTo(start[0], start[1]);
  for (let i = Math.floor(a) + 1; i < b; i++) {
    const p = wobble(i, map(pts[i][0], pts[i][1]));
    ctx.lineTo(p[0], p[1]);
  }
  const end = wobble(b, pointAt(pts, b / n, map));
  ctx.lineTo(end[0], end[1]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/**
 * Words that rise into place one after another. `t` is seconds since the text starts.
 * Returns nothing; the caller owns ctx.globalAlpha as the scene's opacity.
 */
function say(lines, x, y, t, o = {}) {
  let size = o.size ?? 60;
  const weight = o.weight ?? 800;
  const family = o.family ?? HEAD;
  const stagger = o.stagger ?? 0.09;
  const base = ctx.globalAlpha;
  ctx.letterSpacing = o.spacing ?? "0px";
  ctx.font = `${weight} ${size}px ${family}`;
  // Never run off the frame: shrink the type until the widest line fits.
  const widest = Math.max(...lines.map((text) => ctx.measureText(text).width));
  const room = o.align === "center" ? W - 160 : W - x - 80;
  if (widest > room) {
    size *= room / widest;
    ctx.font = `${weight} ${size}px ${family}`;
  }
  const lh = o.lh ?? size * 1.12;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = o.color ?? C.ink;
  const space = ctx.measureText(" ").width;
  let index = 0;
  lines.forEach((text, row) => {
    const words = text.split(" ");
    const total = ctx.measureText(text).width;
    let cx = o.align === "center" ? x - total / 2 : x;
    for (const word of words) {
      const p = easeOut(clamp01((t - index * stagger) / 0.5));
      if (p > 0) {
        ctx.globalAlpha = base * p;
        ctx.fillText(word, cx, y + row * lh + (1 - p) * 18);
      }
      cx += ctx.measureText(word).width + space;
      index++;
    }
  });
  ctx.globalAlpha = base;
  ctx.letterSpacing = "0px";
}

/* ---------- the problem every agent meets: a tangle, and the short way through it ---------- */

const PATH_POINTS = 220;

function tangle(seed) {
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

function shortcut() {
  const pts = [];
  for (let i = 0; i <= PATH_POINTS; i++) {
    const u = i / PATH_POINTS;
    pts.push([u, -0.09 * Math.sin(Math.PI * u)]);
  }
  return pts;
}

const TANGLE = tangle(0.4);
const SHORT = shortcut();
const GRID_TANGLES = Array.from({ length: 12 }, (_, i) => tangle(0.4 + hash(i + 1) * 0.5));

const BIG = (x, y) => [180 + x * 920, 300 + y * 430];
const HUB = { x: 640, y: 300, r: 84 };

const SWARM = (() => {
  const random = mulberry32(7);
  const out = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + (random() - 0.5) * 0.25 - Math.PI / 2;
    const reach = 0.82 + random() * 0.3;
    out.push({ x: HUB.x + Math.cos(a) * 440 * reach, y: HUB.y + Math.sin(a) * 205 * reach, reach, a });
  }
  return out;
})();

/* ---------- scenes ---------- */

/** Scene opacity: fades in over `fade` seconds after start and out before end. */
function presence(t, start, end, fade = 0.45) {
  return Math.min(prog(t, start, start + fade), 1 - prog(t, end - fade, end));
}

/** Still on purpose: a backdrop that never moves keeps the README copy small. */
function backdrop() {
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.55;
  fillBlob(1130, 640, 330, 250, 3, 0, C.sand, 0.12, 9);
  ctx.globalAlpha = 0.5;
  fillBlob(110, 70, 250, 190, 5, 0, C.sand, 0.14, 8);
}

/** 1. One agent, one tangle. */
function sceneAlone(t, alpha, boil) {
  ctx.globalAlpha = alpha;
  const p = easeInOut(prog(t, 0.7, 4.9));
  ring(...BIG(1, 0), 13, C.steel, 3);
  strokePath(TANGLE, 0, p, BIG, C.ink, 4, boil);
  const head = pointAt(TANGLE, p, BIG);
  dot(head[0], head[1], 12 * easeOutBack(prog(t, 0.15, 0.7)), C.coral);
  say(["Every agent starts from zero."], 96, 632, t - 0.5);
}

/** 2. Twelve agents, the same tangle, twelve times. */
function sceneAgain(t, alpha, boil) {
  ctx.globalAlpha = alpha;
  for (let i = 0; i < 12; i++) {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const ox = 110 + col * 282;
    const oy = 112 + row * 172;
    const map = (x, y) => [ox + x * 200, oy + y * 142];
    const begin = 0.35 + hash(i * 7 + 2) * 1.3;
    const p = easeInOut(prog(t, begin, begin + 3.4));
    ctx.globalAlpha = alpha * prog(t, begin - 0.3, begin);
    ring(...map(1, 0), 7, C.steel, 2.5);
    strokePath(GRID_TANGLES[i], 0, p, map, C.steel, 3, boil + i);
    const head = pointAt(GRID_TANGLES[i], p, map);
    dot(head[0], head[1], 8, i === 5 ? C.coral : C.ink);
  }
  ctx.globalAlpha = alpha;
  say(["The same problem, solved again. And again."], 96, 632, t - 0.6);
}

/** 3. One agent's tangle straightens into the answer, and the answer becomes the brain. */
function sceneLearns(t, alpha, boil) {
  ctx.globalAlpha = alpha;
  const straighten = easeInOut(prog(t, 1.3, 3.0));
  const gather = easeInOut(prog(t, 3.2, 4.5));
  const pts = TANGLE.map((p, i) => [lerp(p[0], SHORT[i][0], straighten), lerp(p[1], SHORT[i][1], straighten)]);
  const map = (x, y) => {
    const [px, py] = BIG(x, y);
    return [lerp(px, HUB.x, gather), lerp(py, HUB.y, gather)];
  };
  const color = mix(C.ink, C.teal, straighten);
  if (gather < 1) {
    ctx.globalAlpha = alpha * (1 - prog(t, 4.2, 4.5));
    ring(...map(1, 0), 13 * (1 - gather), C.steel, 3);
    strokePath(pts, 0, 1, map, color, lerp(4, 9, gather), boil);
    const head = pointAt(pts, 1, map);
    dot(head[0], head[1], 12 * (1 - gather), C.coral);
  }
  ctx.globalAlpha = alpha;
  const grow = easeOutBack(prog(t, 3.9, 4.9));
  if (grow > 0) {
    const breathe = 1 + Math.sin(t * 2.4) * 0.025;
    fillBlob(HUB.x, HUB.y, HUB.r * grow * breathe, HUB.r * grow * breathe, 11, boil, C.teal, 0.07, 10);
  }
  say(["One agent learns."], 96, 632, t - 0.5);
}

/** 4. The answer reaches every other agent. */
function sceneKnows(t, alpha, boil) {
  ctx.globalAlpha = alpha;
  // Night spreads from the brain until it fills the frame, so the knowledge reads as light.
  const night = easeInOut(prog(t, 0, 0.9));
  fillBlob(HUB.x, HUB.y, 60 + 900 * night, 60 + 900 * night, 13, 0, C.ink, 0.04, 12);
  for (let k = 0; k < 3; k++) {
    const life = prog(t, 0.9 + k * 0.55, 3.5 + k * 0.55);
    if (life <= 0 || life >= 1) continue;
    const rho = lerp(0.2, 1.45, easeOut(life));
    ctx.globalAlpha = alpha * (1 - life) * 0.9;
    blob(HUB.x, HUB.y, 440 * rho, 205 * rho, 40 + k, boil, 0.025, 14);
    ctx.strokeStyle = C.sage;
    ctx.lineWidth = 6;
    ctx.stroke();
  }
  SWARM.forEach((agent, i) => {
    const arrive = easeOutBack(prog(t, 0.15 + i * 0.05, 0.6 + i * 0.05));
    // The first ring passes an agent when its eased radius reaches the agent's distance.
    const hitAt = 0.9 + 2.6 * (1 - Math.cbrt(1 - clamp01((agent.reach - 0.2) / 1.25)));
    const lit = prog(t, hitAt, hitAt + 0.45);
    const bob = Math.sin(t * 1.8 + i) * 3 * lit;
    const x = agent.x;
    const y = agent.y + bob;
    if (lit > 0) {
      const from = [HUB.x + Math.cos(agent.a) * HUB.r * 1.6, HUB.y + Math.sin(agent.a) * HUB.r * 1.15];
      const k = easeOut(lit);
      ctx.globalAlpha = alpha * 0.7;
      line(from[0], from[1], lerp(from[0], x, k), lerp(from[1], y, k), C.teal, 3);
    }
    ctx.globalAlpha = alpha;
    const pop = 1 + Math.sin(Math.PI * lit) * 0.5;
    dot(x, y, 12 * arrive * pop, lit > 0 ? mix(C.paper, C.amber, lit) : C.paper);
  });
  ctx.globalAlpha = alpha;
  const breathe = 1 + Math.sin(t * 2.4 + 1) * 0.03;
  fillBlob(HUB.x, HUB.y, HUB.r * breathe, HUB.r * breathe, 11, boil, C.teal, 0.07, 10);
  say(["The whole swarm knows."], 96, 632, t - 0.9, { color: C.paper });
}

/** 5. What BAB holds, as five small machines. */
const HOLDS = ["Memory", "Messages", "Reminders", "Files", "Tasks"];

function glyph(i, x, y, g, boil) {
  if (i === 0) {
    fillBlob(x, y, 50, 46, 21, boil, C.teal, 0.08, 9);
    for (let k = 0; k < 3; k++) {
      const p = easeOut(prog(g, 0.25 + k * 0.18, 0.7 + k * 0.18));
      if (p > 0) line(x - 22, y - 14 + k * 14, x - 22 + [44, 34, 22][k] * p, y - 14 + k * 14, C.paper, 5);
    }
  } else if (i === 1) {
    const there = easeInOut(prog(g, 0.25, 0.95));
    const back = easeInOut(prog(g, 1.1, 1.8));
    dot(x - 40, y + 6, 14, C.ink);
    dot(x + 40, y + 6, 14, C.coral);
    const arc = (k, up) => [x - 40 + 80 * k, y + 6 - Math.sin(Math.PI * k) * 44 * up];
    ctx.beginPath();
    for (let k = 0; k <= there; k += 0.04) ctx.lineTo(...arc(k, 1));
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    for (let k = 0; k <= back; k += 0.04) ctx.lineTo(...arc(1 - k, -0.75));
    ctx.strokeStyle = C.coral;
    ctx.stroke();
    if (there > 0 && there < 1) dot(...arc(there, 1), 6, C.ink);
    if (back > 0 && back < 1) dot(...arc(1 - back, -0.75), 6, C.coral);
  } else if (i === 2) {
    ring(x, y, 42, C.amber, 9);
    const sweep = easeInOut(prog(g, 0.2, 1.5)) * TAU - Math.PI / 2;
    line(x, y, x + Math.cos(sweep) * 26, y + Math.sin(sweep) * 26, C.ink, 6);
    dot(x, y, 6, C.ink);
    dot(x + 36, y - 38, 11 * easeOutBack(prog(g, 1.45, 1.85)), C.coral);
  } else if (i === 3) {
    const slide = easeOut(prog(g, 0.2, 0.9));
    ctx.fillStyle = C.sage;
    roundRect(x - 34 - 14 * slide, y - 42 + 8 * slide, 62, 78, 10);
    ctx.fill();
    ctx.fillStyle = C.ink;
    roundRect(x - 28 + 10 * slide, y - 42 - 4 * slide, 62, 78, 10);
    ctx.fill();
    for (let k = 0; k < 3; k++) {
      const p = easeOut(prog(g, 0.6 + k * 0.15, 1.0 + k * 0.15));
      const lx = x - 16 + 10 * slide;
      const ly = y - 20 - 4 * slide + k * 16;
      if (p > 0) line(lx, ly, lx + [38, 38, 22][k] * p, ly, C.paper, 4);
    }
  } else {
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = C.sand;
      roundRect(x - 55 + k * 38, y - 44, 32, 88, 9);
      ctx.fill();
    }
    const hop = easeInOut(prog(g, 0.3, 0.85)) + easeInOut(prog(g, 1.05, 1.6));
    ctx.fillStyle = hop >= 2 ? C.teal : C.ink;
    roundRect(x - 51 + hop * 38, y - 38 + hop * 14, 24, 24, 6);
    ctx.fill();
    ctx.fillStyle = C.steel;
    roundRect(x - 51, y + 8, 24, 14, 5);
    ctx.fill();
    roundRect(x - 13, y - 8, 24, 14, 5);
    ctx.fill();
  }
}

function sceneHolds(t, alpha, boil) {
  HOLDS.forEach((name, i) => {
    const x = 160 + i * 240;
    const begin = 0.5 + i * 1.25;
    const g = t - begin;
    if (g <= 0) return;
    const pop = easeOutBack(prog(g, 0, 0.45));
    ctx.save();
    ctx.globalAlpha = alpha * prog(g, 0, 0.2);
    ctx.translate(x, 280);
    ctx.scale(pop * 1.5, pop * 1.5);
    glyph(i, 0, 0, g, boil);
    ctx.restore();
    ctx.globalAlpha = alpha;
    say([name], x, 436, g - 0.2, { size: 32, weight: 700, align: "center" });
  });
  ctx.globalAlpha = alpha;
  say(["One place for what agents know, say and do."], 96, 632, t - 0.4);
}

/** 6. The measured result, with the README's own wording. */
function sceneMeasured(t, alpha, boil) {
  ctx.globalAlpha = alpha;
  const base = 520;
  const full = 370;
  const bars = [
    { x: 760, share: 0.12, color: C.steel, label: "without BAB", at: 0.9 },
    { x: 980, share: 0.79, color: C.teal, label: "with BAB", at: 1.7 },
  ];
  line(700, base, 1180, base, C.ink, 3);
  for (const bar of bars) {
    const grow = easeOut(prog(t, bar.at, bar.at + 1.3));
    const h = full * bar.share * grow;
    if (h > 1) {
      ctx.fillStyle = bar.color;
      roundRect(bar.x - 70, base - h, 140, h, [16, 16, 0, 0]);
      ctx.fill();
    }
    const shown = Math.round(bar.share * 100 * grow);
    ctx.globalAlpha = alpha * prog(t, bar.at, bar.at + 0.3);
    ctx.font = `800 68px ${HEAD}`;
    ctx.textAlign = "center";
    ctx.fillStyle = C.ink;
    ctx.fillText(`${shown}%`, bar.x, base - h - 18);
    ctx.font = `500 22px ${BODY}`;
    ctx.fillStyle = C.steel;
    ctx.fillText(bar.label, bar.x, base + 38);
    ctx.textAlign = "left";
    ctx.globalAlpha = alpha;
  }
  say(["MEASURED"], 96, 236, t - 0.3, { size: 18, weight: 600, family: BODY, color: C.teal, spacing: "4px" });
  say(["Bugs that need", "team knowledge,", "fixed."], 96, 310, t - 0.5, { size: 60 });
  say(["Claude Sonnet 5.5, 24 runs per bar.", "Details and caveats in the README."], 96, 520, t - 2.2, {
    size: 20,
    weight: 400,
    family: BODY,
    color: C.steel,
    lh: 30,
    stagger: 0.03,
  });
}

/** 7. Three agents join into the mark, and the name. */
function sceneName(t, alpha) {
  ctx.globalAlpha = alpha;
  const mark = [
    { x: 640, y: 168, from: [640, -60] },
    { x: 580, y: 282, from: [-60, 420] },
    { x: 700, y: 282, from: [1340, 420] },
  ];
  const at = mark.map((m, i) => {
    const k = easeOut(prog(t, 0.2 + i * 0.12, 1.2 + i * 0.12));
    return [lerp(m.from[0], m.x, k), lerp(m.from[1], m.y, k)];
  });
  const join = easeInOut(prog(t, 1.2, 2.0));
  if (join > 0) {
    const edges = [
      [0, 1],
      [0, 2],
      [1, 2],
    ];
    for (const [a, b] of edges) {
      line(at[a][0], at[a][1], lerp(at[a][0], at[b][0], join), lerp(at[a][1], at[b][1], join), C.teal, 20);
    }
  }
  for (const p of at) dot(p[0], p[1], 30, C.teal);
  say(["Big Agentic Brain"], 640, 424, t - 1.6, { size: 84, align: "center" });
  say(["One brain. Every agent."], 640, 486, t - 2.3, { size: 36, weight: 700, color: C.teal, align: "center" });
  say(["Open source  ·  Self-hosted  ·  One container"], 640, 560, t - 3.0, {
    size: 22,
    weight: 400,
    family: BODY,
    color: C.steel,
    align: "center",
    stagger: 0.05,
  });
}

/* ---------- timeline ---------- */

const SCENES = [
  { start: 0, end: 5.7, draw: sceneAlone },
  { start: 5.3, end: 11.7, draw: sceneAgain },
  { start: 11.3, end: 18.3, draw: sceneLearns },
  { start: 17.9, end: 25.1, draw: sceneKnows },
  { start: 24.7, end: 33.3, draw: sceneHolds },
  { start: 32.9, end: 39.3, draw: sceneMeasured },
  { start: 38.9, end: SECONDS + 1, draw: sceneName },
];

function renderFrame(frame) {
  const t = frame / FPS;
  const boil = Math.floor(frame / 4);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.textAlign = "left";
  backdrop();
  for (const scene of SCENES) {
    if (t < scene.start || t >= scene.end) continue;
    const alpha = presence(t, scene.start, scene.end);
    if (alpha <= 0) continue;
    ctx.save();
    scene.draw(t - scene.start, alpha, boil);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

window.film = { width: W, height: H, fps: FPS, frames: FRAMES };
window.renderFrame = renderFrame;
window.filmReady = Promise.all([
  document.fonts.load(`800 60px "Urbanist"`),
  document.fonts.load(`700 30px "Urbanist"`),
  document.fonts.load(`400 20px "Inter"`),
  document.fonts.load(`600 18px "Inter"`),
]).then(() => true);

// Watching in a browser: play in real time and loop. The renderer passes ?render=1 and drives frames itself.
if (!new URLSearchParams(location.search).has("render")) {
  window.filmReady.then(() => {
    const began = performance.now();
    const tick = (now) => {
      renderFrame(Math.floor(((now - began) / 1000) * FPS) % FRAMES);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
