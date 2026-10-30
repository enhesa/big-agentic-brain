import { DiagramFigure, markerIdFor } from "./DocsSection";
import styles from "./docs.module.css";

/**
 * The tables of bab.db that matter, grouped the way people think about them, and the foreign keys
 * between the main ones. Drawn from lib/db.ts (CREATE TABLE in the migrations) and checked against
 * the code that still writes each table. Left out on purpose:
 *
 * - api_tokens, the browser-link code table, device_connects, push_subscriptions: dropped again by later
 *   migrations (`DROP TABLE IF EXISTS` in runMigrationV30, V29, V34 and V26 in lib/db.ts), and
 *   nothing writes them.
 * - learnings_fts and feedback_fts are drawn as a note on their table, not as boxes: they are
 *   search indexes (FTS5), kept in step by triggers.
 *
 * The retention numbers and the migration count come in as props from the code's own constants,
 * so this drawing cannot drift from them (tests/docs-page.test.ts pins the migration count).
 */

const TITLE = "The data";

type Table = { name: string; sub: string; main?: boolean };
type Group = { id: string; col: number; row: number; title: string; tables: Table[] };

const COL_X = [8, 232, 456, 680];
const ZONE_W = 196;
const BOX_W = 176;
const BOX_H = 38;
const PITCH = 54;
const ZONE_TOP = 10;

export default function DataDiagram({
  auditDays,
  migrations,
}: {
  /** config().retention.auditDays (BAB_AUDIT_RETENTION_DAYS). */
  auditDays: number;
  /** CURRENT_VERSION (lib/db.ts): migrations are numbered 1 to this. */
  migrations: number;
}) {
  const groups: Group[] = [
    {
      id: "memory",
      col: 0,
      row: 0,
      title: "MEMORY",
      tables: [
        { name: "votes", sub: "reactions" },
        { name: "learnings", sub: "with learnings_fts index", main: true },
        { name: "supersession_links", sub: "old to new" },
        { name: "memory_comments", sub: "context" },
      ],
    },
    {
      id: "messages",
      col: 0,
      row: 1,
      title: "MESSAGES",
      tables: [
        { name: "threads", sub: "one per conversation" },
        { name: "messages", sub: "from, to, body" },
      ],
    },
    {
      id: "people",
      col: 1,
      row: 0,
      title: "PEOPLE AND IDENTITY",
      tables: [
        { name: "proxy_links", sub: "browser to person" },
        { name: "users", sub: "one per person", main: true },
        { name: "devices", sub: "computers, secrets hashed" },
        { name: "mcp_connections", sub: "Mcp-Session-Id, 7 days" },
        { name: "sessions", sub: "Claude Code sessions" },
        { name: "session_links", sub: "one-time links" },
      ],
    },
    {
      id: "feedback",
      col: 2,
      row: 0,
      title: "FEEDBACK",
      tables: [
        { name: "feedback", sub: "with feedback_fts index" },
        { name: "feedback_votes", sub: "colleagues' votes" },
        { name: "feedback_comments", sub: "discussion" },
        { name: "maintainer_feedback_seen", sub: "maintainer last looked" },
      ],
    },
    {
      id: "reminders",
      col: 2,
      row: 1,
      title: "REMINDERS",
      tables: [
        { name: "todos", sub: "private reminders" },
        { name: "reminder_deliveries", sub: "due notices told" },
      ],
    },
    {
      id: "files",
      col: 1,
      row: 1,
      title: "FILES",
      tables: [
        { name: "files", sub: "owner, expiry" },
        { name: "file_shares", sub: "who may see" },
        { name: "file_links", sub: "one-hour links" },
      ],
    },
    {
      id: "bookkeeping",
      col: 3,
      row: 0,
      title: "BOOKKEEPING",
      tables: [
        { name: "audit_log", sub: `kept ${auditDays} days` },
        { name: "migrations", sub: `numbered 1 to ${migrations}` },
        { name: "idempotency", sub: "replays kept 24 h" },
        { name: "session_nudges", sub: "hook notices" },
        { name: "session_deliveries", sub: "messages announced" },
        { name: "session_learning_deliveries", sub: "retired notices sent" },
      ],
    },
  ];

  const zoneHeight = (n: number) => 76 + (n - 1) * PITCH;
  const zoneTop = (g: Group) => {
    if (g.row === 0) return ZONE_TOP;
    const above = groups.find((o) => o.col === g.col && o.row === 0)!;
    return ZONE_TOP + zoneHeight(above.tables.length) + 16;
  };
  const boxTop = (g: Group, i: number) => zoneTop(g) + 28 + i * PITCH;
  const boxX = (g: Group) => COL_X[g.col] + (ZONE_W - BOX_W) / 2;

  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const tableBox = (id: string, name: string) => {
    const g = byId[id];
    const i = g.tables.findIndex((t) => t.name === name);
    return { x: boxX(g), top: boxTop(g, i), bottom: boxTop(g, i) + BOX_H, centre: boxTop(g, i) + BOX_H / 2 };
  };

  const learnings = tableBox("memory", "learnings");
  const votes = tableBox("memory", "votes");
  const links = tableBox("memory", "supersession_links");
  const comments = tableBox("memory", "memory_comments");
  const threads = tableBox("messages", "threads");
  const messages = tableBox("messages", "messages");
  const users = tableBox("people", "users");

  const height = Math.max(...groups.map((g) => zoneTop(g) + zoneHeight(g.tables.length))) + 14;
  const marker = markerIdFor(TITLE);
  const fk = (d: string) => <path className={styles.edge} d={d} markerEnd={`url(#${marker})`} />;

  const aria =
    "The data, one SQLite file, bab.db, in six groups of tables. Memory: learnings with a learnings_fts full-text index, votes, supersession_links and memory_comments. People and identity: users, proxy_links, devices, mcp_connections, sessions and session_links. Messages: threads and messages. Reminders: todos and reminder_deliveries. Files: files, file_shares and file_links; the bytes sit on the volume under files/. Feedback: feedback with a feedback_fts index, feedback_votes, feedback_comments and maintainer_feedback_seen. Bookkeeping: " +
    `audit_log, kept ${auditDays} days; migrations, numbered 1 to ${migrations}; idempotency; session_nudges; session_deliveries and session_learning_deliveries. ` +
    "Foreign keys, drawn as arrows: votes and memory_comments point at learnings, supersession_links point at learnings, messages point at threads, and learnings point at users as their author.";

  return (
    <DiagramFigure title={TITLE} wide>
      <svg className={styles.techSvg} viewBox={`0 0 880 ${height}`} role="img" aria-label={aria}>
        <defs>
          <marker id={marker} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0 L8 4 L0 8 z" className={styles.arrowHead} />
          </marker>
        </defs>

        {groups.map((g) => (
          <g key={g.id}>
            <rect className={styles.zone} x={COL_X[g.col]} y={zoneTop(g)} width={ZONE_W} height={zoneHeight(g.tables.length)} rx="14" />
            <text className={styles.zoneLabel} x={COL_X[g.col] + 12} y={zoneTop(g) + 18}>{g.title}</text>
            {g.tables.map((t, i) => (
              <g key={t.name}>
                <rect
                  className={t.main ? `${styles.brainFill} ${styles.brainStroke}` : `${styles.boxFill} ${styles.boxStroke}`}
                  x={boxX(g)}
                  y={boxTop(g, i)}
                  width={BOX_W}
                  height={BOX_H}
                  rx="9"
                />
                <text className={styles.tableName} x={boxX(g) + 10} y={boxTop(g, i) + 16}>{t.name}</text>
                <text className={styles.sub} x={boxX(g) + 10} y={boxTop(g, i) + 30}>{t.sub}</text>
              </g>
            ))}
          </g>
        ))}

        {/* Foreign keys: from the table that holds the key to the row it names. */}
        {fk(`M${votes.x + 30} ${votes.bottom} V${learnings.top}`)}
        {fk(`M${links.x + 30} ${links.top} V${learnings.bottom}`)}
        {fk(`M${comments.x + BOX_W - 30} ${comments.top} V${learnings.bottom}`)}
        {fk(`M${messages.x + 30} ${messages.top} V${threads.bottom}`)}
        {fk(`M${learnings.x + BOX_W} ${learnings.centre} H${users.x}`)}
        <text className={styles.edgeLabel} x={(COL_X[0] + ZONE_W + COL_X[1]) / 2} y={learnings.centre - 7} textAnchor="middle">author</text>

        <text className={styles.edgeLabel} x={COL_X[0] + 4} y={zoneTop(byId.messages) + zoneHeight(2) + 24}>Arrows are foreign keys</text>
      </svg>
    </DiagramFigure>
  );
}
