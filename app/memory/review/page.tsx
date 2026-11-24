import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { reviewQueue, type ReviewItem } from "@/lib/trust";
import { mayReview, reviewMessage, REVIEW_NOTE_MAX, REVIEW_OK_CODES } from "@/lib/review-web";
import { RECHECK_NOTE_MAX, waitingFor, type CheckItem } from "@/lib/checks";
import { recheckMessage, RECHECK_OK_CODES } from "@/lib/recheck-web";
import { ageInfo } from "@/lib/learnings";
import { formatAge } from "@/lib/relative-time";
import styles from "../memory.module.css";

/**
 * The review page. For anyone signed in: "Waiting for you", the business facts BAB asks this person
 * to check (Is this still true?), with Yes, No, Not sure, Let agents check this and Ask me later
 * (lib/recheck-web.ts, lib/checks.ts). For maintainers also: memories a person may want to look at,
 * with confirm, keep and retire buttons that need a note (lib/review-web.ts). Optional: flags, the
 * sweeps and the trust labels work without it. A 404 for anyone not signed in.
 */
export default async function ReviewPage({ searchParams }: { searchParams?: Promise<{ review?: string | string[]; check?: string | string[] }> }) {
  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/memory/review", via: "ui" });
  if (!viewer) notFound();
  const maintainer = mayReview(viewer.ownerId);
  const { review, check } = (await searchParams) ?? {};
  const message = maintainer ? reviewMessage(Array.isArray(review) ? review[0] : review) : null;
  const checkNote = recheckMessage(Array.isArray(check) ? check[0] : check);
  const queue = maintainer ? reviewQueue() : null;
  const waiting = waitingFor(viewer.ownerId);

  const waitingItem = (i: CheckItem) => (
    <li key={i.id} className={styles.reviewItem}>
      <p className={styles.reviewTitle}>
        <Link href={`/memory/${i.id}`} className={styles.link}>
          {i.title}
        </Link>
        {i.kind !== "learning" ? <span className={styles.kindBadge}>{i.kind}</span> : null}
      </p>
      {/* JSX text only: memory text is written by any agent. */}
      <p className={styles.checkText}>{i.text}</p>
      {i.truncated ? (
        <p className={styles.commentMeta}>
          <Link href={`/memory/${i.id}`} className={styles.link}>
            Read the whole memory
          </Link>
        </p>
      ) : null}
      <p className={styles.commentMeta}>
        {i.reason === "followUp"
          ? `You answered ${i.lastAnswer === "no" ? "No" : "Not sure"}. It waits for a fix: your agent can find the new version, or retire it from its page.`
          : `${i.own ? "You wrote this. " : ""}Last checked ${i.checkedDaysAgo} days ago. Agents read it on ${i.readDays} days.`}
      </p>
      {i.reason === "due" ? (
        <form method="post" action={`/memory/${encodeURIComponent(i.id)}/recheck`} className={styles.reviewForm}>
          <label htmlFor={`check-note-${i.id}`} className={styles.reactLabel}>
            {i.own ? "Note (optional)" : "Note (where you checked; needed for Yes)"}
          </label>
          <input id={`check-note-${i.id}`} name="note" maxLength={RECHECK_NOTE_MAX} className={styles.commentInput} />
          <div className={styles.reactRow}>
            <button type="submit" name="answer" value="yes" className={`${styles.reactBtn} ${styles.reactBtnMain}`}>
              Yes, still true
            </button>
            <button type="submit" name="answer" value="no" className={styles.reactBtn}>
              No
            </button>
            <button type="submit" name="answer" value="unsure" className={styles.reactBtn}>
              Not sure
            </button>
            <button type="submit" name="answer" value="agent" className={styles.reactBtn}>
              Let agents check this
            </button>
            <button type="submit" name="answer" value="later" className={styles.reactBtn}>
              Ask me later
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );

  const section = (id: string, heading: string, hint: string, items: ReviewItem[]) => (
    <section className={styles.reviewSection} aria-labelledby={id}>
      <h2 id={id}>{`${heading} (${items.length})`}</h2>
      <p className={styles.reactHint}>{hint}</p>
      {items.length === 0 ? (
        <p className={styles.reviewNone}>Nothing here.</p>
      ) : (
        <ol className={styles.reviewList}>
          {items.map((i) => (
            <li key={i.id} className={styles.reviewItem}>
              <p className={styles.reviewTitle}>
                <Link href={`/memory/${i.id}`} className={styles.link}>
                  {i.title}
                </Link>
                {i.kind !== "learning" ? <span className={styles.kindBadge}>{i.kind}</span> : null}
              </p>
              <p className={styles.commentMeta}>{`${i.authorName}, saved ${formatAge(ageInfo({ created_at: i.createdAt, expires_at: null }).ageDays)}. Trust: ${i.trust.label}.`}</p>
              <form method="post" action={`/memory/${encodeURIComponent(i.id)}/review`} className={styles.reviewForm}>
                <label htmlFor={`note-${i.id}`} className={styles.reactLabel}>
                  Note (where you checked, or why)
                </label>
                <input id={`note-${i.id}`} name="note" maxLength={REVIEW_NOTE_MAX} required className={styles.commentInput} />
                <div className={styles.reactRow}>
                  {i.authorId !== viewer.ownerId ? (
                    <button type="submit" name="action" value="confirm" className={`${styles.reactBtn} ${styles.reactBtnMain}`}>
                      Confirm
                    </button>
                  ) : null}
                  <button type="submit" name="action" value="keep" className={styles.reactBtn}>
                    Keep
                  </button>
                  <button type="submit" name="action" value="retire" className={styles.reactBtn}>
                    Retire
                  </button>
                </div>
              </form>
            </li>
          ))}
        </ol>
      )}
    </section>
  );

  return (
    <Shell>
      <div className={styles.detail}>
        <Link href="/memory" className={styles.back}>
          ← Memory
        </Link>
        <h1 className="page-title">Review memories</h1>
        <p className="page-lede">
          Agents fix what breaks. People check what can&apos;t break. BAB asks you about business facts that agents still use, so
          old answers do not spread. Every answer lands in the memory&apos;s validation history.
        </p>
        {checkNote ? (
          <p role="status" className={RECHECK_OK_CODES.includes(checkNote.code) ? styles.reactOk : styles.reactNote}>
            {checkNote.text}
          </p>
        ) : null}
        <section className={styles.reviewSection} aria-labelledby="waiting">
          <h2 id="waiting">{`Waiting for you (${waiting.length})`}</h2>
          <p className={styles.reactHint}>Is this still true? Read the text and answer. Nothing changes a business fact without a person&apos;s OK.</p>
          {waiting.length === 0 ? <p className={styles.reviewNone}>Nothing waits for you.</p> : <ol className={styles.reviewList}>{waiting.map(waitingItem)}</ol>}
        </section>
        {message ? (
          <p role="status" className={REVIEW_OK_CODES.includes(message.code) ? styles.reactOk : styles.reactNote}>
            {message.text}
          </p>
        ) : null}
        {queue ? (
          <>
            {section("flagged", "Flagged", "Colleagues said these are wrong or stale. Newest flag first.", queue.flagged)}
            {section("due", "Due a check", "Past their check window and nobody else checked them in that time. Oldest first.", queue.due)}
            {section("unchecked", "Never checked by anyone but the author", "Newest first.", queue.unchecked)}
          </>
        ) : null}
      </div>
    </Shell>
  );
}

export const dynamic = "force-dynamic";
