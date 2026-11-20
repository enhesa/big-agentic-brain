import type { ReactNode } from "react";
import styles from "../../landing.module.css";
import {
  BIG,
  COLORS as C,
  FILM,
  GRID,
  HOLDS,
  HUB,
  MARK,
  MEASURED,
  SCENES,
  SHORT,
  SWARM,
  TANGLE,
  WORDS,
  blobPoints,
  litAt,
} from "@/lib/film-story.mjs";

/**
 * The showcase film as one animated SVG, drawn live in the page.
 *
 * It tells the same story as the video (showcase/film.js) from the same source,
 * lib/film-story.mjs: the same scenes, timing, words, figures and shapes. Where the video
 * paints frames, this declares each shape once and lets the browser move it.
 *
 * Every animation is SVG's own (SMIL) on one shared clock of FILM.seconds, so the film
 * needs no script to play, loops by itself, and FilmControls can pause or restart all of it
 * with one call. A server component: the markup is the whole film.
 */

const D = FILM.seconds;
export const FILM_SVG_ID = "film-svg";

/* ---------- timing ---------- */

/** Easings as SMIL splines. They match easeOut and easeInOut (both cubic) in film.js. */
const LINEAR = "0 0 1 1";
const OUT = "0.33 1 0.68 1";
const IN_OUT = "0.65 0 0.35 1";
const SINE_OUT = "0.61 1 0.88 1";
const SINE_IN = "0.12 0 0.39 0";

/** One step of an animation: at `t` seconds the value is `v`, reached with `ease`. */
type Key = [t: number, v: number | string, ease?: string];

const f = (v: number) => String(Math.round(v * 100) / 100);
const show = (v: number | string) => (typeof v === "number" ? f(v) : v);

/** Stretches a list of keys over the whole film: holds the first value before, the last after. */
function track(keys: Key[]) {
  const all: Key[] = keys.map(([t, v, ease]) => [Math.min(D, Math.max(0, t)), v, ease]);
  if (all[0][0] > 0) all.unshift([0, all[0][1]]);
  if (all[all.length - 1][0] < D) all.push([D, all[all.length - 1][1]]);
  return {
    keyTimes: all.map(([t]) => String(Math.round((t / D) * 100000) / 100000)).join(";"),
    values: all.map(([, v]) => show(v)).join(";"),
    keySplines: all
      .slice(1)
      .map(([, , ease]) => ease ?? LINEAR)
      .join(";"),
  };
}

const LOOP = { dur: `${D}s`, repeatCount: "indefinite" } as const;

/** Animates one attribute along the film's clock. */
function Anim({ attr, keys }: { attr: string; keys: Key[] }) {
  return <animate attributeName={attr} calcMode="spline" {...LOOP} {...track(keys)} />;
}

/** Animates a transform (scale, translate or rotate) along the film's clock. */
function Move({ type, keys }: { type: "scale" | "translate" | "rotate"; keys: Key[] }) {
  return <animateTransform attributeName="transform" type={type} calcMode="spline" {...LOOP} {...track(keys)} />;
}

/** Switches an attribute at given moments, with nothing in between. */
function Switch({ attr, keys }: { attr: string; keys: [t: number, v: string][] }) {
  const all = keys[0][0] > 0 ? [[0, keys[0][1]] as [number, string], ...keys] : keys;
  return (
    <animate
      attributeName={attr}
      calcMode="discrete"
      {...LOOP}
      keyTimes={all.map(([t]) => String(Math.round((Math.min(D, t) / D) * 100000) / 100000)).join(";")}
      values={all.map(([, v]) => v).join(";")}
    />
  );
}

/** Moves its parent along the path with id `href`, from its start to its end. */
function Along({ href, from, to, ease = IN_OUT }: { href: string; from: number; to: number; ease?: string }) {
  const { keyTimes, values, keySplines } = track([
    [from, 0],
    [to, 1, ease],
  ]);
  return (
    <animateMotion calcMode="spline" {...LOOP} keyTimes={keyTimes} keyPoints={values} keySplines={keySplines}>
      <mpath href={`#${href}`} />
    </animateMotion>
  );
}

/** Keys that grow a value with a small overshoot, like easeOutBack in film.js. */
const back = (from: number, to: number, a: number, b: number): Key[] => [
  [from, a],
  [from + (to - from) * 0.58, a + (b - a) * 1.1, OUT],
  [to, b, IN_OUT],
];

/** Keys that keep something unseen until `at`, then show it at once. */
const appear = (at: number, opacity = 1): Key[] => [
  [at, 0],
  [at + 0.02, opacity],
];

/* ---------- shapes ---------- */

type Point = number[];
type Map = (x: number, y: number) => Point;

/** Path data through a list of points, taking every `step`th one. */
function pathD(points: Point[], map: Map, digits: number, step = 1) {
  const k = 10 ** digits;
  const out: string[] = [];
  for (let i = 0; i < points.length; i += step) {
    const [x, y] = map(points[i][0], points[i][1]);
    out.push(`${Math.round(x * k) / k},${Math.round(y * k) / k}`);
  }
  return `M${out.join(" ")}`;
}

/** The paper cut-out shape of film.js: smooth curves through the midpoints of its corners. */
function blobD(cx: number, cy: number, rx: number, ry: number, seed: number, amount: number, n: number) {
  const pts: Point[] = blobPoints(cx, cy, rx, ry, seed, 0, amount, n);
  const mid = (a: Point, b: Point) => `${f((a[0] + b[0]) / 2)},${f((a[1] + b[1]) / 2)}`;
  let d = `M${mid(pts[n - 1], pts[0])}`;
  for (let i = 0; i < n; i++) d += `Q${f(pts[i][0])},${f(pts[i][1])} ${mid(pts[i], pts[(i + 1) % n])}`;
  return `${d}Z`;
}

/** Scales its children around a point. */
function Around({ x, y, keys, children }: { x: number; y: number; keys: Key[]; children: ReactNode }) {
  return (
    <g transform={`translate(${f(x)} ${f(y)})`}>
      <g>
        <Move type="scale" keys={keys} />
        {children}
      </g>
    </g>
  );
}

/** A slow breath, so the brain is never quite still. It runs on its own short loop. */
function Breath({ children }: { children: ReactNode }) {
  return (
    <g>
      <animateTransform
        attributeName="transform"
        type="scale"
        values="1;1.025;1;0.975;1"
        dur="2.6s"
        repeatCount="indefinite"
      />
      {children}
    </g>
  );
}

/** A straight line that grows from its start to its end. */
function Grow(props: {
  from: Point;
  to: Point;
  start: number;
  end: number;
  ease?: string;
  stroke: string;
  width: number;
  opacity?: number;
}) {
  const { from, to, start, end, ease = OUT, stroke, width, opacity = 1 } = props;
  return (
    <line x1={f(from[0])} y1={f(from[1])} x2={f(from[0])} y2={f(from[1])} stroke={stroke} strokeWidth={width} opacity={0}>
      <Anim attr="opacity" keys={appear(start, opacity)} />
      {from[0] !== to[0] && (
        <Anim
          attr="x2"
          keys={[
            [start, from[0]],
            [end, to[0], ease],
          ]}
        />
      )}
      {from[1] !== to[1] && (
        <Anim
          attr="y2"
          keys={[
            [start, from[1]],
            [end, to[1], ease],
          ]}
        />
      )}
    </line>
  );
}

/* ---------- words ---------- */

const HEAD = "var(--font-head)";
const BODY = "var(--font-body)";

/** Words that appear one after another while their block rises into place, like say() in film.js. */
function Say(props: {
  lines: string[][];
  x: number;
  y: number;
  at: number;
  size?: number;
  weight?: number;
  family?: string;
  color?: string;
  center?: boolean;
  lh?: number;
  stagger?: number;
  spacing?: number;
  gap?: string;
  /**
   * For a line too wide for the frame. The video shrinks such a line until it fits; here `size` is
   * the size it shrinks to, and the line is held to the frame's room whatever font draws it.
   */
  fit?: boolean;
}) {
  const { lines, x, y, at, size = 60, weight = 800, family = HEAD, color = C.ink, center, stagger = 0.09 } = props;
  const lh = props.lh ?? size * 1.12;
  let index = 0;
  return (
    <g>
      <Move
        type="translate"
        keys={[
          [at, "0 18"],
          [at + 0.6, "0 0", OUT],
        ]}
      />
      {lines.map((words, row) => (
        <text
          key={row}
          x={x}
          y={f(y + row * lh)}
          fill={color}
          fontSize={size}
          fontWeight={weight}
          letterSpacing={props.spacing}
          textLength={props.fit ? FILM.width - x - 80 : undefined}
          lengthAdjust={props.fit ? "spacingAndGlyphs" : undefined}
          textAnchor={center ? "middle" : undefined}
          style={{ fontFamily: family }}
        >
          {words.map((word, i) => {
            const begin = at + index++ * stagger;
            return (
              <tspan key={i} fillOpacity={0}>
                <Anim
                  attr="fill-opacity"
                  keys={[
                    [begin, 0],
                    [begin + 0.5, 1, OUT],
                  ]}
                />
                {i < words.length - 1 ? word + (props.gap ?? " ") : word}
              </tspan>
            );
          })}
        </text>
      ))}
    </g>
  );
}

const words = (text: string) => text.split(" ");

/* ---------- scenes ---------- */

const FADE = 0.45;

/** One scene: seen only between its start and end, fading in and out over its neighbours. */
function Scene({ id, children }: { id: string; children: (at: (seconds: number) => number) => ReactNode }) {
  const scene = SCENES.find((s) => s.id === id)!;
  const start = scene.start;
  const end = Math.min(scene.end, D);
  return (
    <g opacity={0} visibility="hidden">
      <Switch
        attr="visibility"
        keys={
          start > 0
            ? [
                [0, "hidden"],
                [start, "visible"],
                [end, "hidden"],
              ]
            : [
                [0, "visible"],
                [end, "hidden"],
              ]
        }
      />
      <Anim
        attr="opacity"
        keys={[
          [start, 0],
          [start + FADE, 1],
          [end - FADE, 1],
          [end, 0],
        ]}
      />
      {children((seconds) => start + seconds)}
    </g>
  );
}

const BIG_END = BIG(1, 0);
const TANGLE_D = pathD(TANGLE, BIG, 1);
/** Fewer points for the path that changes shape: its data is repeated in the animation. */
const TANGLE_LOOSE_D = pathD(TANGLE, BIG, 0, 2);
const SHORT_LOOSE_D = pathD(SHORT, BIG, 0, 2);
const BRAIN_D = blobD(0, 0, HUB.r, HUB.r, 11, 0.07, 10);

/** 1. One agent, one tangle. */
function Alone() {
  return (
    <Scene id="alone">
      {(at) => (
        <>
          <circle cx={BIG_END[0]} cy={BIG_END[1]} r={13} stroke={C.steel} strokeWidth={3} />
          <path id="film-tangle" d={TANGLE_D} pathLength={1} strokeDasharray="1 2" strokeDashoffset={1} stroke={C.ink} strokeWidth={4}>
            <Anim
              attr="stroke-dashoffset"
              keys={[
                [at(0.7), 1],
                [at(4.9), 0, IN_OUT],
              ]}
            />
          </path>
          <g>
            <Along href="film-tangle" from={at(0.7)} to={at(4.9)} />
            <circle r={12} fill={C.coral}>
              <Anim attr="r" keys={back(at(0.15), at(0.7), 0, 12)} />
            </circle>
          </g>
          <Say lines={[words(WORDS.alone)]} x={96} y={632} at={at(0.5)} />
        </>
      )}
    </Scene>
  );
}

/** 2. Twelve agents, the same tangle, twelve times. */
function Again() {
  return (
    <Scene id="again">
      {(at) => (
        <>
          {GRID.map((cell, i) => {
            const map: Map = (x, y) => [cell.ox + x * 200, cell.oy + y * 142];
            const begin = at(cell.begin);
            const end = map(1, 0);
            return (
              <g key={i} opacity={0}>
                <Anim
                  attr="opacity"
                  keys={[
                    [begin - 0.3, 0],
                    [begin, 1],
                  ]}
                />
                <circle cx={end[0]} cy={end[1]} r={7} stroke={C.steel} strokeWidth={2.5} />
                <path
                  id={`film-cell-${i}`}
                  d={pathD(cell.points, map, 1, 2)}
                  pathLength={1}
                  strokeDasharray="1 2"
                  strokeDashoffset={1}
                  stroke={C.steel}
                  strokeWidth={3}
                >
                  <Anim
                    attr="stroke-dashoffset"
                    keys={[
                      [begin, 1],
                      [begin + 3.4, 0, IN_OUT],
                    ]}
                  />
                </path>
                <g>
                  <Along href={`film-cell-${i}`} from={begin} to={begin + 3.4} />
                  <circle r={8} fill={cell.odd ? C.coral : C.ink} />
                </g>
              </g>
            );
          })}
          <Say lines={[words(WORDS.again)]} x={96} y={632} at={at(0.6)} size={54.5} fit />
        </>
      )}
    </Scene>
  );
}

/** 3. One agent's tangle straightens into the answer, and the answer becomes the brain. */
function Learns() {
  return (
    <Scene id="learns">
      {(at) => (
        <>
          <Around
            x={HUB.x}
            y={HUB.y}
            keys={[
              [at(3.2), 1],
              [at(4.5), 0.001, IN_OUT],
            ]}
          >
            <g transform={`translate(${-HUB.x} ${-HUB.y})`}>
              <Anim
                attr="opacity"
                keys={[
                  [at(4.2), 1],
                  [at(4.5), 0],
                ]}
              />
              <circle cx={BIG_END[0]} cy={BIG_END[1]} r={13} stroke={C.steel} strokeWidth={3} vectorEffect="non-scaling-stroke" />
              <path d={TANGLE_LOOSE_D} stroke={C.ink} strokeWidth={4} vectorEffect="non-scaling-stroke">
                <Anim
                  attr="d"
                  keys={[
                    [at(1.3), TANGLE_LOOSE_D],
                    [at(3.0), SHORT_LOOSE_D, IN_OUT],
                  ]}
                />
                <Anim
                  attr="stroke"
                  keys={[
                    [at(1.3), C.ink],
                    [at(3.0), C.teal, IN_OUT],
                  ]}
                />
                <Anim
                  attr="stroke-width"
                  keys={[
                    [at(3.2), 4],
                    [at(4.5), 9, IN_OUT],
                  ]}
                />
              </path>
              <circle cx={BIG_END[0]} cy={BIG_END[1]} r={12} fill={C.coral} />
            </g>
          </Around>
          <Around x={HUB.x} y={HUB.y} keys={back(at(3.9), at(4.9), 0.001, 1)}>
            <Breath>
              <path d={BRAIN_D} fill={C.teal} />
            </Breath>
          </Around>
          <Say lines={[words(WORDS.learns)]} x={96} y={632} at={at(0.5)} />
        </>
      )}
    </Scene>
  );
}

/** 4. The answer reaches every other agent. */
function Knows() {
  return (
    <Scene id="knows">
      {(at) => (
        <>
          {/* Night spreads from the brain until it fills the frame, so the knowledge reads as light. */}
          <Around
            x={HUB.x}
            y={HUB.y}
            keys={[
              [at(0), 0.0625],
              [at(0.9), 1, IN_OUT],
            ]}
          >
            <path d={blobD(0, 0, 960, 960, 13, 0.04, 12)} fill={C.ink} />
          </Around>
          {[0, 1, 2].map((k) => {
            const from = at(0.9 + k * 0.55);
            const to = at(3.5 + k * 0.55);
            return (
              <Around
                key={k}
                x={HUB.x}
                y={HUB.y}
                keys={[
                  [from, 0.2],
                  [to, 1.45, OUT],
                ]}
              >
                <path d={blobD(0, 0, 440, 205, 40 + k, 0.025, 14)} stroke={C.sage} strokeWidth={6} vectorEffect="non-scaling-stroke" opacity={0}>
                  <Anim
                    attr="opacity"
                    keys={[
                      [from, 0],
                      [from + 0.02, 0.9],
                      [to, 0],
                    ]}
                  />
                </path>
              </Around>
            );
          })}
          {SWARM.map((agent, i) => {
            const lit = at(litAt(agent));
            const from = [HUB.x + Math.cos(agent.a) * HUB.r * 1.6, HUB.y + Math.sin(agent.a) * HUB.r * 1.15];
            return (
              <g key={i}>
                <Grow from={from} to={[agent.x, agent.y]} start={lit} end={lit + 0.45} stroke={C.teal} width={3} opacity={0.7} />
                <Around x={agent.x} y={agent.y} keys={back(at(0.15 + i * 0.05), at(0.6 + i * 0.05), 0.001, 1)}>
                  <circle r={12} fill={C.paper}>
                    <Anim
                      attr="r"
                      keys={[
                        [lit, 12],
                        [lit + 0.225, 18, SINE_OUT],
                        [lit + 0.45, 12, SINE_IN],
                      ]}
                    />
                    <Anim
                      attr="fill"
                      keys={[
                        [lit, C.paper],
                        [lit + 0.45, C.amber],
                      ]}
                    />
                  </circle>
                </Around>
              </g>
            );
          })}
          <g transform={`translate(${HUB.x} ${HUB.y})`}>
            <Breath>
              <path d={BRAIN_D} fill={C.teal} />
            </Breath>
          </g>
          <Say lines={[words(WORDS.knows)]} x={96} y={632} at={at(0.9)} color={C.paper} />
        </>
      )}
    </Scene>
  );
}

/** The five small machines of scene 5. `g` turns seconds into the machine's own time. */
function Glyph({ i, g }: { i: number; g: (seconds: number) => number }) {
  if (i === 0) {
    return (
      <>
        <path d={blobD(0, 0, 50, 46, 21, 0.08, 9)} fill={C.teal} />
        {[44, 34, 22].map((length, k) => (
          <Grow
            key={k}
            from={[-22, -14 + k * 14]}
            to={[-22 + length, -14 + k * 14]}
            start={g(0.25 + k * 0.18)}
            end={g(0.7 + k * 0.18)}
            stroke={C.paper}
            width={5}
          />
        ))}
      </>
    );
  }
  if (i === 1) {
    const arc = (up: number, back: boolean) => {
      const pts: string[] = [];
      for (let n = 0; n <= 25; n++) {
        const k = back ? 1 - n / 25 : n / 25;
        pts.push(`${f(-40 + 80 * k)},${f(6 - Math.sin(Math.PI * k) * 44 * up)}`);
      }
      return `M${pts.join(" ")}`;
    };
    const trips = [
      { id: "film-there", d: arc(1, false), color: C.ink, from: g(0.25), to: g(0.95) },
      { id: "film-back", d: arc(-0.75, true), color: C.coral, from: g(1.1), to: g(1.8) },
    ];
    return (
      <>
        <circle cx={-40} cy={6} r={14} fill={C.ink} />
        <circle cx={40} cy={6} r={14} fill={C.coral} />
        {trips.map((trip) => (
          <g key={trip.id}>
            <path id={trip.id} d={trip.d} pathLength={1} strokeDasharray="1 2" strokeDashoffset={1} stroke={trip.color} strokeWidth={3}>
              <Anim
                attr="stroke-dashoffset"
                keys={[
                  [trip.from, 1],
                  [trip.to, 0, IN_OUT],
                ]}
              />
            </path>
            <g opacity={0}>
              <Anim
                attr="opacity"
                keys={[
                  [trip.from, 0],
                  [trip.from + 0.02, 1],
                  [trip.to - 0.02, 1],
                  [trip.to, 0],
                ]}
              />
              <Along href={trip.id} from={trip.from} to={trip.to} />
              <circle r={6} fill={trip.color} />
            </g>
          </g>
        ))}
      </>
    );
  }
  if (i === 2) {
    return (
      <>
        <circle r={42} stroke={C.amber} strokeWidth={9} />
        <line x1={0} y1={0} x2={0} y2={-26} stroke={C.ink} strokeWidth={6}>
          <Move
            type="rotate"
            keys={[
              [g(0.2), 0],
              [g(1.5), 360, IN_OUT],
            ]}
          />
        </line>
        <circle r={6} fill={C.ink} />
        <circle cx={36} cy={-38} r={0} fill={C.coral}>
          <Anim attr="r" keys={back(g(1.45), g(1.85), 0, 11)} />
        </circle>
      </>
    );
  }
  if (i === 3) {
    return (
      <>
        <rect x={-34} y={-42} width={62} height={78} rx={10} fill={C.sage}>
          <Move
            type="translate"
            keys={[
              [g(0.2), "0 0"],
              [g(0.9), "-14 8", OUT],
            ]}
          />
        </rect>
        <g>
          <Move
            type="translate"
            keys={[
              [g(0.2), "0 0"],
              [g(0.9), "10 -4", OUT],
            ]}
          />
          <rect x={-28} y={-42} width={62} height={78} rx={10} fill={C.ink} />
          {[38, 38, 22].map((length, k) => (
            <Grow
              key={k}
              from={[-16, -20 + k * 16]}
              to={[-16 + length, -20 + k * 16]}
              start={g(0.6 + k * 0.15)}
              end={g(1.0 + k * 0.15)}
              stroke={C.paper}
              width={4}
            />
          ))}
        </g>
      </>
    );
  }
  return (
    <>
      {[0, 1, 2].map((k) => (
        <rect key={k} x={-55 + k * 38} y={-44} width={32} height={88} rx={9} fill={C.sand} />
      ))}
      <rect x={-51} y={-38} width={24} height={24} rx={6} fill={C.ink}>
        <Move
          type="translate"
          keys={[
            [g(0.3), "0 0"],
            [g(0.85), "38 14", IN_OUT],
            [g(1.05), "38 14"],
            [g(1.6), "76 28", IN_OUT],
          ]}
        />
        <Switch
          attr="fill"
          keys={[
            [0, C.ink],
            [g(1.6), C.teal],
          ]}
        />
      </rect>
      <rect x={-51} y={8} width={24} height={14} rx={5} fill={C.steel} />
      <rect x={-13} y={-8} width={24} height={14} rx={5} fill={C.steel} />
    </>
  );
}

/** 5. What BAB holds, as five small machines. */
function Holds() {
  return (
    <Scene id="holds">
      {(at) => (
        <>
          {HOLDS.map((hold, i) => {
            const begin = at(hold.begin);
            return (
              <g key={hold.name}>
                <g opacity={0}>
                  <Anim
                    attr="opacity"
                    keys={[
                      [begin, 0],
                      [begin + 0.2, 1],
                    ]}
                  />
                  <Around x={hold.x} y={280} keys={back(begin, begin + 0.45, 0.001, 1.5)}>
                    <Glyph i={i} g={(seconds) => begin + seconds} />
                  </Around>
                </g>
                <Say lines={[[hold.name]]} x={hold.x} y={436} at={begin + 0.2} size={32} weight={700} center />
              </g>
            );
          })}
          <Say lines={[words(WORDS.holds)]} x={96} y={632} at={at(0.4)} size={53.6} fit />
        </>
      )}
    </Scene>
  );
}

/** The numbers a bar counts through on its way up. Each shows from its moment to the next. */
function countSteps(final: number) {
  const steps = [0];
  for (let v = 1; v < final; v += Math.max(1, Math.round(final / 16))) steps.push(v);
  steps.push(final);
  // easeOut reaches value v when 1 - (1 - k)^3 = (v - 0.5) / final.
  return steps.map((v) => ({ v, k: v === 0 ? 0 : 1 - Math.cbrt(1 - (v - 0.5) / final) }));
}

/** 6. The measured result, with the README's own wording. */
function Measured() {
  const { base, full, bars } = MEASURED;
  const text = WORDS.measured;
  return (
    <Scene id="measured">
      {(at) => (
        <>
          <clipPath id="film-above">
            <rect width={FILM.width} height={base} />
          </clipPath>
          <line x1={700} y1={base} x2={1180} y2={base} stroke={C.ink} strokeWidth={3} />
          {bars.map((bar) => {
            const from = at(bar.at);
            const to = from + 1.3;
            const height = full * bar.share;
            const steps = countSteps(Math.round(bar.share * 100));
            return (
              <g key={bar.label}>
                {/* The bar is 16 taller than it shows, so only its top corners are round. */}
                <g clipPath="url(#film-above)">
                  <rect x={bar.x - 70} y={base} width={140} height={16} rx={16} fill={C[bar.color as "steel" | "teal"]}>
                    <Anim
                      attr="y"
                      keys={[
                        [from, base],
                        [to, base - height, OUT],
                      ]}
                    />
                    <Anim
                      attr="height"
                      keys={[
                        [from, 16],
                        [to, height + 16, OUT],
                      ]}
                    />
                  </rect>
                </g>
                <g opacity={0}>
                  <Anim
                    attr="opacity"
                    keys={[
                      [from, 0],
                      [from + 0.3, 1],
                    ]}
                  />
                  <g>
                    <Move
                      type="translate"
                      keys={[
                        [from, "0 0"],
                        [to, `0 ${f(-height)}`, OUT],
                      ]}
                    />
                    {steps.map((step, n) => (
                      <text
                        key={step.v}
                        x={bar.x}
                        y={base - 18}
                        fill={C.ink}
                        fontSize={68}
                        fontWeight={800}
                        textAnchor="middle"
                        visibility="hidden"
                        style={{ fontFamily: HEAD }}
                      >
                        <Switch
                          attr="visibility"
                          keys={
                            n === steps.length - 1
                              ? [
                                  [0, "hidden"],
                                  [from + 1.3 * step.k, "visible"],
                                ]
                              : [
                                  [0, "hidden"],
                                  [from + 1.3 * step.k, "visible"],
                                  [from + 1.3 * steps[n + 1].k, "hidden"],
                                ]
                          }
                        />
                        {`${step.v}%`}
                      </text>
                    ))}
                  </g>
                  <text x={bar.x} y={base + 38} fill={C.steel} fontSize={22} fontWeight={500} textAnchor="middle" style={{ fontFamily: BODY }}>
                    {bar.label}
                  </text>
                </g>
              </g>
            );
          })}
          <Say lines={[[text.eyebrow]]} x={96} y={236} at={at(0.3)} size={18} weight={600} family={BODY} color={C.teal} spacing={4} />
          <Say lines={text.title.map(words)} x={96} y={310} at={at(0.5)} />
          <Say lines={text.note.map(words)} x={96} y={520} at={at(2.2)} size={20} weight={400} family={BODY} color={C.steel} lh={30} stagger={0.03} />
        </>
      )}
    </Scene>
  );
}

/** 7. Three agents join into the mark, and the name. */
function Name() {
  const text = WORDS.name;
  const facts = text.facts.flatMap((fact, i) => (i === 0 ? [fact] : ["·", fact]));
  return (
    <Scene id="name">
      {(at) => (
        <>
          {[
            [0, 1],
            [0, 2],
            [1, 2],
          ].map(([a, b]) => (
            <Grow
              key={`${a}${b}`}
              from={[MARK[a].x, MARK[a].y]}
              to={[MARK[b].x, MARK[b].y]}
              start={at(1.2)}
              end={at(2.0)}
              ease={IN_OUT}
              stroke={C.teal}
              width={20}
            />
          ))}
          {MARK.map((dot, i) => (
            <circle key={i} cx={dot.from[0]} cy={dot.from[1]} r={30} fill={C.teal}>
              {dot.from[0] !== dot.x && (
                <Anim
                  attr="cx"
                  keys={[
                    [at(0.2 + i * 0.12), dot.from[0]],
                    [at(1.2 + i * 0.12), dot.x, OUT],
                  ]}
                />
              )}
              <Anim
                attr="cy"
                keys={[
                  [at(0.2 + i * 0.12), dot.from[1]],
                  [at(1.2 + i * 0.12), dot.y, OUT],
                ]}
              />
            </circle>
          ))}
          <Say lines={[words(text.title)]} x={640} y={424} at={at(1.6)} size={84} center />
          <Say lines={[words(text.line)]} x={640} y={486} at={at(2.3)} size={36} weight={700} color={C.teal} center />
          <Say lines={[facts]} x={640} y={560} at={at(3.0)} size={22} weight={400} family={BODY} color={C.steel} center stagger={0.05} gap={"  "} />
        </>
      )}
    </Scene>
  );
}

export default function FilmSvg({ className, describedBy }: { className?: string; describedBy?: string }) {
  return (
    <svg
      id={FILM_SVG_ID}
      className={className ?? styles.filmSvg}
      viewBox={`0 0 ${FILM.width} ${FILM.height}`}
      role="img"
      aria-label="The Big Agentic Brain film"
      aria-describedby={describedBy}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Still on purpose, like the video's backdrop. */}
      <rect width={FILM.width} height={FILM.height} fill={C.paper} />
      <path d={blobD(1130, 640, 330, 250, 3, 0.12, 9)} fill={C.sand} opacity={0.55} />
      <path d={blobD(110, 70, 250, 190, 5, 0.14, 8)} fill={C.sand} opacity={0.5} />
      <Alone />
      <Again />
      <Learns />
      <Knows />
      <Holds />
      <Measured />
      <Name />
    </svg>
  );
}
