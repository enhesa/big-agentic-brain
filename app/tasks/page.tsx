import type { Metadata } from "next";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { config } from "@/lib/config";
import { formatRelativeTime } from "@/lib/relative-time";
import { ccView, type CcView } from "@/lib/tasks";
import { branding } from "@/lib/branding";
import { ApiError } from "@/lib/errors";
import TasksPoll from "./TasksPoll";
import CardDrawer from "./CardDrawer";
import styles from "./tasks.module.css";

export const dynamic = "force-dynamic";
// No forms on the page any more; same-origin stays the referrer policy (tests/referrer-policy.test.ts).
export const metadata: Metadata = { title: "BAB Tasks", referrer: "same-origin", robots: { index: false } };

type Rec = CcView["records"][number];
type Task = Rec["tasks"][number];

const DAY_MS = 86_400_000;
/** A deadline this many days away or fewer is shown as near. */
const NEAR_DAYS = 7;

/**
 * /tasks: what the viewer's own agent sessions publish (lib/tasks.ts). In the navbar after
 * Reminders, no footer entry; the bab-tasks skill also gives the person the link. The signed-in viewer
 * only (getViewer), never anyone else's records. Every agent-written string is React text.
 * View only: no switch, settings or forms. Installing the bab-tasks plugin is the opt-in, and
 * deleting, exporting and report-app sharing are bab_tasks actions the person's agent runs.
 */
export default async function TasksPage() {
  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/tasks", via: "ui" });

  if (!config().tasks) {
    return (
      <Shell>
        <Notice>BAB Tasks is switched off on this BAB.</Notice>
      </Shell>
    );
  }
  if (!viewer) {
    return (
      <Shell>
        <Notice>Sign in to BAB in your browser to see your BAB Tasks. It is private to you.</Notice>
      </Shell>
    );
  }

  let view: CcView;
  try {
    view = ccView(viewer.ownerId);
  } catch (err) {
    return (
      <Shell>
        <Notice>{err instanceof ApiError ? err.message : "BAB Tasks is not available right now."}</Notice>
      </Shell>
    );
  }

  return (
    <Shell>
      <TasksPoll stamp={view.stamp} />
      <div className={styles.page}>
        <Board view={view} />
      </div>
    </Shell>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <h1 className={styles.h1}>BAB Tasks</h1>
      <p className={`${styles.panel} ${styles.notice}`}>{children}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function Board({ view }: { view: CcView }) {
  const projects = view.records.filter((r) => r.kind !== "recurring");
  const upkeep = view.records.filter((r) => r.kind === "recurring");
  return (
    <>
      {/* One quiet line: title, last push, data health only when something is off. */}
      <header className={`${styles.top} ${styles.topOn}`}>
        <div className={styles.titleLine}>
          <h1 className={styles.h1}>BAB Tasks</h1>
          <p className={styles.subline}>Kanban board for your agents · {view.lastPush ? <>Last push {formatRelativeTime(view.lastPush)}</> : <>Nothing published yet</>}</p>
        </div>
        <DataHealth h={view.dataHealth} />
      </header>

      {/* No separate questions section: open questions sit on their own card or upkeep row, and the
          Needs you column holds those cards. The columns carry the counts. */}
      <section className={styles.section} aria-labelledby="cc-initiatives">
        <h2 id="cc-initiatives" className={styles.srOnly}>
          Initiatives
        </h2>
        {projects.length === 0 ? <Empty /> : <Columns records={projects} />}
        {view.offPage ? (
          <p className={styles.offPage}>
            {view.offPage} done, parked or silent {view.offPage === 1 ? "initiative is" : "initiatives are"} off this page. They stay in your log.
          </p>
        ) : null}
      </section>

      {upkeep.length ? <UpkeepSection upkeep={upkeep} /> : null}

      {/* One drawer for board cards and upkeep rows: a click on either opens its details. */}
      {projects.length || upkeep.length ? (
        <CardDrawer
          panels={[...projects, ...upkeep].map((r) => ({
            id: r.id,
            title: r.title,
            body: <Detail r={r} />,
          }))}
        />
      ) : null}
    </>
  );
}

/**
 * No initiatives: installing the bab-tasks plugin is the opt-in, and the first publish of the
 * person's agent fills the board.
 */
function Empty() {
  return (
    <p className={`${styles.panel} ${styles.empty}`} data-empty="">
      No initiatives yet. Install the bab-tasks plugin (<code>/plugin install bab-tasks@{branding().marketplaceName}</code>) and your agents fill this page as they
      work.
    </p>
  );
}

function SectionHead({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <div className={styles.sectionHead}>
      <h2 id={id} className={styles.h2}>
        {title}
      </h2>
      <span className={styles.count}>
        {count}
        <span className={styles.srOnly}> {count === 1 ? "item" : "items"}</span>
      </span>
    </div>
  );
}

function DataHealth({ h }: { h: CcView["dataHealth"] }) {
  const chips: { n: number; label: string; tone: "warn" | "bad" }[] = [
    { n: h.staleQuestions, label: h.staleQuestions === 1 ? "stale question" : "stale questions", tone: "warn" },
    { n: h.silentInitiatives, label: h.silentInitiatives === 1 ? "silent initiative" : "silent initiatives", tone: "warn" },
    { n: h.recurringWithoutHealth, label: "upkeep without health", tone: "warn" },
    { n: h.overdueRecurring, label: "overdue upkeep", tone: "bad" },
  ];
  const shown = chips.filter((c) => c.n > 0);
  if (!shown.length) return null;
  return (
    <ul className={styles.health} data-testid="data-health" aria-label="Data health">
      {shown.map((c) => (
        <li key={c.label} className={`${styles.healthChip} ${c.tone === "bad" ? styles.chipBad : styles.chipWarn}`} data-count={c.n}>
          <strong>{c.n}</strong> {c.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// One initiative
// ---------------------------------------------------------------------------

function PriorityTag({ p }: { p: Rec["priority"] }) {
  if (p === "urgent") return <span className={`${styles.tag} ${styles.tagBad}`}>urgent</span>;
  if (p === "high") return <span className={`${styles.tag} ${styles.tagWarn}`}>high priority</span>;
  if (p === "low") return <span className={styles.tag}>low priority</span>;
  if (p === "paused")
    return (
      <span className={`${styles.tag} ${styles.tagPaused}`}>
        <PauseIcon /> paused
      </span>
    );
  return null;
}

/**
 * Calendar days between two YYYY-MM-DD dates, counted on the dates alone (no clock time), so
 * the answer never depends on the hour. Negative when `deadline` is before `today`.
 */
function calendarDaysBetween(today: string, deadline: string): number {
  return Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** Today's date in UTC, YYYY-MM-DD. Deadlines are dates without a zone; the page reads them in UTC. */
function utcToday(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function Deadline({ r }: { r: Rec }) {
  if (!r.deadline) return null;
  if (r.state === "done") return <span className={styles.tag}>due {r.deadline}</span>;
  const d = calendarDaysBetween(utcToday(), r.deadline);
  const title = `${r.deadline} (days counted in UTC)`;
  if (d < 0)
    return (
      <span className={`${styles.tag} ${styles.tagBad}`} title={title}>
        overdue by {-d} {-d === 1 ? "day" : "days"}
      </span>
    );
  if (d <= NEAR_DAYS)
    return (
      <span className={`${styles.tag} ${styles.tagWarn}`} title={title}>
        {d === 0 ? "due today" : d === 1 ? "due tomorrow" : `due in ${d} days`}
      </span>
    );
  return <span className={styles.tag}>due {r.deadline}</span>;
}

function TaskIcon({ status }: { status: Task["status"] }) {
  if (status === "done")
    return (
      <svg className={`${styles.taskIcon} ${styles.tDone}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="7" />
        <path d="M4.8 8.2l2.2 2.2 4.2-4.6" />
      </svg>
    );
  if (status === "in_progress")
    return (
      <svg className={`${styles.taskIcon} ${styles.tNow}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 1.5a6.5 6.5 0 0 1 0 13z" />
      </svg>
    );
  return (
    <svg className={`${styles.taskIcon} ${styles.tTodo}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.5" />
    </svg>
  );
}

const TASK_LABEL: Record<Task["status"], string> = { done: "Done", in_progress: "In progress", pending: "To do" };

const STATUS_LABEL: Record<Rec["status"], string> = {
  needs_you: "Needs you",
  active: "Active",
  idle: "Idle",
  finished: "Finished",
};
const STATUS_HINT: Record<Rec["status"], string> = {
  needs_you: "An open question waits for you",
  active: "Published in the last 2 hours",
  idle: "No publish for 2 hours or more",
  finished: "Done, or every task is done",
};

function StatusBadge({ status, paused }: { status: Rec["status"]; paused: boolean }) {
  return (
    <span className={`${styles.badge} ${styles[`badge_${status}`] ?? ""}`} data-badge={status} title={STATUS_HINT[status]}>
      <span className={styles.badgeDot} aria-hidden="true" />
      {STATUS_LABEL[status]}
      {paused ? (
        <span className={styles.badgePaused}>
          <PauseIcon />
          paused
        </span>
      ) : null}
    </span>
  );
}

/**
 * A small progress ring with the percent inside; in the drawer done/total sits under it. The arc
 * uses pathLength 100, so stroke-dasharray is the percent. SVG attributes, no inline style.
 */
function ProgressRing({ r, done, count = false }: { r: Rec; done: number; count?: boolean }) {
  if (r.progress === null) return null;
  const total = r.tasks.length;
  const valueText = total ? `${r.progress}%, ${done} of ${total} ${total === 1 ? "task" : "tasks"} done` : `${r.progress}%`;
  return (
    <div className={`${styles.ring} ${count ? styles.ringLg : ""}`}>
      <svg
        className={styles.ringSvg}
        viewBox="0 0 44 44"
        role="progressbar"
        aria-label="Progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={r.progress}
        aria-valuetext={valueText}
        focusable="false"
      >
        <circle cx="22" cy="22" r="18" pathLength="100" className={styles.ringBg} />
        {r.progress > 0 ? <circle cx="22" cy="22" r="18" pathLength="100" strokeDasharray={`${r.progress} 100`} transform="rotate(-90 22 22)" className={styles.ringFill} /> : null}
        <text x="22" y="22" textAnchor="middle" dominantBaseline="central" className={styles.ringText}>
          {`${r.progress}%`}
        </text>
      </svg>
      {count && total ? (
        <span className={styles.ringCount} aria-hidden="true">
          {`${done}/${total}`}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One open question: its text, age, a stale tag and the options the agent offered, display only.
 * The person answers wherever the work happens; the board only shows it. Every string is React text.
 */
function QuestionItem({ q }: { q: Rec["questionViews"][number] }) {
  return (
    <li className={`${styles.ask} ${styles.askFull}`} data-question={q.id}>
      <p className={styles.askText} title={q.text}>
        {q.text}
      </p>
      <div className={styles.askMeta}>
        <span className={styles.age}>
          <ClockIcon />
          asked {formatRelativeTime(q.askedAt)}
        </span>
        {q.stale ? <span className={`${styles.tag} ${styles.tagWarn}`}>possibly stale</span> : null}
      </div>
      {q.options.length ? (
        <p className={styles.askOptions} data-options="">
          Options: {q.options.join(" · ")}
        </p>
      ) : null}
    </li>
  );
}

/** The open questions of one record, oldest first; paused hides them. */
function openQuestionsOf(r: Rec): Rec["questionViews"] {
  if (r.priority === "paused") return [];
  return r.questionViews.filter((q) => !q.clearedAt).sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}

function TaskItem({ t }: { t: Task }) {
  return (
    <li className={styles[`task_${t.status}`] ?? ""}>
      <TaskIcon status={t.status} />
      <span className={styles.srOnly}>{TASK_LABEL[t.status]}: </span>
      <span>{t.text}</span>
    </li>
  );
}

const COLUMNS: Rec["status"][] = ["needs_you", "active", "idle", "finished"];

/** The Finished column shows this many cards, newest first, then "+N more". */
const FINISHED_SHOWN = 3;

/**
 * The board: one column per status, left to right Needs you, Active, Idle, Finished. Cards keep
 * the page order inside a column (priority, then most recently updated); Finished is newest first
 * and shows FINISHED_SHOWN, the rest folded under "+N more". Empty columns stay, so the board
 * keeps its shape; each column scrolls on its own.
 */
function Columns({ records }: { records: Rec[] }) {
  return (
    <div className={styles.board} data-cc-board="">
      {COLUMNS.map((s) => {
        let cards = records.filter((r) => r.status === s);
        if (s === "finished") cards = [...cards].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        const shown = s === "finished" ? cards.slice(0, FINISHED_SHOWN) : cards;
        const rest = cards.slice(shown.length);
        return (
          <section key={s} className={`${styles.col} ${styles[`badge_${s}`] ?? ""}`} data-column={s} data-empty={cards.length ? undefined : ""} aria-labelledby={`cc-col-${s}`}>
            <h3 id={`cc-col-${s}`} className={styles.colHead} title={STATUS_HINT[s]}>
              <span className={styles.badgeDot} aria-hidden="true" />
              {STATUS_LABEL[s]}
              <span className={styles.colCount} data-count={cards.length}>
                {cards.length}
                <span className={styles.srOnly}> {cards.length === 1 ? "initiative" : "initiatives"}</span>
              </span>
            </h3>
            {cards.length ? (
              <div className={styles.colBody}>
                {shown.map((r) => (
                  <Initiative key={r.id} r={r} />
                ))}
                {rest.length ? (
                  <details className={styles.colMore} data-more-cards={rest.length}>
                    <summary className={styles.colMoreSummary}>+{rest.length} more</summary>
                    <div className={styles.colMoreBody}>
                      {rest.map((r) => (
                        <Initiative key={r.id} r={r} />
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            ) : (
              <p className={styles.colEmpty}>Nothing here</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function doneCount(r: Rec): number {
  return r.tasks.filter((t) => t.status === "done").length;
}

/** Days past the deadline; 0 when it is not overdue, has none, or the initiative is done. */
function overdueDays(r: Rec): number {
  if (!r.deadline || r.state === "done") return 0;
  const d = calendarDaysBetween(utcToday(), r.deadline);
  return d < 0 ? -d : 0;
}

/**
 * One compact card. The face holds the title (a button that opens the drawer), the progress ring
 * and one line: the current task on an Active or Idle card; no line on a Needs you or Finished card.
 * The board has no actions: it shows status, and a person answers wherever the work happens. An overdue deadline
 * is a small red dot with a tooltip. Chips, questions, options, ages, tasks, links and the log are
 * in the drawer only (CardDrawer); a click on the card opens it.
 */
function Initiative({ r }: { r: Rec }) {
  const paused = r.priority === "paused";
  const main = r.tasks.find((t) => t.status === "in_progress") ?? r.tasks.find((t) => t.status === "pending");
  const late = overdueDays(r);
  const lateText = `Overdue by ${late} ${late === 1 ? "day" : "days"}`;
  const cls = [styles.card, r.silent || paused ? styles.greyed : "", r.status === "finished" ? styles.isDone : ""].filter(Boolean).join(" ");
  return (
    <article className={cls} data-initiative={r.id} data-card={r.id} data-status={r.status} aria-labelledby={`cc-i-${r.id}`}>
      <div className={styles.cardHead}>
        <div className={styles.cardMain}>
          <h4 id={`cc-i-${r.id}`} className={styles.cardTitle}>
            <button type="button" className={styles.cardOpen} data-open-card={r.id} aria-haspopup="dialog">
              {r.title}
            </button>
          </h4>
          {r.status === "needs_you" ? (
            <span className={styles.srOnly}>Needs you</span>
          ) : r.status !== "finished" && main ? (
            <p className={styles.line} title={main.text}>
              <TaskIcon status={main.status} />
              <span className={styles.srOnly}>{main.status === "in_progress" ? "Now: " : "Next up: "}</span>
              <span className={styles.lineText}>{main.text}</span>
            </p>
          ) : null}
        </div>
        <div className={styles.cardSide}>
          <ProgressRing r={r} done={doneCount(r)} />
          {late ? <span className={styles.lateDot} role="img" aria-label={lateText} title={`${lateText} (${r.deadline})`} data-overdue="" /> : null}
        </div>
      </div>
    </article>
  );
}

/**
 * The drawer body of one initiative or upkeep row: status, ring, every chip (health, cadence and
 * overdue for upkeep), all open questions with their options as plain text, the open tasks with
 * the done ones folded under "N done", links, the log, and when it was updated and by whom.
 */
function Detail({ r }: { r: Rec }) {
  const paused = r.priority === "paused";
  const who = r.source ? [r.source.machine, r.source.session].filter(Boolean).join(" / ") : "";
  const log = paused ? r.log.filter((e) => e.kind !== "question_asked" && e.kind !== "question_cleared") : r.log;
  const openQs = openQuestionsOf(r);
  const doneTasks = r.tasks.filter((t) => t.status === "done");
  const openTasks = r.tasks.filter((t) => t.status !== "done");
  return (
    <div className={`${styles.detail} ${r.status === "finished" ? styles.isDone : ""}`} data-detail-body={r.id}>
      <div className={styles.detailTop}>
        <div className={styles.chips}>
          <StatusBadge status={r.status} paused={paused} />
          <span className={`${styles.tag} ${styles[`state_${r.state}`] ?? ""}`}>{r.state}</span>
          <PriorityTag p={r.priority} />
          {r.key ? <span className={styles.tag}>{r.key}</span> : null}
          {r.kind === "recurring" ? (
            <>
              <span className={`${styles.tag} ${styles[`ht_${r.health?.level ?? "unknown"}`] ?? ""}`}>{r.health ? HEALTH_LABEL[r.health.level] : "No health yet"}</span>
              {r.cadence ? <span className={styles.tag}>{r.cadence}</span> : null}
              {r.overdue ? <span className={`${styles.tag} ${styles.tagBad}`}>overdue</span> : null}
            </>
          ) : null}
          <Deadline r={r} />
          {r.silent ? <span className={`${styles.tag} ${styles.tagWarn}`}>silent: no push for 14+ days</span> : null}
          {r.twoWriters ? <span className={`${styles.tag} ${styles.tagWarn}`}>two sessions this hour</span> : null}
          {r.openQuestions ? (
            <span className={`${styles.tag} ${styles.tagInfo}`}>
              {r.openQuestions} {r.openQuestions === 1 ? "question" : "questions"}
            </span>
          ) : null}
        </div>
        <ProgressRing r={r} done={doneCount(r)} count />
      </div>

      {r.health?.reason ? (
        <p className={styles.detailReason} title={r.health ? `Agent time ${r.health.checkedAt}` : undefined}>
          {r.health.reason}
        </p>
      ) : null}

      {openQs.length ? (
        <div className={styles.detailBlock}>
          <h3 className={styles.logHead}>Questions</h3>
          <ul className={styles.asks} aria-label="All open questions">
            {openQs.map((q) => (
              <QuestionItem key={q.id} q={q} />
            ))}
          </ul>
        </div>
      ) : null}

      {r.tasks.length ? (
        <div className={styles.detailBlock}>
          <h3 className={styles.logHead}>Tasks</h3>
          {openTasks.length ? (
            <ul className={styles.tasks} aria-label="Open tasks">
              {openTasks.map((t) => (
                <TaskItem key={t.id} t={t} />
              ))}
            </ul>
          ) : null}
          {doneTasks.length ? (
            <details className={styles.doneFold} data-done-tasks={doneTasks.length}>
              <summary className={styles.doneSummary}>{doneTasks.length} done</summary>
              <ul className={styles.tasks} aria-label="Done tasks">
                {doneTasks.map((t) => (
                  <TaskItem key={t.id} t={t} />
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {r.links.length ? (
        <div className={styles.detailBlock}>
          <h3 className={styles.logHead}>Links</h3>
          <Links links={r.links} />
        </div>
      ) : null}

      {/* A paused initiative hides its questions, in the log too. */}
      {log.length ? <LogList log={log} /> : null}

      <p className={styles.cardFoot}>
        Updated {formatRelativeTime(r.updatedAt)}
        {who ? <> · last pushed by {who}</> : null}
      </p>
    </div>
  );
}

/** What a person reads: no ticket keys, commit hashes or empty brackets. The full text stays in the tooltip. */
function simplifyLog(text: string): string {
  const t = text
    .replace(/\b(?!(?:UTF|SHA|TLS|SSL|ISO|HTTP|HTTPS|TCP|UDP|RFC|AES|MD|V|ES|SQL|X|IPV|GPT|COVID)-)[A-Z][A-Z0-9]{1,9}-\d+\b:?/g, "")
    .replace(/\(?\b[0-9a-f]{7,40}\b\)?/g, (m) => (/[0-9]/.test(m) && /[a-f]/.test(m) ? "" : m))
    .replace(/\(\s*[,;]?\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  return t.length > 110 ? t.slice(0, 107).trimEnd() + "..." : t;
}

/** One dot colour per kind: green done, amber asks, blue started, grey the rest. */
const LOG_TONE: Record<string, string> = {
  task_done: "done",
  question_asked: "ask",
  question_cleared: "done",
  task_started: "start",
};
/** Entries the server writes for itself that tell a person nothing. */
const LOG_HIDDEN = new Set(["synced", "health", "state"]);

/** The newest log entries of one initiative, newest first. Every string is React text. */
function LogList({ log }: { log: Rec["log"] }) {
  const shown = log.filter((e) => !LOG_HIDDEN.has(e.kind) && simplifyLog(e.text ?? ""));
  if (!shown.length) return null;
  return (
    <div className={styles.log}>
      <h3 className={styles.logHead}>Activity</h3>
      <ol className={styles.timeline} aria-label="Activity, newest first">
        {shown.map((e) => (
          <li key={e.id} data-kind={e.kind} data-tone={LOG_TONE[e.kind] ?? "plain"} title={e.text ?? ""}>
            <span className={styles.logText}>{simplifyLog(e.text ?? "")}</span>
            <span className={styles.when}>{formatRelativeTime(e.at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Links({ links }: { links: Rec["links"] }) {
  return (
    <ul className={styles.links} aria-label="Links">
      {links.map((l, i) => {
        const host = hostOf(l.url);
        return (
          <li key={i}>
            <a className={styles.linkPill} href={l.url} rel="noopener noreferrer" target="_blank" title={l.url}>
              <LinkIcon />
              {l.label}
              {host ? <span className={styles.linkHost}>{host}</span> : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** The link's host name, shown next to its label so the person sees where it goes. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** An upkeep row earns a place on the page when it is not green, is overdue or silent, or asks something. */
function upkeepNeedsLook(r: Rec): boolean {
  return r.health?.level !== "green" || r.overdue || r.silent || openQuestionsOf(r).length > 0;
}

/** Recurring upkeep: the rows that need a look, then "N healthy" folded; a click shows them. */
function UpkeepSection({ upkeep }: { upkeep: Rec[] }) {
  const look = upkeep.filter(upkeepNeedsLook);
  const healthy = upkeep.filter((r) => !upkeepNeedsLook(r));
  return (
    <section className={styles.section} aria-labelledby="cc-upkeep">
      <SectionHead id="cc-upkeep" title="Recurring upkeep" count={upkeep.length} />
      {look.length ? (
        <ul className={`${styles.panel} ${styles.upkeep}`}>
          {look.map((r) => (
            <Upkeep key={r.id} r={r} />
          ))}
        </ul>
      ) : null}
      {healthy.length ? (
        <details className={styles.healthy} data-healthy={healthy.length}>
          <summary className={styles.healthySummary}>
            <span className={`${styles.hDot} ${styles.h_green}`} aria-hidden="true" />
            {healthy.length} healthy
          </summary>
          <ul className={`${styles.panel} ${styles.upkeep}`}>
            {healthy.map((r) => (
              <Upkeep key={r.id} r={r} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

const HEALTH_LABEL: Record<string, string> = { green: "Healthy", amber: "Needs a look", red: "Failing", unknown: "Unknown" };

function Upkeep({ r }: { r: Rec }) {
  const level = r.health?.level ?? "unknown";
  const paused = r.priority === "paused";
  const needs = openQuestionsOf(r).length > 0;
  return (
    <li className={`${styles.upRow} ${needs ? styles.upAsk : ""} ${r.silent || paused ? styles.greyed : ""}`} data-initiative={r.id} data-card={r.id}>
      <span className={`${styles.hDot} ${styles[`h_${level}`] ?? ""}`} aria-hidden="true" />
      <div className={styles.upMain}>
        <span className={styles.upTitle}>
          {paused ? <PauseIcon /> : null}
          <button type="button" className={styles.upOpen} data-open-card={r.id} aria-haspopup="dialog">
            {r.title}
          </button>
          {needs ? (
            <span className={`${styles.badge} ${styles.badge_needs_you}`} data-badge="needs_you">
              <span className={styles.badgeDot} aria-hidden="true" />
              Needs you
            </span>
          ) : (
            <span className={`${styles.tag} ${styles[`ht_${level}`] ?? ""}`}>{r.health ? HEALTH_LABEL[level] : "No health yet"}</span>
          )}
        </span>
        {r.health?.reason ? (
          <p className={styles.upReason} title={r.health.reason}>
            {r.health.reason}
          </p>
        ) : null}
      </div>
      <span className={styles.upWhen} title={r.health ? `Agent time ${r.health.checkedAt}` : undefined}>
        {r.health ? <>checked {formatRelativeTime(r.health.receivedAt)}</> : <>updated {formatRelativeTime(r.updatedAt)}</>}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Icons and art: inline SVG, decorative only.
// ---------------------------------------------------------------------------

function ClockIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="4" y="3" width="2.6" height="10" rx="1" fill="currentColor" />
      <rect x="9.4" y="3" width="2.6" height="10" rx="1" fill="currentColor" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
