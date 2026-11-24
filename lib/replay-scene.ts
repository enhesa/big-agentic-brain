import type { BrainReplay } from "@/lib/live-replay";

/**
 * The Replay on the Live Brain page, worked out: where every memory sits in the brain, when it
 * lights up, which threads join it to others and where the sparks run (docs/spec.md "Live Brain
 * page", Replay). Pure functions over flat arrays, no clock, no DOM and no drawing library, so the
 * drawing (app/live/replay-scene.ts) only hands these arrays to the graphics card and the tests
 * can check them.
 *
 * Everything is placed by rule, never by chance: the same history gives the same brain.
 */

/** How long the replay plays, in seconds, whatever the length of the history. */
export const REPLAY_SECONDS = 45;
/** Most sparks. With more searches and messages than fit, an even share of them is drawn. */
export const REPLAY_PULSES_MAX = 120_000;
/**
 * Faint points that draw the brain itself, so its shape shows even with few memories: the folds
 * of its surface, the small brain at the back and the stem under it.
 */
export const REPLAY_GHOSTS = 12_000;
const GHOSTS_SMALL_BRAIN = 2200;
const GHOSTS_STEM = 500;
/** A spark is on its way this long, in replay seconds. */
export const PULSE_SECONDS = 0.9;
/** A thread takes this long to grow from one memory to the other. */
export const LINK_GROW_SECONDS = 0.7;
/**
 * The last seconds of the replay hold no new memory, thread or spark: what is under way comes to
 * rest. So the end, and the still picture under reduced motion, show the finished brain.
 */
export const REPLAY_TAIL_SECONDS = 1.6;
/**
 * Where the replay's clock stands after a playing frame of `dt` seconds. It loops: past the end it
 * starts again from the first memory, so a playing replay never stops. The tail above is the hold on
 * the finished brain before it restarts. Pausing and scrubbing are the caller's: a paused clock is
 * never advanced.
 */
export function advanceReplayClock(seconds: number, dt: number, duration: number): number {
  if (!(duration > 0)) return 0;
  const next = seconds + dt;
  return next >= duration ? next % duration : next;
}
/** Of the sparks, at most this share goes to reuses and flags. The rest is for searches and messages. */
const FIRE_SPARK_SHARE = 0.7;
/** A time no replay reaches: a memory that never leaves, or one never reused. */
export const NEVER = 1e9;

export type Vec3 = [number, number, number];
type Rgb = readonly [number, number, number];

/** Ink on a light ground. A project group takes one of the first four, in turn. */
const GROUP_TONES: readonly Rgb[] = [
  [0, 158, 145],
  [46, 98, 220],
  [236, 84, 52],
  [232, 152, 0],
];
const TONE_REUSE: Rgb = [245, 160, 0];
const TONE_FLAG: Rgb = [226, 44, 20];
const TONE_SEARCH: Rgb = [46, 98, 220];
const TONE_MESSAGE: Rgb = [0, 128, 116];
const TONE_TAG: Rgb = [63, 81, 117];
const TONE_SUPERSEDES: Rgb = [214, 132, 0];

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** In a sunflower, a seed's neighbours are a Fibonacci number of seeds away. */
const FIBONACCI = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377];

/** A number from 0 up to 1 that depends only on the two given, so nothing here is random. */
export function hash01(a: number, b: number): number {
  let h = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * A point of the brain. `dir` is a direction from the middle (length 1) and `depth` says how far
 * in: 0 on the surface, 1 in the middle. The shape is a ball made longer front to back, flatter
 * underneath, folded, and cleft in two halves along the top.
 */
export function brainPoint(dir: Vec3, depth: number): Vec3 {
  const r = (1 - depth) * (1 + 0.07 * brainFold(dir) * (1 - depth));
  let x = dir[0] * r;
  let y = dir[1] * r;
  let z = dir[2] * r;
  x *= 0.8 * (1 - 0.14 * Math.max(0, z));
  y *= y < 0 ? 0.58 : 0.78;
  z *= 1.08;
  y -= 0.17 * Math.exp(-((x / 0.14) ** 2)) * Math.max(0, dir[1]) * (1 - depth);
  x += (dir[0] < 0 ? -1 : 1) * 0.055;
  return [x, y, z];
}

/** The folds of the surface in this direction: from -1 in a groove to 1 on a ridge. */
export function brainFold(dir: Vec3): number {
  return Math.sin(9 * dir[1] + 4 * Math.sin(5 * dir[2])) * Math.sin(8 * dir[2] + 3 * Math.sin(6 * dir[0]));
}

/** Direction number `g` of `total`, spread evenly over a ball. */
function evenDirection(g: number, total: number): Vec3 {
  const y = 1 - ((g + 0.5) / total) * 2;
  const s = Math.sqrt(1 - y * y);
  return [s * Math.cos(g * GOLDEN_ANGLE), y, s * Math.sin(g * GOLDEN_ANGLE)];
}

/** The faint points that draw the brain: the grooves of its folds, the small brain and the stem. */
export function brainGhosts(): Float32Array {
  const out = new Float32Array(REPLAY_GHOSTS * 3);
  const folds = REPLAY_GHOSTS - GHOSTS_SMALL_BRAIN - GHOSTS_STEM;
  // Points are kept where a ridge turns into a groove, so they line up along the folds. The
  // candidates are walked in a scattered order, so the kept ones cover the whole surface.
  const candidates = folds * 6;
  let kept = 0;
  for (let step = 0; step < candidates && kept < folds; step++) {
    const dir = evenDirection((step * 7919) % candidates, candidates);
    if (Math.abs(brainFold(dir)) > 0.1) continue;
    out.set(brainPoint(dir, 0), kept * 3);
    kept += 1;
  }
  for (let g = 0; kept < folds; g++, kept++) out.set(brainPoint(evenDirection(g, folds), 0), kept * 3);
  // The small brain at the back, drawn in layers.
  for (let g = 0; g < GHOSTS_SMALL_BRAIN; g++) {
    const d = evenDirection(g, GHOSTS_SMALL_BRAIN);
    const y = Math.round(d[1] * 9) / 9;
    const s = Math.sqrt(Math.max(0, 1 - y * y)) / (Math.hypot(d[0], d[2]) || 1);
    out.set([d[0] * s * 0.46, -0.47 + y * 0.2, -0.66 + d[2] * s * 0.3], (folds + g) * 3);
  }
  // The stem, from under the middle downwards.
  for (let g = 0; g < GHOSTS_STEM; g++) {
    const down = (g + 0.5) / GHOSTS_STEM;
    const angle = g * GOLDEN_ANGLE;
    const r = 0.1 - 0.03 * down;
    out.set([r * Math.cos(angle), -0.4 - 0.62 * down, -0.33 + 0.12 * down + r * Math.sin(angle)], (folds + GHOSTS_SMALL_BRAIN + g) * 3);
  }
  return out;
}

/** The middle of project group `c` of `total`: big groups on the sides, the two halves in turn. */
export function clusterCentre(c: number, total: number): Vec3 {
  const side = c % 2 === 0 ? 1 : -1;
  const k = Math.floor(c / 2);
  const half = Math.max(1, Math.ceil(total / 2));
  const x = 0.95 - ((k + 0.5) / half) * 0.9;
  const s = Math.sqrt(1 - x * x);
  const angle = k * GOLDEN_ANGLE + side * 0.6;
  return [side * x, s * Math.cos(angle), s * Math.sin(angle)];
}

/**
 * The direction of memory number `j` of `count` in a group around `centre` that takes `share` of
 * the whole brain. A sunflower: the first memory in the middle, later ones around it.
 */
export function clusterDirection(centre: Vec3, j: number, count: number, share: number): Vec3 {
  const cosEdge = 1 - 2 * Math.min(1, share * 1.15 + 0.01);
  const cosA = 1 - ((j + 0.5) / Math.max(1, count)) * (1 - cosEdge);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const b = j * GOLDEN_ANGLE;
  // Two directions square to the centre and to each other.
  const up: Vec3 = Math.abs(centre[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  let t1: Vec3 = [centre[1] * up[2] - centre[2] * up[1], centre[2] * up[0] - centre[0] * up[2], centre[0] * up[1] - centre[1] * up[0]];
  const len = Math.hypot(t1[0], t1[1], t1[2]) || 1;
  t1 = [t1[0] / len, t1[1] / len, t1[2] / len];
  const t2: Vec3 = [centre[1] * t1[2] - centre[2] * t1[1], centre[2] * t1[0] - centre[0] * t1[2], centre[0] * t1[1] - centre[1] * t1[0]];
  const lx = sinA * Math.cos(b);
  const ly = sinA * Math.sin(b);
  return [t1[0] * lx + t2[0] * ly + centre[0] * cosA, t1[1] * lx + t2[1] * ly + centre[1] * cosA, t1[2] * lx + t2[2] * ly + centre[2] * cosA];
}

/** How many of the sorted numbers are at most `value`. */
export function countUpTo(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface ReplayCounts {
  memories: number;
  reuses: number;
  searches: number;
  messages: number;
}

export interface ReplayScene {
  /** The length of the replay, in seconds. Every time below is a second of the replay. */
  duration: number;
  neurons: {
    count: number;
    /** Three numbers per memory. */
    position: Float32Array;
    /** Three numbers per memory, 0 to 255. */
    color: Uint8Array;
    born: Float32Array;
    /** When it stops being live, or NEVER. */
    gone: Float32Array;
    /** When it is first reused, or NEVER. */
    hot: Float32Array;
    size: Float32Array;
    /** A number from 0 up to 1 of its own, for a pulse out of step with its neighbours. */
    seed: Float32Array;
  };
  /** Threads, two ends each. */
  links: {
    count: number;
    /** Six numbers per thread: the newer memory, then the older one. */
    position: Float32Array;
    /** Eight numbers per thread: red, green, blue and how strong the thread is, for each end. */
    color: Uint8Array;
    /** Two numbers per thread, the same: when it starts to grow. */
    born: Float32Array;
    /** Two numbers per thread: 0 at the end it grows from, 1 at the other. */
    along: Float32Array;
  };
  /** Sparks that run from one point to another. */
  pulses: {
    count: number;
    from: Float32Array;
    to: Float32Array;
    color: Uint8Array;
    start: Float32Array;
  };
  /** The faint points that draw the brain itself, three numbers per point. */
  ghosts: Float32Array;
  /** The date the replay has reached at this second. */
  dateAt(seconds: number): Date;
  /** What has happened by this second. */
  countsAt(seconds: number): ReplayCounts;
}

/** Works the replay data out into the arrays the drawing needs. */
export function buildReplayScene(replay: BrainReplay, duration: number = REPLAY_SECONDS): ReplayScene {
  const n = replay.neurons.born.length;
  const hours = Math.max(1, replay.hours);
  const startMs = Date.parse(replay.start);
  const born = replay.neurons.born;

  // Everything happens before `active`. The seconds after it are the tail.
  const active = Math.max(duration / 2, duration - REPLAY_TAIL_SECONDS);
  // Time: half by the calendar, half by the count of memories, so a quiet month passes quickly
  // and a busy day does not flash by. The first memory is there at second 0.
  const warp = (hour: number): number => {
    const byCalendar = Math.min(1, Math.max(0, hour / hours));
    const byCount = n <= 1 ? byCalendar : Math.max(0, countUpTo(born, hour) - 1) / (n - 1);
    return active * (0.55 * byCalendar + 0.45 * byCount);
  };

  // ---------- memories ----------
  const sizes = new Array<number>(Math.max(1, replay.clusters)).fill(0);
  for (let i = 0; i < n; i++) sizes[replay.neurons.cluster[i]] += 1;
  const centres = sizes.map((_, c) => clusterCentre(c, sizes.length));
  const members: number[][] = sizes.map(() => []);

  const position = new Float32Array(n * 3);
  const color = new Uint8Array(n * 3);
  const bornAt = new Float32Array(n);
  const gone = new Float32Array(n).fill(NEVER);
  const hot = new Float32Array(n).fill(NEVER);
  const size = new Float32Array(n);
  const seed = new Float32Array(n);
  const mate = new Int32Array(n).fill(-1);

  const linkPosition: number[] = [];
  const linkColor: number[] = [];
  const linkBorn: number[] = [];
  const addLink = (newer: number, older: number, at: number, tone: Rgb, strength: number) => {
    linkPosition.push(position[newer * 3], position[newer * 3 + 1], position[newer * 3 + 2], position[older * 3], position[older * 3 + 1], position[older * 3 + 2]);
    for (let end = 0; end < 2; end++) linkColor.push(tone[0], tone[1], tone[2], 255 * strength);
    linkBorn.push(at, at);
  };

  for (let i = 0; i < n; i++) {
    const c = replay.neurons.cluster[i];
    const j = members[c].length;
    const dir = clusterDirection(centres[c], j, sizes[c], sizes[c] / n);
    // Most memories sit in the folded outside. Some lie deeper, so the brain is not hollow.
    const depth = hash01(i, 1) < 0.86 ? 0.02 + 0.2 * hash01(i, 2) ** 1.6 : 0.3 + 0.45 * hash01(i, 2);
    const p = brainPoint(dir, depth);
    position.set(p, i * 3);
    const tone = GROUP_TONES[c % GROUP_TONES.length];
    const shade = 0.7 + 0.3 * hash01(c, 3);
    color.set([tone[0] * shade, tone[1] * shade, tone[2] * shade], i * 3);
    const byCalendar = Math.min(1, born[i] / hours);
    bornAt[i] = active * (0.55 * byCalendar + 0.45 * (n <= 1 ? byCalendar : i / (n - 1)));
    if (replay.neurons.gone[i] >= 0) gone[i] = Math.max(warp(replay.neurons.gone[i]), bornAt[i]);
    // A standard or a decision is drawn bigger than a learning.
    size[i] = 1 + 0.25 * Math.min(3, replay.neurons.kind[i]);
    seed[i] = hash01(i, 4);

    // Threads to its two nearest earlier neighbours in the group.
    let near = -1;
    let nearD = Infinity;
    let next = -1;
    let nextD = Infinity;
    for (const step of FIBONACCI) {
      if (step > j) break;
      const other = members[c][j - step];
      const d = Math.hypot(position[other * 3] - p[0], position[other * 3 + 1] - p[1], position[other * 3 + 2] - p[2]);
      if (d < nearD) {
        next = near;
        nextD = nearD;
        near = other;
        nearD = d;
      } else if (d < nextD) {
        next = other;
        nextD = d;
      }
    }
    if (near >= 0) {
      mate[i] = near;
      addLink(i, near, bornAt[i], tone, 0.55);
    }
    if (next >= 0) addLink(i, next, bornAt[i] + 0.1, tone, 0.4);
    members[c].push(i);
  }

  // Threads from the history itself: the same tag, and one memory replacing another.
  for (let k = 0; k + 2 < replay.links.length; k += 3) {
    const older = replay.links[k];
    const newer = replay.links[k + 1];
    if (older < 0 || newer >= n || older >= newer) continue;
    addLink(newer, older, bornAt[newer] + 0.15, replay.links[k + 2] === 1 ? TONE_SUPERSEDES : TONE_TAG, replay.links[k + 2] === 1 ? 0.9 : 0.07);
  }

  // ---------- sparks ----------
  const fireCount = Math.floor(replay.fires.length / 3);
  const dayTotal = (list: number[]) => list.reduce((sum, v) => sum + v, 0);
  const searchTotal = dayTotal(replay.days.search);
  const messageTotal = dayTotal(replay.days.message);
  // Reuses and flags never take every spark: searches and messages keep a share.
  const fireSparks = Math.min(fireCount, Math.floor(REPLAY_PULSES_MAX * FIRE_SPARK_SHARE));
  const room = REPLAY_PULSES_MAX - fireSparks;
  const keep = searchTotal + messageTotal > room ? room / (searchTotal + messageTotal) : 1;

  const pulseFrom: number[] = [];
  const pulseTo: number[] = [];
  const pulseColor: number[] = [];
  const pulseStart: number[] = [];
  const addPulse = (a: number, b: number, at: number, tone: Rgb) => {
    // A memory with no thread yet sends its spark to the middle of the brain.
    if (b < 0) pulseTo.push(0, 0, 0);
    else pulseTo.push(position[b * 3], position[b * 3 + 1], position[b * 3 + 2]);
    pulseFrom.push(position[a * 3], position[a * 3 + 1], position[a * 3 + 2]);
    pulseColor.push(tone[0], tone[1], tone[2]);
    pulseStart.push(at);
  };

  const reuseTimes: number[] = [];
  const firstFire = fireCount - fireSparks;
  for (let f = 0; f < fireCount; f++) {
    const neuron = replay.fires[f * 3];
    if (neuron < 0 || neuron >= n) continue;
    const flag = replay.fires[f * 3 + 2] === 1;
    // Never in the tail: its spark must land, and the last number on the screen is the whole count.
    const at = Math.min(active, Math.max(warp(replay.fires[f * 3 + 1]), bornAt[neuron]) + 0.3 * hash01(f, 5));
    if (!flag) {
      reuseTimes.push(at);
      if (at < hot[neuron]) hot[neuron] = at;
      size[neuron] = Math.min(4, size[neuron] + 0.18);
    }
    if (f >= firstFire) addPulse(neuron, mate[neuron], at, flag ? TONE_FLAG : TONE_REUSE);
  }
  reuseTimes.sort((a, b) => a - b);

  // A search or a message has no memory of its own: its spark runs where memories already are.
  const startHourOfDay = new Date(startMs).getUTCHours();
  const dayStarts = (days: number): Float32Array => {
    const out = new Float32Array(days + 1);
    for (let d = 0; d <= days; d++) out[d] = warp(d * 24 - startHourOfDay);
    return out;
  };
  const scatter = (perDay: number[], salt: number, tone: Rgb, between: boolean) => {
    for (let d = 0; d < perDay.length; d++) {
      const wanted = perDay[d] * keep;
      const drawn = Math.floor(wanted) + (hash01(d, salt) < wanted - Math.floor(wanted) ? 1 : 0);
      for (let k = 0; k < drawn; k++) {
        const at = warp(d * 24 - startHourOfDay + 24 * hash01(d * 8191 + k, salt + 1));
        const alive = countUpTo(bornAt, at);
        if (alive === 0) continue;
        // Newer memories are picked more often than old ones.
        const a = Math.min(alive - 1, Math.floor(alive * (1 - hash01(d * 8191 + k, salt + 2) ** 2)));
        if (between) {
          const b = Math.floor(alive * hash01(d * 8191 + k, salt + 3));
          if (b !== a) addPulse(a, b, at, tone);
        } else if (mate[a] >= 0) addPulse(mate[a], a, at, tone);
        else addPulse(a, -1, at, tone);
      }
    }
  };
  scatter(replay.days.search, 10, TONE_SEARCH, false);
  scatter(replay.days.message, 20, TONE_MESSAGE, true);

  // ---------- the words beside the picture ----------
  const searchStarts = dayStarts(replay.days.search.length);
  const messageStarts = dayStarts(replay.days.message.length);
  const running = (perDay: number[]): Float64Array => {
    const out = new Float64Array(perDay.length + 1);
    for (let d = 0; d < perDay.length; d++) out[d + 1] = out[d] + perDay[d];
    return out;
  };
  const searchSum = running(replay.days.search);
  const messageSum = running(replay.days.message);
  const reached = (starts: Float32Array, sum: Float64Array, seconds: number): number => {
    const d = countUpTo(starts, seconds) - 1;
    if (d < 0) return 0;
    if (d >= sum.length - 1) return sum[sum.length - 1];
    const span = starts[d + 1] - starts[d];
    const part = span > 0 ? (seconds - starts[d]) / span : 1;
    return Math.round(sum[d] + (sum[d + 1] - sum[d]) * Math.min(1, part));
  };

  // The calendar read back from the replay's own clock, at 512 steps.
  const STEPS = 512;
  const stepTimes = new Float32Array(STEPS + 1);
  for (let s = 0; s <= STEPS; s++) stepTimes[s] = warp((s / STEPS) * hours);

  return {
    duration,
    neurons: { count: n, position, color, born: bornAt, gone, hot, size, seed },
    links: {
      count: linkBorn.length / 2,
      position: new Float32Array(linkPosition),
      color: new Uint8Array(linkColor),
      born: new Float32Array(linkBorn),
      along: new Float32Array(linkBorn.length).map((_, i) => i % 2),
    },
    pulses: {
      count: pulseStart.length,
      from: new Float32Array(pulseFrom),
      to: new Float32Array(pulseTo),
      color: new Uint8Array(pulseColor),
      start: new Float32Array(pulseStart),
    },
    ghosts: brainGhosts(),
    dateAt(seconds: number): Date {
      if (seconds >= active) return new Date(startMs + hours * 3_600_000);
      const s = Math.max(0, countUpTo(stepTimes, Math.max(0, seconds)) - 1);
      if (s >= STEPS) return new Date(startMs + hours * 3_600_000);
      const span = stepTimes[s + 1] - stepTimes[s];
      const part = span > 0 ? (seconds - stepTimes[s]) / span : 0;
      return new Date(startMs + ((s + Math.min(1, Math.max(0, part))) / STEPS) * hours * 3_600_000);
    },
    countsAt(seconds: number): ReplayCounts {
      return {
        memories: countUpTo(bornAt, seconds),
        reuses: countUpTo(reuseTimes, seconds),
        searches: reached(searchStarts, searchSum, seconds),
        messages: reached(messageStarts, messageSum, seconds),
      };
    },
  };
}

/**
 * A colour as the browser reports it ("rgb(26, 51, 96)" or "color(srgb 0.1 0.2 0.38)"), as three
 * numbers from 0 to 1. Null when it is neither.
 */
export function parseCssColor(value: string): Vec3 | null {
  const nums = value.match(/-?\d*\.?\d+(e-?\d+)?/g)?.map(Number) ?? [];
  if (nums.length < 3 || nums.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
  if (/^rgba?\(/.test(value.trim())) return [nums[0] / 255, nums[1] / 255, nums[2] / 255];
  if (/^color\(\s*srgb\b/.test(value.trim())) return [nums[0], nums[1], nums[2]];
  return null;
}
