import Avatar from "@/app/components/shell/Avatar";
import { parseDbTime } from "@/lib/dates";
import { formatRelativeTime } from "@/lib/relative-time";
import type { ViewerMessage } from "@/lib/messages";
import type { ThreadRow } from "@/lib/types";
import styles from "./conversations.module.css";
import { formatDate, DATE_TIME } from "@/lib/branding";

/** The chat body of one thread, shared by /conversations/[threadId] and the Inbox. */
export default function ThreadTimeline({ thread, messages }: { thread: ThreadRow; messages: ViewerMessage[] }) {
  return (
    <ol className={styles.timeline}>
      {messages.map((m, i) => {
        const fromCreator = m.from_id === thread.created_by;
        const prev = messages[i - 1];
        const grouped = prev?.from_id === m.from_id;
        const name = m.fromName ?? m.from_id;
        return (
          <li
            key={m.id}
            className={`${styles.msg} ${fromCreator ? styles.msgLeft : styles.msgRight} ${grouped ? styles.msgGrouped : ""}`}
            style={{ animationDelay: `${Math.min(i, 12) * 50}ms` }}
          >
            {!grouped ? (
              <div className={styles.msgWho}>
                <Avatar name={name} size={20} />
                <span>{name}</span>
              </div>
            ) : null}
            {m.request ? <RequestCard request={m.request} /> : null}
            <div className={styles.bubble}>
              {m.body}
              {m.kind === "auto" ? <span className={styles.autoTag}>auto-reply</span> : null}
            </div>
            <div className={styles.msgWhen} title={formatDate(parseDbTime(m.created_at), DATE_TIME)}>
              {formatRelativeTime(m.created_at)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function RequestCard({ request }: { request: NonNullable<ViewerMessage["request"]> }) {
  return (
    <div className={styles.requestCard}>
      <span className={styles.requestKind}>{request.kind}</span>
      <p className={styles.requestGoal}>{request.goal}</p>
      {request.repo ? <span className={styles.requestMeta}>repo: {request.repo}</span> : null}
      {request.ref ? <span className={styles.requestMeta}>ref: {request.ref}</span> : null}
      {request.cwd ? <span className={styles.requestMeta}>cwd: {request.cwd}</span> : null}
      {request.links?.map((link) => (
        <span key={link} className={styles.requestMeta}>
          <a href={/^https?:\/\//i.test(link) ? link : undefined} target="_blank" rel="noreferrer">
            {link}
          </a>
        </span>
      ))}
    </div>
  );
}
