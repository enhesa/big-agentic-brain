import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/app/components/shell/Shell";
import LiveUpdates from "@/app/components/shell/LiveUpdates";
import { getSessionUser } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { get } from "@/lib/feedback";
import { parseDbTime } from "@/lib/dates";
import { formatRelativeTime } from "@/lib/relative-time";
import StatusChip from "../StatusChip";
import styles from "../feedback.module.css";
import { formatDate, DATE_TIME } from "@/lib/branding";

/** One feedback item: the report, who voted how many, the thread and the status history. */
export default async function FeedbackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getSessionUser();
  await auditRequest({ actor, method: "GET", path: `/feedback/${id}`, via: "ui" });

  const found = get(id);
  if (!found) notFound();
  const { item, comments } = found;

  return (
    <Shell>
      <div className={styles.detail}>
        <Link href="/feedback" className={styles.back}>
          ← Feedback
        </Link>
        <div className={styles.header}>
          <h1 className={styles.detailTitle}>{item.title}</h1>
          <LiveUpdates topics="feedback" />
        </div>

        <div className={styles.meta}>
          <StatusChip status={item.status} />
          <span className={styles.chip}>{item.kind}</span>
          <span className={styles.chip}>{item.area}</span>
          <span title={formatDate(parseDbTime(item.created_at), DATE_TIME)}>
            {item.authorName ?? item.author_id} ({item.source}) · {formatRelativeTime(item.created_at)}
          </span>
          {item.client_version ? <span>{item.client_version}</span> : null}
          {item.duplicate_of ? (
            <span>
              duplicate of <Link href={`/feedback/${item.duplicate_of}`}>this item</Link>
            </span>
          ) : null}
        </div>

        <p className={styles.bodyText}>{item.body}</p>

        <form className={styles.voteForm} method="post" action={`/feedback/${item.id}/vote`}>
          <button type="submit" className={styles.primary}>
            Vote ({item.votes})
          </button>
        </form>

        <h2 className={styles.subline}>
          {comments.length === 0 ? "No comments yet" : `${comments.length} ${comments.length === 1 ? "entry" : "entries"}`}
        </h2>
        <ol className={styles.thread}>
          {comments.map((c) => (
            <li key={c.id} className={c.kind === "status" ? styles.statusEntry : styles.comment}>
              <div className={styles.commentWho} title={formatDate(parseDbTime(c.created_at), DATE_TIME)}>
                {c.authorName ?? c.author_id} · {formatRelativeTime(c.created_at)}
              </div>
              <div className={styles.commentBody}>{c.body}</div>
            </li>
          ))}
        </ol>

        <p className={styles.note}>
          Agents comment and vote with <code>bab_feedback</code>; maintainers set the status.
        </p>
      </div>
    </Shell>
  );
}

export const dynamic = "force-dynamic";
