import type { Metadata } from "next";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { config } from "@/lib/config";
import { formatRelativeTime } from "@/lib/relative-time";
import { CC_OFF_KEEP_MS, ccView, type CcView } from "@/lib/command-center";
import { ApiError } from "@/lib/errors";
import CommandCenterPoll from "./CommandCenterPoll";
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
  const groups = new Map<string, Rec[]>();
  for (const r of projects) {
    const area = r.area ?? "Other";
    groups.set(area, [...(groups.get(area) ?? []), r]);
  }
  return (
    <>
      {/* One line: title, On, last push, data health, then the menu at the right. */}
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
        <span className={styles.privacy}>Private to you. Nothing confidential.</span>
        <Settings />
      </header>

      <section className={styles.section} aria-labelledby="cc-needs">
        <SectionHead id="cc-needs" title="Needs you" count={view.needsYou.length} />
        {view.needsYou.length === 0 ? (
          <AllClear />
        ) : (
          <div className={styles.questions}>
            {view.needsYou.map(({ initiative, question }) => (
              <article
                key={`${initiative.id}/${question.id}`}
                className={`${styles.qCard} ${urgencyClass(initiative.priority)}`}
                aria-label={`Question from ${initiative.title}`}
              >
                <p className={styles.qText}>{question.text}</p>
                <div className={styles.qTop}>
                  <span className={styles.chip} title={initiative.title}>
                    {initiative.title}
                  </span>
                  <PriorityTag p={initiative.priority} />
                  {question.stale ? <span className={`${styles.tag} ${styles.tagWarn}`}>possibly stale</span> : null}
                  <span className={styles.age}>
                    <ClockIcon />
                    asked {formatRelativeTime(question.askedAt)}
                  </span>
                </div>
                <div className={styles.qFoot}>
                  {question.options.length ? (
                    <ul className={styles.options} aria-label="Options your agent offered">
                      {question.options.map((o, i) => (
                        <li key={i} className={styles.option}>
                          {o}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <form method="post" action="/command-center/dismiss">
                    <input type="hidden" name="id" value={initiative.id} />
                    <input type="hidden" name="questionId" value={question.id} />
                    <button type="submit" className={styles.ghost}>
                      Dismiss
                    </button>
                  </form>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="cc-initiatives">
        <SectionHead id="cc-initiatives" title="Initiatives" count={projects.length} />
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
          // One masonry flow for every area: small areas share columns instead of leaving holes.
          <div className={styles.flow}>
            {[...groups.entries()].map(([area, records]) => (
              <div key={area} className={styles.area}>
                <h3 className={styles.areaHead}>
                  {area} <span className={styles.areaCount}>{records.length}</span>
                </h3>
                {records.map((r) => (
                  <Initiative key={r.id} r={r} />
                ))}
              </div>
            ))}
          </div>
        ) : null}
        {view.offPage ? (
          <p className={styles.offPage}>
            {view.offPage} done, parked or silent {view.offPage === 1 ? "initiative is" : "initiatives are"} off this page. They stay in your log.
          </p>
        ) : null}
      </section>

      {upkeep.length ? (
        <section className={styles.section} aria-labelledby="cc-upkeep">
          <SectionHead id="cc-upkeep" title="Recurring upkeep" count={upkeep.length} />
          <ul className={`${styles.panel} ${styles.upkeep}`}>
            {upkeep.map((r) => (
              <Upkeep key={r.id} r={r} />
            ))}
          </ul>
        </section>
      ) : null}

      <YourLog view={view} />
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
  return (
    <ul className={styles.health} data-testid="data-health" aria-label="Data health">
      {chips.map((c) => (
        <li key={c.label} className={`${styles.healthChip} ${c.n === 0 ? "" : c.tone === "bad" ? styles.chipBad : styles.chipWarn}`} data-count={c.n}>
          <strong>{c.n}</strong> {c.label}
        </li>
      ))}
    </ul>
  );
}

function AllClear() {
  return (
    <div className={`${styles.panel} ${styles.allClear}`}>
      <svg className={styles.allClearArt} viewBox="0 0 96 96" aria-hidden="true" focusable="false">
        <circle cx="48" cy="48" r="44" className={styles.artBg} />
        <circle cx="48" cy="48" r="30" className={styles.artRing} />
        <path d="M34 49l9 9 20-21" className={styles.artCheck} />
        <circle cx="80" cy="20" r="4" className={styles.artSpark} />
        <circle cx="14" cy="70" r="3" className={styles.artSpark} />
      </svg>
      <div>
        <p className={styles.allClearTitle}>All clear</p>
        <p className={styles.muted}>Nothing waiting for you. Questions your agents ask show up here.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One initiative
// ---------------------------------------------------------------------------

function urgencyClass(p: Rec["priority"]): string {
  if (p === "urgent") return styles.urgent;
  if (p === "high") return styles.high;
  return "";
}

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

function Progress({ r }: { r: Rec }) {
  if (r.progress === null) return null;
  const c = 2 * Math.PI * 17;
  return (
    <div className={styles.progress}>
      <div className={styles.ringWrap}>
        <svg className={styles.ring} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
          <circle cx="20" cy="20" r="17" className={styles.ringTrack} />
          <circle cx="20" cy="20" r="17" className={styles.ringFill} strokeDasharray={c} strokeDashoffset={c * (1 - r.progress / 100)} />
        </svg>
        <span className={styles.percent}>{r.progress}%</span>
      </div>
    </div>
  );
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

function Initiative({ r }: { r: Rec }) {
  const paused = r.priority === "paused";
  const next = r.tasks.find((t) => t.status === "in_progress") ?? r.tasks.find((t) => t.status === "pending");
  const who = r.source ? [r.source.machine, r.source.session].filter(Boolean).join(" / ") : "";
  const done = r.tasks.filter((t) => t.status === "done").length;
  const log = paused ? r.log.filter((e) => e.kind !== "question_asked" && e.kind !== "question_cleared") : r.log;
  const cls = [styles.card, urgencyClass(r.priority), r.silent || paused ? styles.greyed : "", r.state === "done" ? styles.isDone : ""].join(" ");
  return (
    <article className={cls} data-initiative={r.id} aria-labelledby={`cc-i-${r.id}`}>
      <div className={styles.cardHead}>
        <h4 id={`cc-i-${r.id}`} className={styles.cardTitle}>
          {paused ? <PauseIcon /> : null}
          {r.title}
        </h4>
        <Progress r={r} />
      </div>
      <div className={styles.chips}>
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

      {next && r.state !== "done" ? (
        <p className={styles.next}>
          <TaskIcon status={next.status} />
          <span className={styles.nextLabel}>{next.status === "in_progress" ? "Now" : "Next up"}</span>
          <span className={styles.nextText} title={next.text}>
            {next.text}
          </span>
        </p>
      ) : null}

      {/* A paused initiative hides its questions, in the log too. */}
      {log.length ? <LogList log={log} /> : null}

      {/* One meta line: tasks behind a toggle, links, then who pushed last. An opened toggle
          takes the full width and pushes the links and footer below its list. */}
      <div className={styles.meta}>
        {r.tasks.length ? (
          <details className={styles.details}>
            <summary>{`${done}/${r.tasks.length} ${r.tasks.length === 1 ? "task" : "tasks"}`}</summary>
            <ul className={styles.tasks} aria-label="Tasks">
              {r.tasks.map((t) => (
                <li key={t.id} className={styles[`task_${t.status}`] ?? ""}>
                  <TaskIcon status={t.status} />
                  <span className={styles.srOnly}>{TASK_LABEL[t.status]}: </span>
                  <span>{t.text}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {r.links.length ? <Links links={r.links} /> : null}

        <p className={styles.cardFoot} title={who ? `Last pushed by ${who}` : undefined}>
          Updated {formatRelativeTime(r.updatedAt)}
          {who ? <> · {who}</> : null}
        </p>
      </div>
    </article>
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
      <h5 className={styles.logHead}>Log</h5>
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

/** The person's own log download and the export apps they may share it with. */
function YourLog({ view }: { view: CcView }) {
  return (
    <section className={styles.section} aria-labelledby="cc-log">
      <div className={styles.sectionHead}>
        <h2 id="cc-log" className={styles.h2}>
          Your log
        </h2>
      </div>
      <div className={`${styles.panel} ${styles.logPanel}`}>
        <p>
          Every publish adds a line on what was worked on. The log is kept for reporting after initiatives leave this page.{" "}
          <a className={styles.inlineLink} href="/command-center/export" download>
            Download my log
          </a>
        </p>
        {view.exportApps.length ? (
          <>
            <p className={styles.muted}>
              Report apps see nothing unless you share with them here. A shared app sees counts per initiative and day, with each initiative's title and key, but not your log lines, unless you allow entries. Sharing entries also shares the session and machine names on each line. You
              can stop sharing at any time.
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
          </>
        ) : null}
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

const HEALTH_LABEL: Record<string, string> = { green: "Healthy", amber: "Needs a look", red: "Failing", unknown: "Unknown" };

function Upkeep({ r }: { r: Rec }) {
  const level = r.health?.level ?? "unknown";
  const paused = r.priority === "paused";
  return (
    <li className={`${styles.upRow} ${r.silent || paused ? styles.greyed : ""}`} data-initiative={r.id}>
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
