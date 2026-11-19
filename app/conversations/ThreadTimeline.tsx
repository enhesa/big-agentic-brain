import Avatar from "@/app/components/shell/Avatar";
import { parseDbTime } from "@/lib/dates";
import { formatRelativeTime } from "@/lib/relative-time";
import type { ViewerMessage } from "@/lib/messages";
import type { ThreadRow } from "@/lib/types";
import styles from "./conversations.module.css";
import { formatDate, DATE_TIME } from "@/lib/branding";

/**
 * The chat body of one thread, shared by /conversations/[threadId] and the Inbox. With `viewerId`
 * (the Inbox only), a question with options the viewer received shows the answer form.
 */
export default function ThreadTimeline({
  thread,
  messages,
  viewerId,
}: {
  thread: ThreadRow;
  messages: ViewerMessage[];
  viewerId?: string;
}) {
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
            id={`m-${m.id}`}
            className={`${styles.msg} ${fromCreator ? styles.msgLeft : styles.msgRight} ${grouped ? styles.msgGrouped : ""}`}
            style={{ animationDelay: `${Math.min(i, 12) * 50}ms` }}
          >
            {!grouped ? (
              <div className={styles.msgWho}>
                <Avatar name={name} size={20} />
                <span>{name}</span>
              </div>
            ) : null}
            {m.request ? (
              <RequestCard
                request={m.request}
                names={new Map([[m.from_id, name], ...m.recipients.map((r) => [r.id, r.name ?? r.id] as [string, string])])}
                answerFor={viewerId && m.from_id !== viewerId && m.recipients.some((r) => r.id === viewerId) ? { messageId: m.id, viewerId } : undefined}
              />
            ) : null}
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

export function RequestCard({
  request,
  names,
  answerFor,
}: {
  request: NonNullable<ViewerMessage["request"]>;
  names?: Map<string, string>;
  /** Set when the viewer may answer: the message to answer and who is answering. */
  answerFor?: { messageId: string; viewerId: string };
}) {
  const mine = answerFor ? request.answers?.find((a) => a.by === answerFor.viewerId) : undefined;
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
      {request.options ? (
        <ul className={styles.requestAnswers} aria-label="Answers">
          {request.answers?.map((a) => (
            <li key={a.by} data-answer>
              <strong>{names?.get(a.by) ?? a.by}</strong>: {a.option}
              {a.note ? ` (${a.note})` : ""}
              <span className={styles.requestMeta}> {formatRelativeTime(a.at)}</span>
            </li>
          ))}
          {request.answers?.length ? null : <li className={styles.requestMeta}>No answer yet.</li>}
        </ul>
      ) : null}
      {request.options && answerFor ? (
        <form method="post" action="/inbox/answer" className={styles.answerForm} data-answer-form>
          <input type="hidden" name="messageId" value={answerFor.messageId} />
          <fieldset className={styles.answerOptions}>
            <legend>{mine ? "Change your answer" : "Your answer"}</legend>
            {request.options.map((option, i) => (
              <label key={option}>
                <input type="radio" name="option" value={i} required defaultChecked={mine?.option === option} /> {option}
              </label>
            ))}
          </fieldset>
          <label className={styles.answerNote}>
            Note (optional)
            <input type="text" name="note" maxLength={300} defaultValue={mine?.note ?? ""} autoComplete="off" />
          </label>
          <button type="submit">{mine ? "Change answer" : "Send answer"}</button>
        </form>
      ) : null}
    </div>
  );
}
