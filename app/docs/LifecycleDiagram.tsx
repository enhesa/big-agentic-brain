import { DiagramFigure, markerIdFor } from "./DocsSection";
import styles from "./docs.module.css";

/**
 * A memory's life, drawn as states: Saved and Archived, and what moves it between them.
 *
 * Decided: memories do not expire; one that no agent reads for a year is archived
 * (docs/spec.md, "Memories do not expire; unread ones are archived"). The numbers on this
 * diagram come in as props, read from the same constants the hourly sweep uses, so the page
 * cannot say a year while the code says something else.
 *
 * Every claim here has a counterpart in code:
 *  - the read kinds are `touchRead`'s callers (lib/learnings.ts);
 *  - the exemptions, and the second branch for memories voted not helpful, are `sweepUnread`'s WHERE
 *    clause (lib/maintenance.ts);
 *  - "keep" restoring, and refusing a replaced memory or one past its valid-until date, is
 *    `keepLearning` / `restore` (lib/learnings.ts).
 *
 * Same visual language as FlowDiagram: pure SVG, theme tokens only, arrows that appear in order.
 * It is drawn twice, a wide layout and a tall one, and CSS shows one of them: states side by side
 * need about 640px, and a phone has 314px inside the card, where the other diagrams scroll sideways.
 * Both read their words from `copy`, so the two cannot disagree.
 */

const CHIP_H = 22;
/** Average advance of the 11px chip text, a little generous so a label never touches the edge. */
const CHIP_CHAR_W = 6;

const READS = ["search result", "fetch by id", "helpful", "confirm", "kudos", "keep"];
const NOT_READS = ["a person opening a page"];
const EXEMPT = ["standards", "decisions", "pinned house rules"];

type Tone = "teal" | "navy" | "coral";
const TONE_CLASS: Record<Tone, string> = {
  teal: styles.chipTeal,
  navy: styles.chipNavy,
  coral: styles.chipCoral,
};

function chipWidth(text: string, icon: boolean) {
  return Math.round(text.length * CHIP_CHAR_W + 20 + (icon ? 14 : 0));
}

/** Chips in a row from `x`. Rows are given whole, so a layout decides where a row breaks. */
function ChipRow({ x, y, items, tone, icon = false }: { x: number; y: number; items: string[]; tone: Tone; icon?: boolean }) {
  let cursor = x;
  return (
    <>
      {items.map((text) => {
        const w = chipWidth(text, icon);
        const left = cursor;
        cursor += w + 8;
        return (
          <g key={text}>
            <rect className={TONE_CLASS[tone]} x={left} y={y} width={w} height={CHIP_H} rx={CHIP_H / 2} />
            {icon ? (
              <path className={styles.chipIcon} d={`M${left + 10} ${y + 7} l8 8 M${left + 18} ${y + 7} l-8 8`} />
            ) : null}
            <text className={styles.chipText} x={left + (icon ? 24 : 10)} y={y + 15}>
              {text}
            </text>
          </g>
        );
      })}
    </>
  );
}

/**
 * Solid heads, steel for a way to Archived and teal for a read or a keep, each the colour of its
 * line. The tip (8, 4) is the reference point, so the tip is the end of the path.
 */
function ArrowMarkers({ id }: { id: string }) {
  return (
    <defs>
      <marker id={id} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" className={styles.arrowHead} />
      </marker>
      <marker id={`${id}-keep`} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L8 4 L0 8 z" className={styles.arrowHeadTeal} />
      </marker>
    </defs>
  );
}

// The curved arrows are drawn as rounded corners with a straight stretch before the head, so the
// head always sits on a line that points at the box it ends on, and the tip is exactly on the box's
// edge. A long curve would end on the box at a slant, and the head, which points along the last
// instant of the path, would look off from the curve that leads to it.

/** A loop on a box: up out of its top edge, over, and straight down onto the edge again. */
function topLoop(x1: number, x2: number, edgeY: number, rise: number, r = 10): string {
  const top = edgeY - rise;
  return `M${x1} ${edgeY} V${top + r} Q ${x1} ${top} ${x1 + r} ${top} H${x2 - r} Q ${x2} ${top} ${x2} ${top + r} V${edgeY}`;
}

/** Out of the bottom edge of one box, along underneath at `runY`, and straight up onto another's bottom edge. */
function underPath(xFrom: number, xTo: number, edgeY: number, runY: number, r = 12): string {
  return `M${xFrom} ${edgeY} V${runY - r} Q ${xFrom} ${runY} ${xFrom - r} ${runY} H${xTo + r} Q ${xTo} ${runY} ${xTo} ${runY - r} V${edgeY}`;
}

/** Out of the right edge of a box at `yFrom`, round the side by `out`, and straight in on the right edge of another at `yTo` (higher up). */
function sidePath(edgeX: number, yFrom: number, yTo: number, out: number, r = 12): string {
  const x = edgeX + out;
  return `M${edgeX} ${yFrom} H${x - r} Q ${x} ${yFrom} ${x} ${yFrom - r} V${yTo + r} Q ${x} ${yTo} ${x - r} ${yTo} H${edgeX}`;
}

type Copy = {
  reads: string;
  readsSub: string;
  inactive: string;
  inactiveSub: string;
  validUntil: string;
  validUntilSub: string;
  retired: string;
  keep: string;
  keepSub: string;
};

// The wide layout -----------------------------------------------------------------------------

const W = 780;
const H = 392;
const NODE_TOP = 88;
const NODE_H = 118;
const NODE_BOTTOM = NODE_TOP + NODE_H;
const SAVED = { x: 20, w: 214 };
const ARCHIVED = { x: 546, w: 214 };
const FROM_X = SAVED.x + SAVED.w;
const TO_X = ARCHIVED.x;
const MID_X = (FROM_X + TO_X) / 2;
const KEY_X = 20;
const CHIPS_X = 172;

function Wide({ copy, label, marker }: { copy: Copy; label: string; marker: string }) {
  const keepMarker = `${marker}-keep`;
  const keyY = (row: number) => 292 + row * 32;

  return (
    <svg className={`${styles.lifeSvg} ${styles.lifeWide}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <ArrowMarkers id={marker} />

      {/* The two states. */}
      <rect className={`${styles.brainFill} ${styles.brainStroke}`} x={SAVED.x} y={NODE_TOP} width={SAVED.w} height={NODE_H} rx="16" />
      <text className={styles.stateTitle} x={SAVED.x + 18} y={NODE_TOP + 32}>Saved</text>
      <text className={styles.sub} x={SAVED.x + 18} y={NODE_TOP + 54}>active</text>
      <text className={styles.sub} x={SAVED.x + 18} y={NODE_TOP + 70}>found by search</text>

      <rect className={styles.archivedBox} x={ARCHIVED.x} y={NODE_TOP} width={ARCHIVED.w} height={NODE_H} rx="16" />
      <text className={styles.stateTitle} x={ARCHIVED.x + 18} y={NODE_TOP + 32}>Archived</text>
      <text className={styles.sub} x={ARCHIVED.x + 18} y={NODE_TOP + 54}>hidden from search</text>
      <text className={styles.sub} x={ARCHIVED.x + 18} y={NODE_TOP + 70}>still there</text>

      {/* A read keeps it where it is: a loop on Saved. */}
      <g className={styles.step}>
        <path
          className={styles.lcEdgeGood}
          d={topLoop(SAVED.x + 52, SAVED.x + 154, NODE_TOP, 30)}
          markerEnd={`url(#${keepMarker})`}
        />
        <text className={styles.lcLabel} x={SAVED.x + 103} y="20" textAnchor="middle">{copy.reads}</text>
        <text className={styles.lcSub} x={SAVED.x + 103} y="34" textAnchor="middle">{copy.readsSub}</text>
      </g>

      {/* Saved to Archived. */}
      <g className={styles.step} style={{ animationDelay: "260ms" }}>
        <path className={styles.lcEdge} d={`M${FROM_X} ${NODE_TOP + 24} H${TO_X}`} markerEnd={`url(#${marker})`} />
        <text className={styles.lcLabel} x={MID_X} y={NODE_TOP + 18} textAnchor="middle">{copy.inactive}</text>
        <text className={styles.lcSub} x={MID_X} y={NODE_TOP + 38} textAnchor="middle">{copy.inactiveSub}</text>
      </g>
      <g className={styles.step} style={{ animationDelay: "520ms" }}>
        <path className={styles.lcEdge} d={`M${FROM_X} ${NODE_TOP + 64} H${TO_X}`} markerEnd={`url(#${marker})`} />
        <text className={styles.lcLabel} x={MID_X} y={NODE_TOP + 58} textAnchor="middle">{copy.validUntil}</text>
        <text className={styles.lcSub} x={MID_X} y={NODE_TOP + 78} textAnchor="middle">{copy.validUntilSub}</text>
      </g>
      <g className={styles.step} style={{ animationDelay: "780ms" }}>
        <path className={styles.lcEdge} d={`M${FROM_X} ${NODE_TOP + 102} H${TO_X}`} markerEnd={`url(#${marker})`} />
        <text className={styles.lcLabelMuted} x={MID_X} y={NODE_TOP + 96} textAnchor="middle">{copy.retired}</text>
      </g>

      {/* Archived back to Saved. */}
      <g className={styles.step} style={{ animationDelay: "1040ms" }}>
        <path
          className={styles.lcEdgeGood}
          d={underPath(ARCHIVED.x + ARCHIVED.w / 2, SAVED.x + SAVED.w / 2, NODE_BOTTOM, NODE_BOTTOM + 52)}
          markerEnd={`url(#${keepMarker})`}
        />
        <text className={styles.lcLabel} x={MID_X} y={NODE_BOTTOM + 22} textAnchor="middle">{copy.keep}</text>
        <text className={styles.lcSub} x={MID_X} y={NODE_BOTTOM + 38} textAnchor="middle">{copy.keepSub}</text>
      </g>

      {/* The key: what counts, what does not, and what is never archived this way. */}
      <text className={styles.keyLabel} x={KEY_X} y={keyY(0) + 15}>Counts as a read</text>
      <ChipRow x={CHIPS_X} y={keyY(0)} items={READS} tone="teal" />
      <text className={styles.keyLabel} x={KEY_X} y={keyY(1) + 15}>Does not count</text>
      <ChipRow x={CHIPS_X} y={keyY(1)} items={NOT_READS} tone="coral" icon />
      <text className={styles.keyLabel} x={KEY_X} y={keyY(2) + 15}>Never archived this way</text>
      <ChipRow x={CHIPS_X} y={keyY(2)} items={EXEMPT} tone="navy" />
    </svg>
  );
}

// The tall layout, for a phone --------------------------------------------------------------------

const NW = 340;
const NH = 620;
const N_BOX_X = 10;
const N_BOX_W = 280;
const N_RETURN_X = N_BOX_X + N_BOX_W;

function Narrow({ copy, label, marker }: { copy: Copy; label: string; marker: string }) {
  const keepMarker = `${marker}-keep`;
  const savedTop = 56;
  const savedH = 76;
  const savedBottom = savedTop + savedH;
  const archivedTop = savedBottom + 150;
  const archivedH = 126;
  const archivedBottom = archivedTop + archivedH;
  const railX = 34;
  const keyTop = archivedBottom + 22;
  /** Where the loop on Saved sits: the right-hand end of the box, with its words to the left. */
  const loopX = 232;

  return (
    <svg className={`${styles.lifeSvgNarrow} ${styles.lifeNarrow}`} viewBox={`0 0 ${NW} ${NH}`} role="img" aria-label={label}>
      <ArrowMarkers id={marker} />

      <rect className={`${styles.brainFill} ${styles.brainStroke}`} x={N_BOX_X} y={savedTop} width={N_BOX_W} height={savedH} rx="16" />
      <text className={styles.stateTitle} x={N_BOX_X + 18} y={savedTop + 32}>Saved</text>
      <text className={styles.sub} x={N_BOX_X + 18} y={savedTop + 52}>active, found by search</text>

      {/* A read keeps it where it is: a loop on Saved. */}
      <g className={styles.step}>
        <path
          className={styles.lcEdgeGood}
          d={topLoop(loopX, loopX + 30, savedTop, 28)}
          markerEnd={`url(#${keepMarker})`}
        />
        <text className={styles.lcLabel} x={loopX - 10} y={savedTop - 26} textAnchor="end">{copy.reads}</text>
        <text className={styles.lcSub} x={loopX - 10} y={savedTop - 12} textAnchor="end">{copy.readsSub}</text>
      </g>

      {/* Saved to Archived: one arrow, three reasons. */}
      <g className={styles.step} style={{ animationDelay: "260ms" }}>
        <path className={styles.lcEdge} d={`M${railX} ${savedBottom} V${archivedTop}`} markerEnd={`url(#${marker})`} />
        <text className={styles.lcLabel} x={railX + 22} y={savedBottom + 30}>{copy.inactive}</text>
        <text className={styles.lcSub} x={railX + 22} y={savedBottom + 46}>{copy.inactiveSub}</text>
        <text className={styles.lcLabel} x={railX + 22} y={savedBottom + 80}>{copy.validUntil}</text>
        <text className={styles.lcSub} x={railX + 22} y={savedBottom + 96}>{copy.validUntilSub}</text>
        <text className={styles.lcLabelMuted} x={railX + 22} y={savedBottom + 130}>{copy.retired}</text>
      </g>

      <rect className={styles.archivedBox} x={N_BOX_X} y={archivedTop} width={N_BOX_W} height={archivedH} rx="16" />
      <text className={styles.stateTitle} x={N_BOX_X + 18} y={archivedTop + 32}>Archived</text>
      <text className={styles.sub} x={N_BOX_X + 18} y={archivedTop + 52}>hidden from search, still there</text>

      {/* Archived back to Saved: the arrow runs up the right-hand side, the words sit in the box. */}
      <g className={styles.step} style={{ animationDelay: "520ms" }}>
        <path
          className={styles.lcEdgeGood}
          d={sidePath(N_RETURN_X, archivedTop + 88, savedTop + 38, 34)}
          markerEnd={`url(#${keepMarker})`}
        />
        <text className={styles.lcLabel} x={N_BOX_X + 18} y={archivedTop + 84}>{copy.keep}</text>
        <text className={styles.lcSub} x={N_BOX_X + 18} y={archivedTop + 100}>{copy.keepSub}</text>
      </g>

      <text className={styles.keyLabel} x={N_BOX_X} y={keyTop + 4}>Counts as a read</text>
      <ChipRow x={N_BOX_X} y={keyTop + 12} items={READS.slice(0, 3)} tone="teal" />
      <ChipRow x={N_BOX_X} y={keyTop + 40} items={READS.slice(3)} tone="teal" />
      <text className={styles.keyLabel} x={N_BOX_X} y={keyTop + 92}>Does not count</text>
      <ChipRow x={N_BOX_X} y={keyTop + 100} items={NOT_READS} tone="coral" icon />
      <text className={styles.keyLabel} x={N_BOX_X} y={keyTop + 144}>Never archived this way</text>
      <ChipRow x={N_BOX_X} y={keyTop + 152} items={EXEMPT} tone="navy" />
    </svg>
  );
}

export default function LifecycleDiagram({
  archiveAfter,
  firstArchive,
}: {
  /** How long without an agent read, in words: "a year". */
  archiveAfter: string;
  /** The first day the sweep can archive anything for lack of reads, for example "7 Oct 2027". */
  firstArchive: string;
}) {
  const title = "A memory's life";
  const marker = markerIdFor(title);

  const copy: Copy = {
    reads: "an agent reads it",
    readsSub: "restarts the clock",
    inactive: `no agent read it for ${archiveAfter}`,
    inactiveSub: `checked hourly, nothing before ${firstArchive}`,
    validUntil: "its valid-until date passed",
    validUntilSub: "only if the author set one",
    retired: "retired, replaced, flagged or voted down",
    keep: "keep: anyone, with a note",
    keepSub: "not if replaced, or past a valid-until date",
  };

  const label =
    `${title}. A memory is saved and active. Each time an agent reads it, through a search result, a fetch by id, or a helpful, confirm, kudos or keep, its clock restarts. ` +
    `A person opening a page does not count. An unread memory is archived after ${archiveAfter}, checked every hour and never before ${firstArchive}. ` +
    `A memory past its own valid-until date is archived too, if its author set one, and a retired or replaced memory, or a learning or practice flagged twice, is archived as well. ` +
    `A learning or practice that three colleagues marked not helpful, outnumbering its support, is archived after 90 days without a read. ` +
    `Standards, decisions and pinned house rules are never archived this way. ` +
    `Archived memories are hidden from search, and keep, with a note, brings one back, except one that was replaced or is past its valid-until date.`;

  return (
    <DiagramFigure title={title} wide>
      <Wide copy={copy} label={label} marker={marker} />
      <Narrow copy={copy} label={label} marker={`${marker}-narrow`} />
    </DiagramFigure>
  );
}
