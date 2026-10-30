import type { Metadata } from "next";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { config } from "@/lib/config";
import { formatRelativeTime } from "@/lib/relative-time";
import { ccView, type CcView } from "@/lib/command-center";
import CommandCenterPoll from "./CommandCenterPoll";
import styles from "./command-center.module.css";

export const dynamic = "force-dynamic";
// The page posts forms to itself: keep the origin on same-origin requests (tests/referrer-policy.test.ts).
export const metadata: Metadata = { title: "Command Center", referrer: "same-origin", robots: { index: false } };

type Rec = CcView["records"][number];

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
        <h1 className={styles.h1}>Command Center</h1>
        <p className="card">Command Center is switched off on this BAB.</p>
      </Shell>
    );
  }
  if (!viewer) {
    return (
      <Shell>
        <h1 className={styles.h1}>Command Center</h1>
        <p className="card">Sign in to BAB in your browser to see your Command Center. It is private to you.</p>
      </Shell>
    );
  }

  let view: CcView;
  try {
    view = ccView(viewer.ownerId);
  } catch (err) {
    return (
      <Shell>
        <h1 className={styles.h1}>Command Center</h1>
        <p className="card">{err instanceof Error ? err.message : "Command Center is not available right now."}</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <CommandCenterPoll stamp={view.stamp} />
      <h1 className={styles.h1}>Command Center</h1>
      {view.enabledAt ? <OnState view={view} /> : <OffState view={view} />}
    </Shell>
  );
}

function OffState({ view }: { view: CcView }) {
  return (
    <div className={`card ${styles.off}`}>
      <p>Command Center is off. Switch it on to let your Claude sessions publish their initiatives here.</p>
      <form method="post" action="/command-center/enable">
        <button type="submit" className="btn-primary">
          Switch on
        </button>
      </form>
      <p className={styles.hint}>
        Then install the optional command-center skill for your agent. Its text is at{" "}
        <a href="/instructions/command-center.md">/instructions/command-center.md</a>.
      </p>
      {view.keptUntil ? (
        <>
          <p>Your records are kept until {view.keptUntil}. Switch on again to restore them.</p>
          <DeleteNow />
        </>
      ) : null}
    </div>
  );
}

function DeleteNow() {
  return (
    <form method="post" action="/command-center/delete">
      <button type="submit" className={styles.danger}>
        Delete all my records now
      </button>
    </form>
  );
}

function OnState({ view }: { view: CcView }) {
  const h = view.dataHealth;
  const groups = new Map<string, Rec[]>();
  for (const r of view.records) {
    const area = r.area ?? "Other";
    groups.set(area, [...(groups.get(area) ?? []), r]);
  }
  return (
    <>
      <div className={styles.header}>
        <p>
          On. {view.lastPush ? <>Last push {formatRelativeTime(view.lastPush)}.</> : <>Nothing published yet.</>} Private to you. Nothing confidential.
        </p>
        <p className={styles.health} data-testid="data-health">
          Data: {h.staleQuestions} stale questions, {h.silentInitiatives} silent initiatives, {h.recurringWithoutHealth} upkeep without health, {h.overdueRecurring} overdue upkeep.
        </p>
        <form method="post" action="/command-center/disable">
          <button type="submit" className={styles.ghost}>
            Switch off
          </button>
        </form>
      </div>

      <section className={styles.section}>
        <h2 className={styles.h2}>Needs you</h2>
        {view.needsYou.length === 0 ? <p className={styles.muted}>Nothing waiting for you.</p> : null}
        {view.needsYou.map(({ initiative, question }) => (
          <div key={`${initiative.id}/${question.id}`} className={`card ${styles.question}`}>
            <p className={styles.qText}>{question.text}</p>
            {question.options.length ? (
              <ul className={styles.options}>
                {question.options.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ul>
            ) : null}
            <p className={styles.meta}>
              {initiative.title} · asked {formatRelativeTime(question.askedAt)}
              {question.stale ? <span className={styles.tagWarn}>possibly stale</span> : null}
            </p>
            <form method="post" action="/command-center/dismiss">
              <input type="hidden" name="id" value={initiative.id} />
              <input type="hidden" name="questionId" value={question.id} />
              <button type="submit" className={styles.ghost}>
                Dismiss
              </button>
            </form>
          </div>
        ))}
      </section>

      {[...groups.entries()].map(([area, records]) => (
        <section key={area} className={styles.section}>
          <h2 className={styles.h2}>{area}</h2>
          {records.map((r) => (
            <Initiative key={r.id} r={r} />
          ))}
        </section>
      ))}
      {view.records.length === 0 ? <p className={styles.muted}>No initiatives yet. Your agent publishes them with the command-center skill.</p> : null}

      <section className={styles.section}>
        <DeleteNow />
      </section>
    </>
  );
}

function Initiative({ r }: { r: Rec }) {
  const greyed = r.silent || r.priority === "paused";
  return (
    <div className={`card ${styles.initiative} ${greyed ? styles.greyed : ""}`} data-initiative={r.id}>
      <div className={styles.titleRow}>
        {r.kind === "recurring" ? <span className={`${styles.dot} ${styles[r.health?.level ?? "unknown"]}`} title={r.health?.level ?? "unknown"} /> : null}
        <span className={styles.title}>{r.title}</span>
        {r.key ? <span className={styles.pill}>{r.key}</span> : null}
        <span className={styles.pill}>{r.state}</span>
        {r.priority ? <span className={styles.pill}>{r.priority}</span> : null}
        {r.progress !== null ? <span className={styles.percent}>{r.progress}%</span> : null}
        {r.silent ? <span className={styles.tagWarn}>silent</span> : null}
        {r.overdue ? <span className={styles.tagWarn}>overdue</span> : null}
        {r.twoWriters ? <span className={styles.tagWarn}>two sessions this hour</span> : null}
      </div>
      <p className={styles.meta}>
        {r.deadline ? <>Deadline {r.deadline} · </> : null}
        Updated {formatRelativeTime(r.updatedAt)}
        {r.source?.machine || r.source?.session ? <> by {[r.source.machine, r.source.session].filter(Boolean).join(" / ")}</> : null}
      </p>
      {r.health ? (
        <p className={styles.meta}>
          Health {r.health.level}
          {r.health.reason ? <>: {r.health.reason}</> : null} · checked {r.health.checkedAt}, received {formatRelativeTime(r.health.receivedAt)}
        </p>
      ) : null}
      {r.tasks.length ? (
        <details className={styles.details}>
          <summary>
            Tasks ({r.tasks.filter((t) => t.status === "done").length}/{r.tasks.length})
          </summary>
          <ul className={styles.tasks}>
            {r.tasks.map((t) => (
              <li key={t.id} className={styles[t.status]}>
                {t.status === "done" ? "Done: " : t.status === "in_progress" ? "Now: " : ""}
                {t.text}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {r.comments.length ? (
        <details className={styles.details}>
          <summary>Comments ({r.comments.length})</summary>
          <ul className={styles.tasks}>
            {r.comments.map((c) => (
              <li key={c.id}>
                {c.text} <span className={styles.muted}>{formatRelativeTime(c.at)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {r.links.length ? (
        <ul className={styles.links}>
          {r.links.map((l, i) => (
            <li key={i}>
              <a href={l.url} rel="noopener noreferrer" target="_blank">
                {l.label}
              </a>{" "}
              <span className={styles.url}>{l.url}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
