import { DiagramFigure, markerIdFor } from "./DocsSection";
import styles from "./docs.module.css";

/**
 * A small sequence diagram: a few lanes, and arrows between them that appear in order.
 *
 * Owner, 2026-09-21: "it's not showing any flow diagram of different use cases, too much
 * reading, more DIAGRAMS". So each use case is drawn, not described. Labels are capped at
 * a handful of words on purpose: if a step needs a sentence, the step is wrong.
 *
 * Pure SVG in a server component. The arrows draw themselves in sequence with CSS alone,
 * which keeps this off the client bundle and means reduced-motion is a media query rather
 * than a code path.
 *
 * A step is an arrow between two lanes, or a note: a small chip sitting on one lane, for a
 * thing BAB does by itself ("two flags archive it") that has no second party to draw.
 */

export type Lane = { id: string; label: string; accent?: boolean };
export type ArrowStep = { from: string; to: string; label: string; back?: boolean };
export type NoteStep = { at: string; note: string };
export type Step = ArrowStep | NoteStep;

const LANE_W = 150;
const TOP = 46;
const STEP_H = 44;
const PAD = 14;
const NOTE_H = 24;
/** Average advance of the 10.5px note text; chips are sized from it, so keep it a little generous. */
const NOTE_CHAR_W = 5.7;

function isNote(step: Step): step is NoteStep {
  return "note" in step;
}

export default function FlowDiagram({
  title,
  lanes,
  steps,
  wide = false,
}: {
  title: string;
  /** Lets a four-lane diagram fill its card instead of capping at the two-column width, so its labels stay readable. */
  wide?: boolean;
  lanes: Lane[];
  steps: Step[];
}) {
  const width = PAD * 2 + LANE_W * lanes.length;
  const height = TOP + STEP_H * steps.length + 26;
  const centre = (id: string) => {
    const i = lanes.findIndex((l) => l.id === id);
    return PAD + LANE_W * i + LANE_W / 2;
  };
  const marker = markerIdFor(title);

  const sentence = steps
    .map((s, i) =>
      isNote(s)
        ? `${i + 1}. Note at ${laneLabel(lanes, s.at)}: ${s.note}`
        : `${i + 1}. ${laneLabel(lanes, s.from)} to ${laneLabel(lanes, s.to)}, ${s.label}`,
    )
    .join(". ");

  return (
    <DiagramFigure title={title}>
      <svg
        className={`${styles.flowSvg} ${wide ? styles.flowSvgWide : ""}`}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${title}: ${sentence}.`}
      >
        <defs>
          {/* Solid heads in the colour of their line, teal for a call and steel for an answer.
              The tip (8, 4) is the reference point, so the tip is the end of the path. */}
          <marker id={marker} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" className={styles.arrowHeadTeal} />
          </marker>
          <marker id={`${marker}-back`} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" className={styles.arrowHead} />
          </marker>
        </defs>

        {lanes.map((l) => (
          <g key={l.id}>
            <line
              className={styles.lane}
              x1={centre(l.id)}
              y1={TOP - 12}
              x2={centre(l.id)}
              y2={height - 12}
            />
            <rect
              className={l.accent ? styles.laneChipAccent : styles.laneChip}
              x={centre(l.id) - LANE_W / 2 + 8}
              y={10}
              width={LANE_W - 16}
              height={26}
              rx="13"
            />
            <text className={styles.laneLabel} x={centre(l.id)} y={27} textAnchor="middle">
              {l.label}
            </text>
          </g>
        ))}

        {steps.map((s, i) => {
          const y = TOP + STEP_H * i + STEP_H / 2;
          const delay = { animationDelay: `${i * 260}ms` };

          if (isNote(s)) {
            const w = Math.min(Math.round(s.note.length * NOTE_CHAR_W + 24), width - PAD * 2);
            const x = Math.min(Math.max(centre(s.at) - w / 2, PAD), width - PAD - w);
            return (
              <g key={`note-${s.at}-${s.note}`} className={styles.step} style={delay}>
                <rect className={styles.noteChip} x={x} y={y - NOTE_H / 2} width={w} height={NOTE_H} rx={NOTE_H / 2} />
                <text className={styles.noteText} x={x + w / 2} y={y + 4} textAnchor="middle">
                  {s.note}
                </text>
              </g>
            );
          }

          const x1 = centre(s.from);
          const x2 = centre(s.to);
          const mid = (x1 + x2) / 2;
          return (
            <g key={`${s.from}-${s.to}-${s.label}`} className={styles.step} style={delay}>
              <line
                className={s.back ? styles.arrowBack : styles.arrow}
                x1={x1}
                y1={y}
                x2={x2}
                y2={y}
                markerEnd={`url(#${s.back ? `${marker}-back` : marker})`}
              />
              <text className={styles.stepLabel} x={mid} y={y - 8} textAnchor="middle">
                {s.label}
              </text>
            </g>
          );
        })}
      </svg>
    </DiagramFigure>
  );
}

function laneLabel(lanes: Lane[], id: string) {
  return lanes.find((l) => l.id === id)?.label ?? id;
}
