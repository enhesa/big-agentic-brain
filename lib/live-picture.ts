/**
 * The geometry and the words of the Live Brain picture (/live). Pure functions, no clock and no
 * DOM, so the page and its tests agree on where a dot sits and what a beat is called.
 */

export type Point = { x: number; y: number };

/** The drawing's own units. The brain sits in the middle. */
export const PICTURE = { width: 1280, height: 640 };
export const CORE = { x: 640, y: 320, r: 84 };

/** Up to this many dots stand on one ring. More take turns on an outer and an inner ring. */
export const ONE_RING_MAX = 12;

const TAU = Math.PI * 2;

/** Where dot number `index` of `total` sits: evenly around the brain, the first one at the top. */
export function dotPlace(index: number, total: number): Point {
  const angle = -Math.PI / 2 + (total > 0 ? index / total : 0) * TAU;
  const inner = total > ONE_RING_MAX && index % 2 === 1;
  const rx = total > ONE_RING_MAX ? (inner ? 360 : 540) : 470;
  const ry = total > ONE_RING_MAX ? (inner ? 168 : 262) : 232;
  return { x: CORE.x + Math.cos(angle) * rx, y: CORE.y + Math.sin(angle) * ry };
}

/** The point on the brain's edge that faces `from`. */
export function coreEdge(from: Point): Point {
  const dx = from.x - CORE.x;
  const dy = from.y - CORE.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: CORE.x + (dx / d) * CORE.r, y: CORE.y + (dy / d) * CORE.r };
}

/** A curve from one dot to another that bends away from the brain, as an SVG path. */
export function arcPath(from: Point, to: Point): string {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  let ox = mx - CORE.x;
  let oy = my - CORE.y;
  if (Math.hypot(ox, oy) < 40) {
    // Opposite dots: the middle is the brain itself, so bend sideways instead.
    ox = -(to.y - from.y);
    oy = to.x - from.x;
  }
  const d = Math.hypot(ox, oy) || 1;
  const bend = 0.28 * Math.hypot(to.x - from.x, to.y - from.y) + 30;
  const cx = mx + (ox / d) * bend;
  const cy = my + (oy / d) * bend;
  const n = (v: number) => Math.round(v * 10) / 10;
  return `M ${n(from.x)} ${n(from.y)} Q ${n(cx)} ${n(cy)} ${n(to.x)} ${n(to.y)}`;
}

/** A closed, smooth outline through the given corner points, as an SVG path. */
export function smoothClosed(points: Array<[number, number]>): string {
  const n = (v: number) => Math.round(v * 10) / 10;
  const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const last = points[points.length - 1];
  const start = mid(last, points[0]);
  let d = `M ${n(start[0])} ${n(start[1])}`;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const m = mid(p, points[(i + 1) % points.length]);
    d += ` Q ${n(p[0])} ${n(p[1])} ${n(m[0])} ${n(m[1])}`;
  }
  return `${d} Z`;
}

/**
 * The dots that stand lit: `awake` of `total`, spread evenly around the ring. A dot is a seat, not
 * a person, so which ones are lit says only how many people's agents are at work right now.
 */
export function litSeats(total: number, awake: number): number[] {
  const n = Math.max(0, Math.min(Math.floor(awake), total));
  return Array.from({ length: n }, (_, k) => Math.floor((k * total) / n));
}

function mix(n: number): number {
  let h = n >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The seat a beat's mark moves to or from, or -1 with no dots. Drawn by lot from the beat's id,
 * among the lit seats when there are any: the same beat always gets the same seat, and no seat
 * belongs to a person. The snapshot does not say who did a beat, so this cannot either.
 */
export function seatOf(beatId: number, total: number, awake: number): number {
  if (total <= 0) return -1;
  const lit = litSeats(total, awake);
  return lit.length > 0 ? lit[mix(beatId) % lit.length] : mix(beatId) % total;
}

/** A second seat for a message, never the first, or -1 with fewer than two dots. */
export function otherSeat(beatId: number, total: number, seat: number): number {
  if (total < 2 || seat < 0) return -1;
  return (seat + 1 + (mix(beatId ^ 0x9e3779b9) % (total - 1))) % total;
}

/** The count inside the brain. Short above 9,999, so it stays inside the brain on a phone. */
export function coreCount(n: number): string {
  if (n < 10_000) return n.toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export type BeatWord = "save" | "search" | "reuse" | "message" | "flag";

/** What a beat is called in the list under the picture. Nobody is named. */
export const BEAT_WORDS: Record<BeatWord, string> = {
  save: "An agent saved a memory",
  search: "An agent searched the brain",
  reuse: "An agent reused a memory",
  message: "An agent sent a message",
  flag: "An agent flagged a memory",
};
