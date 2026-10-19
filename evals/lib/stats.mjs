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

/**
 * Bias-corrected and accelerated (BCa) bootstrap CI of fn(indices) over n units.
 * Preferred at small n (e.g. 8 task clusters) over the plain percentile interval.
 */
export function bcaCi(fn, n, { reps = 10_000, seed = 0 } = {}) {
  if (n === 0) return [NaN, NaN];
  const theta = fn(Array.from({ length: n }, (_, i) => i));
  if (!Number.isFinite(theta)) return [NaN, NaN];
  const r = rng(seed);
  const boots = [];
  for (let b = 0; b < reps; b++) {
    const idx = Array.from({ length: n }, () => Math.floor(r() * n));
    const v = fn(idx);
    if (Number.isFinite(v)) boots.push(v);
  }
  if (!boots.length) return [NaN, NaN];
  const z0 = invNorm(boots.filter((v) => v < theta).length / boots.length);
  // Jackknife acceleration
  const jacks = [];
  for (let i = 0; i < n; i++) {
    const idx = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i);
    const v = fn(idx);
    if (Number.isFinite(v)) jacks.push(v);
  }
  const jMean = mean(jacks);
  let num = 0;
  let den = 0;
  for (const j of jacks) {
    const d = jMean - j;
    num += d ** 3;
    den += d ** 2;
  }
  const a = den > 0 ? num / (6 * den ** 1.5) : 0;
  const zLo = invNorm(0.025);
  const zHi = invNorm(0.975);
  const adj = (z) => {
    const numz = z0 + z;
    return normCdf(z0 + numz / (1 - a * numz));
  };
  const sorted = [...boots].sort((x, y) => x - y);
  const at = (p) => {
    const clamped = Math.min(1, Math.max(0, p));
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(clamped * (sorted.length - 1))));
    return sorted[i];
  };
  return [at(adj(zLo)), at(adj(zHi))];
}

/** Approximate inverse standard normal (Beasley-Springer-Moro style rational approx). */
function invNorm(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -8 : 8;
  const a = [ -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577459677508e2, -3.066479806614716e1, 2.506628277459239 ];
  const b = [ -5.447609879822406e1, 1.615858368580607e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1 ];
  const c = [ -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783 ];
  const d = [ 7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416 ];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function normCdf(z) {
  // Hart approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** Two-sided Student-t CI for the mean of paired differences (df = n-1). */
export function tMeanCi(diffs, alpha = 0.05) {
  const d = diffs.filter(Number.isFinite);
  const n = d.length;
  if (n < 2) return [NaN, NaN];
  const m = mean(d);
  const var_ = d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
  const se = Math.sqrt(var_ / n);
  const tcrit = tCritical(n - 1, 1 - alpha / 2);
  return [m - tcrit * se, m + tcrit * se];
}

/** Rough critical value of Student's t (two-sided), adequate for n≈8 reporting. */
function tCritical(df, p) {
  // Use normal z as base and inflate slightly for small df (Hill's approx-ish table).
  const z = invNorm(p);
  if (df >= 30) return z;
  // Simple Padé-ish correction
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
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
 * Intervals are BCa over task clusters; also report a paired-t CI. p is uncorrected sign-flip.
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
    diffCi: bcaCi((idx) => mean(pick(d, idx)), tasks.length),
    diffCiT: tMeanCi(d),
    ratio: mean(a) ? mean(x) / mean(a) : NaN,
    ratioCi: bcaCi((idx) => mean(pick(x, idx)) / mean(pick(a, idx)), tasks.length, { seed: 1 }),
    p: signFlipP(d),
    pUncorrected: true,
  };
}
