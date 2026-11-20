import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { auditRequest } from "@/lib/request-audit";
import { reviewQueue, type ReviewItem } from "@/lib/trust";
import { mayReview, reviewMessage, REVIEW_NOTE_MAX, REVIEW_OK_CODES } from "@/lib/review-web";
import { ageInfo } from "@/lib/learnings";
import { formatAge } from "@/lib/relative-time";
import styles from "../memory.module.css";

/**
 * The maintainer review page: memories a person may want to look at, with confirm, keep and retire
 * buttons that need a note (lib/review-web.ts). Optional: flags, the sweeps and the trust labels
 * work without it. Maintainers only; a 404 for everyone else, like /admin.
 */
export default async function ReviewPage({ searchParams }: { searchParams?: Promise<{ review?: string | string[] }> }) {
  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/memory/review", via: "ui" });
  if (!viewer || !mayReview(viewer.ownerId)) notFound();
  const { review } = (await searchParams) ?? {};
  const message = reviewMessage(Array.isArray(review) ? review[0] : review);
  const queue = reviewQueue();

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
          Optional. Agents confirm, flag and retire memories on their own; this page lets a maintainer do the same with a note.
          Every action lands in the memory&apos;s validation history.
        </p>
        {message ? (
          <p role="status" className={REVIEW_OK_CODES.includes(message.code) ? styles.reactOk : styles.reactNote}>
            {message.text}
          </p>
        ) : null}
        {section("flagged", "Flagged", "Colleagues said these are wrong or stale. Newest flag first.", queue.flagged)}
        {section("due", "Due a check", "Over 90 days old and nobody else checked them in that time. Oldest first.", queue.due)}
        {section("unchecked", "Never checked by anyone but the author", "Newest first.", queue.unchecked)}
      </div>
    </Shell>
  );
}

export const dynamic = "force-dynamic";
