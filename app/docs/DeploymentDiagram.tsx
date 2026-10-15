import { DiagramFigure, markerIdFor } from "./DocsSection";
import styles from "./docs.module.css";

/**
 * Where BAB runs, drawn left to right: the machines that call it, a reverse proxy, the one container
 * and the volume it keeps its files on. Every label is a fact from the code, and the file that
 * says it is named beside it so a change there is a change here:
 *
 * - plugin: hooks curl /api/hook (plugins/bab/hooks/hooks.json), tools call /mcp, the mod polls
 *   bab_inbox every 15 s (hooks/register.tsx PERIOD_MS)
 * - proxy and public paths: configured on the reverse proxy; identity headers stripped there
 * - container: Dockerfile (Node 24 alpine, standalone), package.json (Next.js 16), a single replica
 * - in the process: lib/rate-limit.ts, lib/events.ts (ring buffer of 200), lib/maintenance.ts
 * - volume and files: a persistent volume, lib/db.ts getDb (WAL, foreign keys, busy
 *   timeout 5 s, cache about 20 MB), lib/backup.ts (VACUUM INTO, at most every 20 h)
 *
 * Plain SVG in a server component, from the same classes as the architecture card at the top.
 */

const TITLE = "Deployment";

const ARIA =
  "Deployment, left to right. Your Claude Code, with the bab plugin, sends hooks with curl to /api/hook, tool calls to /mcp and a poll of /mcp every 15 seconds; your browser signs in through the reverse proxy. Both reach the reverse proxy, which asks for login on web pages and leaves /api, /mcp and /instructions public, with the identity headers stripped there. Behind it BAB runs as one container on one replica, Next.js 16 standalone on Node 24 alpine. It serves REST, JSON-RPC at /mcp, the web pages and server-sent events at /api/events, with a rate limiter in memory, an event bus with a ring buffer of 200 events and hourly sweeps that traffic starts, with no timer. Its files sit on a persistent volume: bab.db, SQLite through node:sqlite in WAL mode with foreign keys on, a 5 second busy timeout and a 20 MB page cache, and snapshot.db, written with VACUUM INTO at most every 20 hours for the nightly backup.";

const PLUGIN_CHIPS = ["hooks: curl /api/hook", "tools: POST /mcp", "mod: /mcp every 15 s"];
const SURFACES = ["REST /api/**", "JSON-RPC /mcp", "web pages", "SSE /api/events"];
const INSIDE = [
  { what: "Rate limiter", detail: "in memory" },
  { what: "Event bus", detail: "ring buffer, 200" },
  { what: "Hourly sweeps", detail: "run on traffic" },
];

export default function DeploymentDiagram() {
  const marker = markerIdFor(TITLE);
  const box = `${styles.boxFill} ${styles.boxStroke}`;
  const brain = `${styles.brainFill} ${styles.brainStroke}`;
  const arrow = (d: string) => <path className={styles.edge} d={d} markerEnd={`url(#${marker})`} />;

  return (
    <DiagramFigure title={TITLE} wide>
      <svg className={styles.techSvg} viewBox="0 0 880 470" role="img" aria-label={ARIA}>
        <defs>
          <marker id={marker} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" className={styles.arrowHead} />
          </marker>
        </defs>

        <rect className={styles.zone} x="216" y="30" width="656" height="430" rx="16" />
        <text className={styles.zoneLabel} x="228" y="20">CONTAINER HOST</text>

        {/* The callers. */}
        <rect className={box} x="10" y="50" width="180" height="146" rx="12" />
        <text className={styles.label} x="22" y="72">Your Claude Code</text>
        <text className={styles.sub} x="22" y="88">the bab plugin</text>
        {PLUGIN_CHIPS.map((chip, i) => (
          <g key={chip}>
            <rect className={styles.chipTeal} x="22" y={100 + i * 30} width="156" height="24" rx="12" />
            <text className={styles.chipText} x="100" y={116 + i * 30} textAnchor="middle">{chip}</text>
            {arrow(`M190 ${112 + i * 30} H240`)}
          </g>
        ))}
        <rect className={box} x="10" y="214" width="180" height="70" rx="12" />
        <text className={styles.label} x="22" y="236">Your browser</text>
        <text className={styles.sub} x="22" y="252">Signs in via the proxy</text>
        <text className={styles.sub} x="22" y="266">pages, live updates</text>
        {arrow("M190 249 H240")}

        {/* The reverse proxy. */}
        <rect className={box} x="240" y="50" width="124" height="224" rx="12" />
        <text className={styles.label} x="252" y="72">Reverse proxy</text>
        <text className={styles.chipText} x="252" y="100">Web pages</text>
        <text className={styles.sub} x="252" y="114">login first</text>
        <text className={styles.chipText} x="252" y="150">Public paths</text>
        <text className={styles.sub} x="252" y="164">/api/*   /mcp</text>
        <text className={styles.sub} x="252" y="178">/instructions/*</text>
        <text className={styles.chipText} x="252" y="214">On those paths</text>
        <text className={styles.sub} x="252" y="228">Identity headers</text>
        <text className={styles.sub} x="252" y="242">are stripped</text>
        {arrow("M364 134 H384")}

        {/* The container. */}
        <rect className={brain} x="384" y="50" width="484" height="392" rx="14" />
        <text className={styles.label} x="400" y="74">BAB, one container</text>
        <text className={styles.sub} x="400" y="90">Next.js 16 standalone, Node 24 alpine, one replica</text>

        <rect className={box} x="400" y="102" width="452" height="64" rx="10" />
        <text className={styles.label} x="412" y="121">HTTP surfaces</text>
        {SURFACES.map((s, i) => (
          <g key={s}>
            <rect className={styles.chipTeal} x={412 + i * 108} y="132" width="102" height="22" rx="11" />
            <text className={styles.chipText} x={412 + i * 108 + 51} y="147" textAnchor="middle">{s}</text>
          </g>
        ))}
        {arrow("M626 166 V190")}

        <rect className={box} x="400" y="190" width="452" height="80" rx="10" />
        <text className={styles.label} x="412" y="210">In the process</text>
        {INSIDE.map((p, i) => (
          <g key={p.what}>
            <rect className={box} x={412 + i * 144} y="220" width="136" height="40" rx="8" />
            <text className={styles.chipText} x={422 + i * 144} y="237">{p.what}</text>
            <text className={styles.sub} x={422 + i * 144} y="251">{p.detail}</text>
          </g>
        ))}
        {arrow("M626 270 V292")}

        <rect className={styles.zone} x="400" y="292" width="452" height="132" rx="10" />
        <text className={styles.zoneLabel} x="412" y="309">PERSISTENT VOLUME</text>
        <rect className={box} x="412" y="318" width="200" height="96" rx="8" />
        <text className={styles.label} x="424" y="340">bab.db</text>
        <text className={styles.sub} x="424" y="356">SQLite, node:sqlite</text>
        <text className={styles.sub} x="424" y="370">WAL, foreign keys on</text>
        <text className={styles.sub} x="424" y="384">busy timeout 5 s</text>
        <text className={styles.sub} x="424" y="398">20 MB page cache</text>
        <rect className={box} x="640" y="318" width="200" height="96" rx="8" />
        <text className={styles.label} x="652" y="340">snapshot.db</text>
        <text className={styles.sub} x="652" y="356">VACUUM INTO</text>
        <text className={styles.sub} x="652" y="370">at most every 20 h</text>
        <text className={styles.sub} x="652" y="384">for the nightly backup</text>
        {arrow("M612 366 H640")}
      </svg>
    </DiagramFigure>
  );
}
