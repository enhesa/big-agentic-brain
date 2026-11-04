import type { Metadata } from "next";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { config } from "@/lib/config";
import { formatRelativeTime } from "@/lib/relative-time";
import { CC_OFF_KEEP_MS, ccView, type CcView } from "@/lib/command-center";
import { ApiError } from "@/lib/errors";
import { isSessionLink } from "@/lib/command-center-link";
import CommandCenterPoll from "./CommandCenterPoll";
import CardDrawer from "./CardDrawer";
import styles from "./command-center.module.css";

export const dynamic = "force-dynamic";
// The page posts forms to itself: keep the origin on same-origin requests (tests/referrer-policy.test.ts).
export const metadata: Metadata = { title: "Command Center", referrer: "same-origin", robots: { index: false } };

type Rec = CcView["records"][number];
type Task = Rec["tasks"][number];

const DAY_MS = 86_400_000;
/** A deadline this many days away or fewer is shown as near. */
const NEAR_DAYS = 7;

/**
 * /command-center: what the viewer's own agent sessions publish (lib/command-center.ts). Hidden:
 * no nav or footer entry; the command-center skill gives the person the link. The signed-in viewer
 * only (getViewer), never anyone else's records. Every agent-written string is React text.
 */
export default async function CommandCenterPage() {
  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/command-center", via: "ui" });

  if (!config().commandCenter) {
    return (
      <Shell>
        <Notice>Command Center is switched off on this BAB.</Notice>
      </Shell>
    );
  }
  if (!viewer) {
    return (
      <Shell>
        <Notice>Sign in to BAB in your browser to see your Command Center. It is private to you.</Notice>
      </Shell>
    );
  }

  let view: CcView;
  try {
    view = ccView(viewer.ownerId);
  } catch (err) {
    return (
      <Shell>
        <Notice>{err instanceof ApiError ? err.message : "Command Center is not available right now."}</Notice>
      </Shell>
    );
  }

  return (
    <Shell>
      <CommandCenterPoll stamp={view.stamp} />
      <div className={styles.page}>{view.enabledAt ? <OnState view={view} /> : <OffState view={view} />}</div>
    </Shell>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <h1 className={styles.h1}>Command Center</h1>
      <p className={`${styles.panel} ${styles.notice}`}>{children}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Off
// ---------------------------------------------------------------------------

function OffState({ view }: { view: CcView }) {
  return (
    <>
      <header className={styles.top}>
        <div className={styles.titleBlock}>
          <span className={styles.kicker}>Private to you</span>
          <div className={styles.titleLine}>
            <h1 className={styles.h1}>Command Center</h1>
            <span className={`${styles.status} ${styles.statusOff}`}>
              <span className={styles.statusDot} aria-hidden="true" />
              Off
            </span>
          </div>
        </div>
      </header>
      <section className={`${styles.panel} ${styles.offHero}`} aria-labelledby="cc-off-title">
        <OffArt />
        <div className={styles.offBody}>
          <h2 id="cc-off-title" className={styles.offTitle}>
            One calm page for everything your agents are doing
          </h2>
          <p>Command Center is off. Switch it on to let your Claude sessions publish their initiatives here.</p>
          <ul className={styles.offPoints}>
            <li>Questions waiting for you, with their age</li>
            <li>Initiatives with progress, deadlines and next steps</li>
            <li>Health of recurring upkeep</li>
          </ul>
          <form method="post" action="/command-center/enable">
            <button type="submit" className={`btn-primary ${styles.enable}`}>
              Switch on
            </button>
          </form>
          <p className={styles.hint}>
            Then install the optional command-center skill for your agent. Its text is at{" "}
            <a className={styles.inlineLink} href="/instructions/command-center.md">
              /instructions/command-center.md
            </a>
            . Only you see this page. Nothing confidential goes in it.
          </p>
          {view.keptUntil ? (
            <div className={styles.kept}>
              <p>Your records are kept until {view.keptUntil}. Switch on again to restore them.</p>
              <DeleteNow />
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}

function DeleteNow() {
  return (
    <details className={styles.confirm}>
      <summary className={styles.dangerLink}>Delete all my records now</summary>
      <div className={styles.confirmBody}>
        <p>This deletes every initiative, question and log entry, and stops all sharing, at once. It cannot be undone.</p>
        <form method="post" action="/command-center/delete">
          <button type="submit" className={styles.danger}>
            Yes, delete all my records
          </button>
        </form>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// On
// ---------------------------------------------------------------------------

function OnState({ view }: { view: CcView }) {
  const projects = view.records.filter((r) => r.kind !== "recurring");
  const upkeep = view.records.filter((r) => r.kind === "recurring");
  return (
    <>
      {/* One quiet line: title, On, last push, data health only when something is off, the menu. */}
      <header className={`${styles.top} ${styles.topOn}`}>
        <div className={styles.titleLine}>
          <h1 className={styles.h1}>Command Center</h1>
          <span className={`${styles.status} ${styles.statusOn}`}>
            <span className={styles.statusDot} aria-hidden="true" />
            On
          </span>
          <p className={styles.subline}>{view.lastPush ? <>Last push {formatRelativeTime(view.lastPush)}</> : <>Nothing published yet</>}</p>
        </div>
        <DataHealth h={view.dataHealth} />
        <Settings />
      </header>

      {/* No separate questions section: open questions sit on their own card or upkeep row, and the
          Needs you column holds those cards. The columns carry the counts. */}
      <section className={styles.section} aria-labelledby="cc-initiatives">
        <h2 id="cc-initiatives" className={styles.srOnly}>
          Initiatives
        </h2>
        {projects.length === 0 ? (
          <p className={`${styles.panel} ${styles.empty}`}>
            No initiatives yet. Your agent publishes them with the command-center skill. Its text is at{" "}
            <a className={styles.inlineLink} href="/instructions/command-center.md">
              /instructions/command-center.md
            </a>
            .
          </p>
        ) : null}
        {projects.length ? (
          <>
            <Board records={projects} />
            <CardDrawer
              panels={projects.map((r) => ({
                id: r.id,
                title: r.title,
                body: <Detail r={r} />,
              }))}
            />
          </>
        ) : null}
        {view.offPage ? (
          <p className={styles.offPage}>
            {view.offPage} done, parked or silent {view.offPage === 1 ? "initiative is" : "initiatives are"} off this page. They stay in your log.
          </p>
        ) : null}
      </section>

      {upkeep.length ? <UpkeepSection upkeep={upkeep} /> : null}

      {view.exportApps.length ? <ReportApps view={view} /> : null}
    </>
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

function Settings() {
  return (
    <details className={styles.menu}>
      <summary className={styles.menuButton} aria-label="Command Center settings">
        <DotsIcon />
      </summary>
      <div className={styles.menuBody}>
        <p className={styles.menuNote}>Private to you. Nothing confidential.</p>
        <p className={styles.menuNote}>
          Every publish adds a line to your log, kept for reporting after initiatives leave this page.{" "}
          <a className={styles.inlineLink} href="/command-center/export" download>
            Download my log
          </a>
        </p>
        <p className={styles.menuNote}>Switching off stops agents from publishing. Your records are kept {CC_OFF_KEEP_MS / DAY_MS} days.</p>
        <form method="post" action="/command-center/disable">
          <button type="submit" className={styles.ghost}>
            Switch off
          </button>
        </form>
        <DeleteNow />
      </div>
    </details>
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
 * The person answers in the Claude session (Open in Claude). Every string is React text.
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
        <ul className={styles.options} aria-label="Options your agent offered">
          {q.options.map((o, i) => (
            <li key={i} className={styles.option}>
              {o}
            </li>
          ))}
        </ul>
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
function Board({ records }: { records: Rec[] }) {
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

/**
 * The button that opens the session behind an initiative in Claude (source.link). The link is
 * checked again here before it becomes an href (isSessionLink, the server's rule); no link, or one
 * that fails the check, gives a disabled button. Same tab, like CCC: a claude:// link hands off to
 * the app.
 */
function OpenInClaude({ r, small = false }: { r: Rec; small?: boolean }) {
  const link = r.source?.link;
  const cls = `${styles.openClaude} ${small ? styles.openClaudeSm : ""}`;
  if (isSessionLink(link)) {
    return (
      <a className={cls} href={link} rel="noopener noreferrer" data-open-session={r.id}>
        Open in Claude <span aria-hidden="true">↗</span>
      </a>
    );
  }
  return (
    <button type="button" className={cls} disabled title="No session link" data-open-session="">
      Open in Claude<span className={styles.srOnly}> (no session link)</span>
    </button>
  );
}

/** Days past the deadline; 0 when it is not overdue, has none, or the initiative is done. */
function overdueDays(r: Rec): number {
  if (!r.deadline || r.state === "done") return 0;
  const d = calendarDaysBetween(utcToday(), r.deadline);
  return d < 0 ? -d : 0;
}

/**
 * One compact card. The face holds the title (a button that opens the drawer), the progress ring
 * and one line: the current task on an Active or Idle card; on a Needs you card no line, only the
 * Open in Claude button (the board's only action); nothing on a Finished card. An overdue deadline
 * is a small red dot with a tooltip. Chips, questions, options, ages, tasks, links and the log are
 * in the drawer only (CardDrawer); a click on the card opens it.
 */
function Initiative({ r }: { r: Rec }) {
  const paused = r.priority === "paused";
  const main = r.tasks.find((t) => t.status === "in_progress") ?? r.tasks.find((t) => t.status === "pending");
  const late = overdueDays(r);
  const lateText = `Overdue by ${late} ${late === 1 ? "day" : "days"}`;
  const cls = [styles.card, styles[`status_${r.status}`] ?? "", r.silent || paused ? styles.greyed : "", r.status === "finished" ? styles.isDone : ""].join(" ");
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
      {r.status === "needs_you" ? (
        <div className={styles.cardAct}>
          <OpenInClaude r={r} />
        </div>
      ) : null}
    </article>
  );
}

/**
 * The drawer body of one initiative: status, ring, every chip, all open questions (display
 * only), every task with its status icon, links, the log, and when it was updated and by whom.
 */
function Detail({ r }: { r: Rec }) {
  const paused = r.priority === "paused";
  const who = r.source ? [r.source.machine, r.source.session].filter(Boolean).join(" / ") : "";
  const log = paused ? r.log.filter((e) => e.kind !== "question_asked" && e.kind !== "question_cleared") : r.log;
  const openQs = openQuestionsOf(r);
  return (
    <div className={`${styles.detail} ${r.status === "finished" ? styles.isDone : ""}`} data-detail-body={r.id}>
      <div className={styles.detailTop}>
        <div className={styles.chips}>
          <StatusBadge status={r.status} paused={paused} />
          <span className={`${styles.tag} ${styles[`state_${r.state}`] ?? ""}`}>{r.state}</span>
          <PriorityTag p={r.priority} />
          {r.key ? <span className={styles.tag}>{r.key}</span> : null}
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
      <div className={styles.detailAct}>
        <OpenInClaude r={r} small />
      </div>

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
          <ul className={styles.tasks} aria-label="All tasks">
            {r.tasks.map((t) => (
              <TaskItem key={t.id} t={t} />
            ))}
          </ul>
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

/** Short labels for the entries the server writes itself; a `worked` line needs none. */
const LOG_KIND_LABEL: Record<string, string> = {
  note: "note",
  task_started: "task started",
  task_done: "task done",
  question_asked: "asked",
  question_cleared: "cleared",
  health: "health",
  state: "state",
  synced: "synced",
};

/** The newest log entries of one initiative, newest first. Every string is React text. */
function LogList({ log }: { log: Rec["log"] }) {
  return (
    <div className={styles.log}>
      <h3 className={styles.logHead}>Log</h3>
      <ol className={styles.timeline} aria-label="Log, newest first">
        {log.map((e) => (
          <li key={e.id} data-kind={e.kind}>
            <span className={styles.when}>{formatRelativeTime(e.at)}</span>
            <span>
              {LOG_KIND_LABEL[e.kind] ? <span className={styles.logKind}>{LOG_KIND_LABEL[e.kind]}</span> : null}
              {e.text ?? ""}
              {e.size ? <span className={`${styles.tag} ${styles.logSize}`}>{e.size}</span> : null}
              {e.source === "backfill" ? <span className={`${styles.tag} ${styles.logSize}`} data-source="backfill">backfill</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The report apps the person may share their log with; the download itself is in the menu. */
function ReportApps({ view }: { view: CcView }) {
  return (
    <section className={styles.section} aria-labelledby="cc-apps">
      <div className={styles.sectionHead}>
        <h2 id="cc-apps" className={styles.h2}>
          Report apps
        </h2>
      </div>
      <div className={`${styles.panel} ${styles.logPanel}`}>
        <p className={styles.muted}>
          Report apps see nothing unless you share with them here. A shared app sees counts per initiative and day, with each initiative's title and key, but not your log lines, unless you allow entries. Sharing entries also shares the session and machine names on each line. You can
          stop sharing at any time.
        </p>
        <ul className={styles.apps} aria-label="Report apps">
          {view.exportApps.map(({ app, grant }) => (
            <li key={app} className={styles.appRow} data-app={app}>
              <span className={styles.appName}>{app}</span>
              <span className={styles.tag}>{grant ? (grant.level === "entries" ? "shares entries" : "shares counts") : "not shared"}</span>
              <form method="post" action="/command-center/export/grant" className={styles.appForm}>
                <input type="hidden" name="app" value={app} />
                <button type="submit" name="level" value="aggregate" className={styles.ghost}>
                  Share counts
                </button>
                <button type="submit" name="level" value="entries" className={styles.ghost}>
                  Share entries
                </button>
              </form>
              {grant ? (
                <form method="post" action="/command-center/export/revoke" className={styles.appForm}>
                  <input type="hidden" name="app" value={app} />
                  <button type="submit" className={styles.ghost}>
                    Stop sharing
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </section>
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
  // A row has no details to open, so every open question shows on it.
  const openQs = openQuestionsOf(r);
  return (
    <li className={`${styles.upRow} ${openQs.length ? styles.upAsk : ""} ${r.silent || paused ? styles.greyed : ""}`} data-initiative={r.id}>
      <span className={`${styles.hDot} ${styles[`h_${level}`] ?? ""}`} aria-hidden="true" />
      <div className={styles.upMain}>
        <span className={styles.upTitle}>
          {paused ? <PauseIcon /> : null}
          <span className={styles.upName}>{r.title}</span>
          <span className={`${styles.tag} ${styles[`ht_${level}`] ?? ""}`}>{r.health ? HEALTH_LABEL[level] : "No health yet"}</span>
          {r.cadence ? <span className={styles.tag}>{r.cadence}</span> : null}
          {r.overdue ? <span className={`${styles.tag} ${styles.tagBad}`}>overdue</span> : null}
          {r.silent ? <span className={`${styles.tag} ${styles.tagWarn}`}>silent</span> : null}
          <PriorityTag p={r.priority === "paused" ? null : r.priority} />
          {paused ? <span className={`${styles.tag} ${styles.tagPaused}`}>paused</span> : null}
          {openQs.length ? (
            <span className={`${styles.badge} ${styles.badge_needs_you}`} data-badge="needs_you">
              <span className={styles.badgeDot} aria-hidden="true" />
              Needs you
            </span>
          ) : null}
        </span>
        {r.health?.reason ? (
          <p className={styles.upReason} title={r.health.reason}>
            {r.health.reason}
          </p>
        ) : null}
        {r.links.length ? <Links links={r.links} /> : null}
      </div>
      <span className={styles.upWhen} title={r.health ? `Agent time ${r.health.checkedAt}` : undefined}>
        {r.health ? <>checked {formatRelativeTime(r.health.receivedAt)}</> : <>updated {formatRelativeTime(r.updatedAt)}</>}
      </span>
      {openQs.length ? (
        <div className={styles.upAskBody}>
          <ul className={`${styles.asks} ${styles.upAsks}`} aria-label="Open questions">
            {openQs.map((q) => (
              <QuestionItem key={q.id} q={q} />
            ))}
          </ul>
          <OpenInClaude r={r} small />
        </div>
      ) : null}
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

function DotsIcon() {
  return (
    <svg className={styles.iconLg} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="4" cy="10" r="1.8" fill="currentColor" />
      <circle cx="10" cy="10" r="1.8" fill="currentColor" />
      <circle cx="16" cy="10" r="1.8" fill="currentColor" />
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

function OffArt() {
  return (
    <svg className={styles.offArt} viewBox="0 0 160 120" aria-hidden="true" focusable="false">
      <rect x="10" y="14" width="140" height="92" rx="14" className={styles.artBg} />
      <rect x="24" y="30" width="54" height="8" rx="4" className={styles.artLine} />
      <rect x="24" y="46" width="112" height="22" rx="8" className={styles.artCard} />
      <rect x="24" y="76" width="52" height="18" rx="8" className={styles.artCard} />
      <rect x="84" y="76" width="52" height="18" rx="8" className={styles.artCard} />
      <circle cx="128" cy="34" r="6" className={styles.artSpark} />
      <path d="M32 57h40" className={styles.artAccent} />
    </svg>
  );
}
