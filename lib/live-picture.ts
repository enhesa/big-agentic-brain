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
  // Rounded: the server and the browser do not agree on the last digit of a sine, and the page
  // must draw the same picture on both.
  return { x: Math.round((CORE.x + Math.cos(angle) * rx) * 100) / 100, y: Math.round((CORE.y + Math.sin(angle) * ry) * 100) / 100 };
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

function mix(n: number): number {
  let h = n >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The seat a beat's mark moves to or from, or -1 with no dots. Drawn by lot from the beat's id:
 * the same beat always gets the same seat, and no seat belongs to a person. The snapshot does not
 * say who did a beat, so this cannot either.
 */
export function seatOf(beatId: number, total: number): number {
  if (total <= 0) return -1;
  return mix(beatId) % total;
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

/** What a beat is called in the note that pops up beside its dot. Short: a memory's title may follow. */
export const POP_WORDS: Record<BeatWord, string> = {
  save: "Saved",
  search: "Searched the brain",
  reuse: "Reused",
  message: "Sent a message",
  flag: "Flagged",
};

/** The four counts the picture draws as coloured circles on the rim of the brain, two on each side. */
export const MOON_KINDS = ["search", "save", "message", "reuse"] as const;
export type MoonKind = (typeof MOON_KINDS)[number];
/** The smallest and largest circle, and the gap between a circle and the brain. */
export const MOON = { rMin: 22, rMax: 32, gap: 6 };
/** Which way from the middle of the brain each circle sits: left or right, up or down, 30 degrees off level. */
const MOON_SIDES: Record<MoonKind, { side: -1 | 1; up: -1 | 1 }> = {
  search: { side: -1, up: -1 },
  save: { side: 1, up: -1 },
  message: { side: -1, up: 1 },
  reuse: { side: 1, up: 1 },
};
const MOON_LEAN = { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) };

/**
 * Where each count sits and how big it is drawn. The largest count gets the largest circle and the
 * others shrink by area, so a circle twice as wide stands for four times as much. A count of
 * nothing still gets the smallest circle: the picture keeps its shape on a quiet day. Every circle
 * sits on the rim of the brain, inside the ring of dots, so it never covers one. `side` says which
 * way its word is written: to the left (-1) or to the right (1).
 */
export function moons(counts: Record<MoonKind, number>): Array<{ kind: MoonKind; x: number; y: number; r: number; side: -1 | 1; count: number }> {
  const most = Math.max(0, ...MOON_KINDS.map((k) => counts[k]));
  const round = (n: number) => Math.round(n * 10) / 10;
  return MOON_KINDS.map((kind) => {
    const share = most > 0 ? Math.sqrt(Math.max(0, counts[kind]) / most) : 0;
    const r = round(MOON.rMin + (MOON.rMax - MOON.rMin) * share);
    const { side, up } = MOON_SIDES[kind];
    const far = CORE.r + MOON.gap + r;
    return { kind, x: round(CORE.x + side * MOON_LEAN.x * far), y: round(CORE.y + up * MOON_LEAN.y * far), r, side, count: counts[kind] };
  });
}

/** The number in a coloured circle: at most four characters, so it fits the smallest one. */
export function moonCount(n: number): string {
  if (n < 1000) return String(Math.max(0, Math.round(n)));
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: n < 9950 ? 1 : 0 }).format(n);
}

/**
 * Which beats get a note. A note starts with its mark, and no sooner than `gap` after the note
 * before it, so with a note that lasts two gaps at most two are on the page at once. In a burst
 * the beats in between move without a note: they are all in the list. `starts` are the times the
 * marks start, in order; `freeAt` is when the next note may start.
 */
export function spaceNotes(starts: number[], freeAt: number, gap: number): { noted: boolean[]; freeAt: number } {
  let free = freeAt;
  const noted = starts.map((at) => {
    if (at < free) return false;
    free = at + gap;
    return true;
  });
  return { noted, freeAt: free };
}
