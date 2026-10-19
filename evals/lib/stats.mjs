// Small, dependency-free statistics used by the eval reports.

/** Wilson score interval for k successes out of n. Returns [p, lo, hi]. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [NaN, NaN, NaN];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [p, Math.max(0, c - h), Math.min(1, c + h)];
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (xs) => quantile(xs, 0.5);

/** Deterministic PRNG (mulberry32) so reports are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap CI of fn(indices) over n units (resampled with replacement). */
export function bootstrapCi(fn, n, { reps = 10_000, seed = 0 } = {}) {
  if (n === 0) return [NaN, NaN];
  const r = rng(seed);
  const vals = [];
  for (let b = 0; b < reps; b++) {
    const idx = Array.from({ length: n }, () => Math.floor(r() * n));
    const v = fn(idx);
    if (Number.isFinite(v)) vals.push(v);
  }
  return vals.length ? [quantile(vals, 0.025), quantile(vals, 0.975)] : [NaN, NaN];
}

/** Two-sided sign-flip permutation p-value for the mean of paired differences (exact for n <= 16). */
export function signFlipP(diffs) {
  const d = diffs.filter(Number.isFinite);
  const n = d.length;
  if (n === 0 || d.every((x) => x === 0)) return 1;
  const obs = Math.abs(mean(d));
  let hits = 0;
  let total = 0;
  const test = (signs) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += signs(i) * d[i];
    total++;
    if (Math.abs(s / n) >= obs - 1e-12) hits++;
  };
  if (n <= 16) {
    for (let mask = 0; mask < 1 << n; mask++) test((i) => ((mask >> i) & 1 ? -1 : 1));
  } else {
    const r = rng(1);
    for (let b = 0; b < 100_000; b++) test(() => (r() < 0.5 ? -1 : 1));
  }
  return hits / total;
}

/**
 * Paired comparison of condition X vs baseline A with tasks as units (trials averaged within task).
 * byTask: { task: { A: [values], X: [values] } }
 */
export function paired(byTask) {
  const tasks = Object.keys(byTask).filter((t) => byTask[t].A?.length && byTask[t].X?.length);
  const a = tasks.map((t) => mean(byTask[t].A));
  const x = tasks.map((t) => mean(byTask[t].X));
  const d = x.map((v, i) => v - a[i]);
  const pick = (arr, idx) => idx.map((i) => arr[i]);
  return {
    nTasks: tasks.length,
    aMean: mean(a),
    xMean: mean(x),
    diff: mean(d),
    diffCi: bootstrapCi((idx) => mean(pick(d, idx)), tasks.length),
    ratio: mean(a) ? mean(x) / mean(a) : NaN,
    ratioCi: bootstrapCi((idx) => mean(pick(x, idx)) / mean(pick(a, idx)), tasks.length, { seed: 1 }),
    p: signFlipP(d),
  };
}
