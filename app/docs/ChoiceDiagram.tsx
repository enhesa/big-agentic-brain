import { DiagramFigure, markerIdFor } from "./DocsSection";
import styles from "./docs.module.css";

/**
 * A fan: one starting point, several things you can do from it, each in a few words, and
 * optionally a closing band. For a use case that is a choice rather than a sequence, where a
 * lane diagram would draw alternatives as if they happened one after another.
 *
 * Same rules as FlowDiagram: pure SVG in a server component, theme tokens only, rows that appear
 * in order, reduced motion handled in CSS. Same 478px width as a three-lane flow, so the two sit
 * side by side at one scale.
 *
 * The arrows: every connector ends exactly on the left edge of its chip, on a straight stretch
 * (FLAT) so the arrowhead sits on a line that points at the chip, and the head's tip is the end of
 * the path (refX is the tip). The head is solid and sized in user units, not in stroke widths, so it
 * stays small on a thin connector. tests/docs-page.test.ts pins that the ends are the chips' edges
 * and that nothing here is see-through.
 */

export type ChoiceOption = { chip: string; text: string };
/** `levels` draws the standing scale (strong, fair, weak) at the right of the band. */
export type ChoiceFooter = { text: string; tone: "standing" | "waiting" | "plain"; levels?: string[] };

const W = 478;
const PAD = 14;
const TOP = 14;
const ROW_H = 46;
const CHIP_H = 26;
const FROM_W = 112;
/** The left edge of every chip, and where every connector ends. */
const CHIPS_X = PAD + FROM_W + 48;
/** The last stretch of a connector is straight, as long as the arrowhead and a little more. */
const FLAT = 16;
const BAND_GAP = 14;
const BAND_H = 40;
const LEVEL_H = 22;
/** Average advance of the bold 11px chip text, a little generous. */
const CHIP_CHAR_W = 6.6;
const LEVEL_CHAR_W = 6;

const BAND_CLASS = {
  standing: styles.bandStanding,
  waiting: styles.bandWaiting,
  plain: styles.bandPlain,
} as const;

const LEVEL_CLASS = [styles.levelStrong, styles.levelFair, styles.levelWeak];

/** A soft S from the box to the start of the straight stretch, then straight to the chip. */
function connector(x0: number, y0: number, x1: number, y1: number): string {
  if (Math.abs(y1 - y0) < 0.5) return `M${x0} ${y0} H${x1}`;
  const xs = x1 - FLAT;
  const k = (xs - x0) * 0.55;
  return `M${x0} ${y0} C ${x0 + k} ${y0}, ${xs - k} ${y1}, ${xs} ${y1} H${x1}`;
}

export default function ChoiceDiagram({
  title,
  from,
  options,
  footer,
}: {
  title: string;
  /** The starting point: its lines are the box title, `sub` the small text under it. */
  from: { lines: string[]; sub?: string[] };
  options: ChoiceOption[];
  footer?: ChoiceFooter;
}) {
  const rowsBottom = TOP + (options.length - 1) * ROW_H + CHIP_H;
  const bandTop = rowsBottom + BAND_GAP;
  const height = footer ? bandTop + BAND_H + 12 : rowsBottom + 12;
  const marker = markerIdFor(title);

  const rowTop = (i: number) => TOP + i * ROW_H;
  const rowCentre = (i: number) => rowTop(i) + CHIP_H / 2;
  const fromCentre = (TOP + rowsBottom) / 2;
  // The box is as tall as its text: the baseline of the last line, and a margin under it.
  const subLines = from.sub?.length ?? 0;
  const lastBaseline = subLines > 0 ? 24 + from.lines.length * 15 + 3 + (subLines - 1) * 13 : 24 + (from.lines.length - 1) * 15;
  const fromH = lastBaseline + 16;
  const fromTop = fromCentre - fromH / 2;
  const chipW = Math.round(Math.max(...options.map((o) => o.chip.length)) * CHIP_CHAR_W + 22);

  const sentence = [
    `Start: ${from.lines.join(" ")}${from.sub ? ` (${from.sub.join(" ")})` : ""}`,
    ...options.map((o) => `${o.chip}: ${o.text}`),
    ...(footer ? [`${footer.text}${footer.levels ? `: ${footer.levels.join(", ")}` : ""}`] : []),
  ].join(". ");

  return (
    <DiagramFigure title={title}>
      <svg
        className={styles.flowSvg}
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={`${title}. ${sentence}.`}
      >
        <defs>
          {/* The tip (8, 4) is the reference point, so the tip is the end of the path. A solid
              head, 8px whatever the line's width. */}
          <marker
            id={marker}
            viewBox="0 0 8 8"
            refX="8"
            refY="4"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0 L8 4 L0 8 z" className={styles.arrowHead} />
          </marker>
        </defs>

        <rect className={`${styles.brainFill} ${styles.brainStroke}`} x={PAD} y={fromTop} width={FROM_W} height={fromH} rx="12" />
        {from.lines.map((line, i) => (
          <text key={line} className={styles.label} x={PAD + 12} y={fromTop + 24 + i * 15}>
            {line}
          </text>
        ))}
        {(from.sub ?? []).map((line, i) => (
          <text key={line} className={styles.sub} x={PAD + 12} y={fromTop + 24 + from.lines.length * 15 + 3 + i * 13}>
            {line}
          </text>
        ))}

        {options.map((o, i) => (
          <g key={o.chip} className={styles.step} style={{ animationDelay: `${i * 260}ms` }}>
            <path
              className={styles.fanEdge}
              d={connector(PAD + FROM_W, fromCentre, CHIPS_X, rowCentre(i))}
              markerEnd={`url(#${marker})`}
            />
            <rect className={styles.chipTeal} x={CHIPS_X} y={rowTop(i)} width={chipW} height={CHIP_H} rx={CHIP_H / 2} />
            <text className={styles.chipText} x={CHIPS_X + chipW / 2} y={rowCentre(i) + 4} textAnchor="middle">
              {o.chip}
            </text>
            <text className={styles.stepLabel} x={CHIPS_X + chipW + 12} y={rowCentre(i) + 4}>
              {o.text}
            </text>
          </g>
        ))}

        {footer ? (
          <g className={styles.step} style={{ animationDelay: `${options.length * 260}ms` }}>
            <rect className={BAND_CLASS[footer.tone]} x={PAD} y={bandTop} width={W - PAD * 2} height={BAND_H} rx="12" />
            <text className={styles.bandText} x={PAD + 14} y={bandTop + BAND_H / 2 + 4}>
              {footer.text}
            </text>
            {footer.levels ? <Levels levels={footer.levels} right={W - PAD - 10} y={bandTop + (BAND_H - LEVEL_H) / 2} /> : null}
          </g>
        ) : null}
      </svg>
    </DiagramFigure>
  );
}

/** The scale chips, laid out from the right edge so the band text keeps its room on the left. */
function Levels({ levels, right, y }: { levels: string[]; right: number; y: number }) {
  const widths = levels.map((l) => Math.round(l.length * LEVEL_CHAR_W + 22));
  let cursor = right - widths.reduce((a, b) => a + b, 0) - 6 * (levels.length - 1);
  return (
    <>
      {levels.map((l, i) => {
        const left = cursor;
        cursor += widths[i] + 6;
        return (
          <g key={l}>
            <rect className={LEVEL_CLASS[i] ?? styles.levelWeak} x={left} y={y} width={widths[i]} height={LEVEL_H} rx={LEVEL_H / 2} />
            <text className={styles.chipText} x={left + widths[i] / 2} y={y + 15} textAnchor="middle">
              {l}
            </text>
          </g>
        );
      })}
    </>
  );
}
