import styles from "./usage.module.css";

/**
 * Inline-SVG charts for /usage. Server components: no dependencies, no client JS. Every chart has
 * an aria-label, and every mark a <title> so hovering shows the exact numbers. Colours come from
 * the page's CSS custom properties (usage.module.css), which map onto the app tokens in
 * app/globals.css.
 *
 * Palette, checked with the dataviz skill's validate_palette.js on white:
 * - three series (saves, searches, reactions): teal #00b0a1, steel #3f5175, coral #ff4423. Adjacent
 *   CVD dE 18.8, normal-vision dE 27.5. Teal is under 3:1 on white and steel reads as gray, so every
 *   chart also has a legend, hover titles and a numbers table or value labels.
 * - standing (ordinal weak, fair, strong): #5cc2b8, #00b0a1, #00665d. Monotone, light end 2.13:1.
 */

/** A "nice" axis maximum (1, 2, 5 x 10^n) at or above the largest value. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (step * pow >= value) return step * pow;
  return 10 * pow;
}

/** Whole-number ticks: 0, the middle when it is whole, and the top. */
function ticks(max: number): number[] {
  return max % 2 === 0 ? [0, max / 2, max] : [0, max];
}

const fmt = new Intl.NumberFormat("en-GB");
export function formatCount(n: number): string {
  return fmt.format(n);
}

/** A bar with a 4px rounded data end and a square base on `base`. */
function columnPath(x: number, y: number, w: number, base: number): string {
  const h = base - y;
  if (h <= 0 || w <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/* ------------------------------------------------------------------ sparkline */

/** A small trend for a stat tile: area wash, 2px line, a ringed dot on the current week. Needs 2+ points. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 36;
  const max = Math.max(1, ...values);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - 3 - (v / max) * (h - 8)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg viewBox={`-4 -4 ${w + 8} ${h + 8}`} className={styles.spark} role="img" aria-label={label}>
      <title>{label}</title>
      <polygon points={`0,${h} ${line} ${w},${h}`} className={styles.sparkArea} />
      <polyline points={line} className={styles.sparkLine} />
      <circle cx={lx} cy={ly} r={4} className={styles.sparkDot} />
    </svg>
  );
}

/* ----------------------------------------------------------------- area line */

export interface LinePoint {
  label: string;
  value: number;
  title: string;
}

const AW = 560;
const AH = 220;
const AP = { top: 22, right: 18, bottom: 28, left: 40 };

/** One series over time: a 2px line over a light wash, the latest value labelled at its end. */
export function AreaLine({ data, label }: { data: LinePoint[]; label: string }) {
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = AW - AP.left - AP.right;
  const plotH = AH - AP.top - AP.bottom;
  const n = data.length;
  const x = (i: number) => AP.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => AP.top + plotH - (v / max) * plotH;
  const base = AP.top + plotH;
  const line = data.map((d, i) => `${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  // At most about six x labels, always the last one.
  const every = Math.max(1, Math.ceil(n / 6));
  const labelled = new Set(data.map((_, i) => i).filter((i) => (n - 1 - i) % every === 0));
  const last = data[n - 1];
  const slot = n === 1 ? plotW : plotW / (n - 1);
  return (
    <svg viewBox={`0 0 ${AW} ${AH}`} className={styles.chart} role="img" aria-label={label}>
      <title>{label}</title>
      {ticks(max).map((t) => (
        <g key={t}>
          <line x1={AP.left} x2={AW - AP.right} y1={y(t)} y2={y(t)} className={t === 0 ? styles.axis : styles.gridline} />
          <text x={AP.left - 8} y={y(t) + 4} textAnchor="end" className={styles.tick}>
            {formatCount(t)}
          </text>
        </g>
      ))}
      {n > 1 && <polygon points={`${x(0)},${base} ${line} ${x(n - 1)},${base}`} className={styles.area} />}
      {n > 1 && <polyline points={line} className={styles.line} />}
      {data.map((d, i) => (
        <g key={`${d.label}-${i}`} className={styles.hover}>
          <title>{d.title}</title>
          <rect
            x={Math.max(AP.left, x(i) - slot / 2)}
            y={AP.top}
            width={Math.min(slot, AW - AP.right - Math.max(AP.left, x(i) - slot / 2))}
            height={plotH}
            className={styles.hit}
          />
          <line x1={x(i)} x2={x(i)} y1={AP.top} y2={base} className={styles.crosshair} />
          <circle cx={x(i)} cy={y(d.value)} r={4} className={i === n - 1 ? styles.endDot : styles.hoverDot} />
        </g>
      ))}
      <text x={x(n - 1)} y={y(last.value) - 12} textAnchor={n === 1 ? "middle" : "end"} className={styles.value}>
        {formatCount(last.value)}
      </text>
      {data.map((d, i) =>
        labelled.has(i) ? (
          <text key={`x-${i}`} x={x(i)} y={AH - 8} textAnchor={i === n - 1 && n > 1 ? "end" : "middle"} className={styles.tick}>
            {d.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

/* --------------------------------------------------------------- grouped bars */

export interface Series {
  name: string;
  /** usage.module.css class that fills the bars. */
  className: string;
}

export interface GroupDatum {
  label: string;
  values: number[];
  title: string;
}

const GW = 560;
const GH = 230;
const GP = { top: 16, right: 10, bottom: 28, left: 40 };

/** Two or more series side by side per week, on one shared count axis. */
export function GroupedBars({ data, series, label }: { data: GroupDatum[]; series: Series[]; label: string }) {
  const max = niceMax(Math.max(0, ...data.flatMap((d) => d.values)));
  const plotW = GW - GP.left - GP.right;
  const plotH = GH - GP.top - GP.bottom;
  const base = GP.top + plotH;
  const slot = plotW / Math.max(1, data.length);
  const gap = 2;
  const bw = Math.max(3, Math.min(18, (slot * 0.72 - gap * (series.length - 1)) / series.length));
  const groupW = bw * series.length + gap * (series.length - 1);
  const y = (v: number) => GP.top + plotH - (v / max) * plotH;
  return (
    <svg viewBox={`0 0 ${GW} ${GH}`} className={styles.chart} role="img" aria-label={label}>
      <title>{label}</title>
      {ticks(max).map((t) => (
        <g key={t}>
          <line x1={GP.left} x2={GW - GP.right} y1={y(t)} y2={y(t)} className={t === 0 ? styles.axis : styles.gridline} />
          <text x={GP.left - 8} y={y(t) + 4} textAnchor="end" className={styles.tick}>
            {formatCount(t)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const x0 = GP.left + slot * i + (slot - groupW) / 2;
        return (
          <g key={`${d.label}-${i}`} className={styles.hover}>
            <title>{d.title}</title>
            <rect x={GP.left + slot * i} y={GP.top} width={slot} height={plotH} className={styles.hit} />
            {d.values.map((v, j) => {
              // A non-zero count always shows at least 2px.
              const top = v > 0 ? Math.min(y(v), base - 2) : base;
              const p = columnPath(x0 + j * (bw + gap), top, bw, base);
              return p ? <path key={j} d={p} className={series[j].className} /> : null;
            })}
            <text
              x={GP.left + slot * (i + 0.5)}
              y={GH - 8}
              textAnchor="middle"
              // On a phone every other week label goes, counted from the newest, so they never touch.
              className={data.length > 5 && (data.length - 1 - i) % 2 === 1 ? `${styles.tick} ${styles.tickAlt}` : styles.tick}
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------ horizontal bars */

export interface BarRow {
  key: string;
  label: React.ReactNode;
  n: number;
  title: string;
  muted?: boolean;
}

/** Ranked horizontal bars: label, a bar scaled to the largest value, the value at its tip. */
export function HBars({ rows, label }: { rows: BarRow[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className={styles.hbars} aria-label={label}>
      {rows.map((r) => {
        const pct = r.n === 0 ? 0 : Math.max(1.5, (r.n / max) * 100);
        return (
          <li key={r.key} className={styles.hbar} title={r.title}>
            <span className={styles.hbarLabel}>{r.label}</span>
            <svg className={styles.hbarTrack} aria-hidden="true">
              {pct > 0 && (
                <>
                  <rect x="0" y="0" width={`${pct}%`} height="100%" rx="4" className={r.muted ? styles.fillMuted : styles.fill1} />
                  <rect x="0" y="0" width={`${Math.min(pct, 2)}%`} height="100%" className={r.muted ? styles.fillMuted : styles.fill1} />
                </>
              )}
            </svg>
            <span className={styles.hbarValue}>{formatCount(r.n)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------- small bars per row */

export interface MiniBarRow {
  key: string;
  label: string;
  /** One count per week, oldest first. */
  values: number[];
  /** What the row counts, for the row's tooltip. */
  title: string;
  /** usage.module.css class that fills the bars. */
  className: string;
}

const MW = 112;
const MH = 26;

/**
 * Several small weekly bar charts, one per row, each on its own scale (a row is "how many per week
 * of this", not a comparison between rows): label, 8 bars, the total at the end. A non-zero week
 * always shows at least 2px; every bar has a <title> with its week and count.
 */
export function MiniBars({ rows, weeks, label }: { rows: MiniBarRow[]; weeks: string[]; label: string }) {
  const n = Math.max(1, weeks.length);
  const gap = 3;
  const bw = (MW - gap * (n - 1)) / n;
  return (
    <ul className={styles.clean} aria-label={label}>
      {rows.map((r) => {
        const max = Math.max(1, ...r.values);
        const total = r.values.reduce((s, v) => s + v, 0);
        return (
          <li key={r.key} className={styles.cleanRow} title={r.title}>
            <span className={styles.cleanLabel}>{r.label}</span>
            <svg viewBox={`0 0 ${MW} ${MH}`} className={styles.cleanTrack} role="img" aria-label={`${r.label} per week: ${r.values.join(", ")}`}>
              <line x1="0" x2={MW} y1={MH - 0.5} y2={MH - 0.5} className={styles.axis} />
              {r.values.map((v, i) => {
                const h = v > 0 ? Math.max(2, (v / max) * (MH - 4)) : 0;
                const p = columnPath(i * (bw + gap), MH - 1 - h, bw, MH - 1);
                return (
                  <g key={weeks[i] ?? i} className={styles.hover}>
                    <title>{`${weeks[i] ?? ""}: ${formatCount(v)}`}</title>
                    <rect x={i * (bw + gap) - gap / 2} y="0" width={bw + gap} height={MH} className={styles.hit} />
                    {p && <path d={p} className={r.className} />}
                  </g>
                );
              })}
            </svg>
            <span className={styles.cleanValue}>{formatCount(total)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------------------------------------- stacked bar */

export interface Segment {
  key: string;
  name: string;
  n: number;
  className: string;
  swatchClassName: string;
}

/** Part-to-whole in one bar, with a 2px surface gap between segments and a legend with counts. */
export function StackedBar({ segments, label }: { segments: Segment[]; label: string }) {
  const total = segments.reduce((s, x) => s + x.n, 0);
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  let at = 0;
  const parts = segments.map((s) => {
    const start = at;
    at += pct(s.n);
    return { ...s, start, width: pct(s.n) };
  });
  return (
    <div className={styles.stack}>
      <svg className={styles.stackBar} role="img" aria-label={label}>
        <title>{label}</title>
        {parts.map((p) =>
          p.width > 0 ? (
            <rect key={p.key} x={`${p.start}%`} y="0" width={`${p.width}%`} height="100%" className={p.className}>
              <title>{`${p.name}: ${formatCount(p.n)} (${Math.round(p.width)}%)`}</title>
            </rect>
          ) : null,
        )}
        {parts.slice(1).map((p) =>
          p.width > 0 && p.start > 0 ? (
            <rect key={`gap-${p.key}`} x={`${p.start}%`} y="0" width="2" height="100%" transform="translate(-1 0)" className={styles.gap} />
          ) : null,
        )}
      </svg>
      <ul className={styles.legend}>
        {parts.map((p) => (
          <li key={p.key} title={`${p.name}: ${formatCount(p.n)} of ${formatCount(total)}`}>
            <span className={`${styles.swatch} ${p.swatchClassName}`} />
            <span>{p.name}</span>
            <strong className={styles.legendValue}>{formatCount(p.n)}</strong>
            <span className={styles.legendPct}>{Math.round(p.width)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
