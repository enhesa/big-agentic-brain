import Link from "next/link";
import type { OwnReactions } from "@/lib/learnings";
import { MEMORY_COMMENT_MAX, type MemoryComment } from "@/lib/memory-comments";
import { REACT_OK_CODES, type ReactCode } from "@/lib/memory-react-web";
import { formatRelativeTime } from "@/lib/relative-time";
import { parseDbTime } from "@/lib/dates";
import { formatDate, DATE_TIME } from "@/lib/branding";
import styles from "../memory.module.css";

/**
 * Comments, and the Helpful / Not helpful vote, on a memory's page. Plain HTML forms, so they work
 * without JavaScript. One form posts to ./react: "Post comment", or a vote that also posts the
 * comment when one was written (two records). Edit and delete post to ./comments/<id>; the edit box
 * opens with ?edit=<id>. Comment text is colleagues' text: React text only, never HTML.
 */
export default function CommentsPanel({
  learningId,
  comments,
  state,
  viewerId,
  maintainer,
  mine,
  editing,
  message,
}: {
  learningId: string;
  comments: MemoryComment[];
  /** "none": no sign-in, read only. "link": signed in, not linked. "own": the viewer wrote the memory. "open": may vote. */
  state: "none" | "link" | "own" | "open";
  viewerId: string | null;
  maintainer: boolean;
  mine: OwnReactions | null;
  /** The comment id from ?edit=, when it is the viewer's own. */
  editing: string | null;
  message: { code: ReactCode; text: string } | null;
}) {
  const base = `/memory/${encodeURIComponent(learningId)}`;
  const live = comments.filter((c) => !c.deletedAt).length;
  const canAct = state === "own" || state === "open";
  return (
    <section id="comments" className={styles.react} aria-labelledby="comments-heading">
      <h2 id="comments-heading" className={styles.reactHeading}>
        {live > 0 ? `Comments (${live})` : "Comments"}
      </h2>
      {message ? (
        <p role="status" className={REACT_OK_CODES.includes(message.code) ? styles.reactOk : styles.reactNote}>
          {message.text}
        </p>
      ) : null}

      {comments.length > 0 ? (
        <ol className={styles.comments}>
          {comments.map((c) => {
            const own = viewerId !== null && c.authorId === viewerId;
            const open = !c.deletedAt;
            return (
              <li key={c.id} id={`comment-${c.id}`} className={styles.comment}>
                <p className={styles.commentMeta}>
                  <strong>{c.authorName ?? c.authorId}</strong>
                  {" · "}
                  <time dateTime={parseDbTime(c.createdAt).toISOString()} title={formatDate(parseDbTime(c.createdAt), DATE_TIME)}>
                    {formatRelativeTime(c.createdAt)}
                  </time>
                  {c.editedAt && open ? " · edited" : ""}
                </p>
                {!open ? (
                  <p className={styles.commentRemoved}>Comment removed</p>
                ) : editing === c.id && own ? (
                  <form method="post" action={`${base}/comments/${encodeURIComponent(c.id)}`} className={styles.commentForm}>
                    <input type="hidden" name="action" value="edit" />
                    <label htmlFor={`edit-${c.id}`} className={styles.reactLabel}>
                      Edit your comment
                    </label>
                    <textarea
                      id={`edit-${c.id}`}
                      name="body"
                      rows={4}
                      maxLength={MEMORY_COMMENT_MAX}
                      required
                      defaultValue={c.body ?? ""}
                      className={styles.commentInput}
                    />
                    <div className={styles.reactRow}>
                      <button type="submit" className={styles.reactBtn}>
                        Save
                      </button>
                      <Link href={`${base}#comment-${c.id}`} className={styles.commentAction}>
                        Cancel
                      </Link>
                    </div>
                  </form>
                ) : (
                  <p className={styles.commentBody}>{c.body}</p>
                )}
                {open && editing !== c.id && (own || maintainer) ? (
                  <div className={styles.commentActions}>
                    {own ? (
                      <Link href={`${base}?edit=${encodeURIComponent(c.id)}#comment-${c.id}`} className={styles.commentAction}>
                        Edit
                      </Link>
                    ) : null}
                    <form method="post" action={`${base}/comments/${encodeURIComponent(c.id)}`}>
                      <input type="hidden" name="action" value="delete" />
                      <button type="submit" className={styles.commentAction} aria-label={own ? "Delete your comment" : "Delete this comment (maintainer)"}>
                        Delete
                      </button>
                    </form>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className={styles.reactHint}>No comments yet.</p>
      )}

      {state === "link" ? (
        <p className={styles.reactHint}>
          Link your browser on <Link href="/me/devices">/me/devices</Link> to comment and vote here.
        </p>
      ) : canAct ? (
        <form method="post" action={`${base}/react`} className={styles.commentForm}>
          <label htmlFor="comment-body" className={styles.reactLabel}>
            Add a comment
          </label>
          <textarea
            id="comment-body"
            name="body"
            rows={3}
            maxLength={MEMORY_COMMENT_MAX}
            className={styles.commentInput}
            placeholder="Extra context, a caveat, where it worked for you"
            aria-describedby="comment-hint"
          />
          <p id="comment-hint" className={styles.reactHint}>
            Plain text. Colleagues and their agents read it with the memory.
          </p>
          <div className={styles.reactRow}>
            <button type="submit" name="action" value="comment" className={styles.reactBtn}>
              Post comment
            </button>
            {state === "open" ? (
              <div className={styles.voteGroup} role="group" aria-labelledby="vote-label">
                <span id="vote-label" className={styles.voteLabel}>
                  Did this help you?
                </span>
                <button type="submit" name="action" value="helpful" aria-pressed={mine?.vote === "helpful"} className={styles.reactBtn}>
                  Helpful
                </button>
                <button type="submit" name="action" value="not_helpful" aria-pressed={mine?.vote === "not_helpful"} className={styles.reactBtn}>
                  Not helpful
                </button>
              </div>
            ) : null}
          </div>
          <p className={styles.reactHint}>
            {state === "open"
              ? "Helpful and Not helpful also post your comment, if you wrote one. One vote each: pick the other button to change it."
              : "This is your memory, so you cannot vote on it."}
          </p>
        </form>
      ) : null}
    </section>
  );
}
