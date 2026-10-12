import Link from "next/link";
import Shell from "@/app/components/shell/Shell";
import { getViewer } from "@/lib/notify-auth";
import { getSessionUser } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { FEEDBACK_AREAS, FEEDBACK_KINDS, isUuid } from "@/lib/feedback";
import styles from "../feedback.module.css";

/** What each error code from /feedback/submit says. The URL only ever carries a code. */
const ERROR_MESSAGES: Record<string, string> = {
  duplicate: "Looks like a duplicate of an open item. Vote on it instead, or post again if yours is genuinely different.",
  limit: "Daily feedback limit reached: vote on or comment on an existing item instead.",
  invalid: "Something in the form was not valid. Check the kind, area, title and text, then try again.",
  failed: "Posting failed. Try again in a moment.",
};

/**
 * The human way to post. The form posts to /feedback/submit (outside /api, so the sign-in proxy
 * attaches the viewer). A viewer BAB cannot identify is told to link their browser first.
 */
export default async function NewFeedbackPage({ searchParams }: { searchParams: Promise<{ error?: string; duplicate?: string }> }) {
  const params = await searchParams;
  const message = Object.hasOwn(ERROR_MESSAGES, params.error ?? "") ? ERROR_MESSAGES[params.error as string] : null;
  const duplicate = isUuid(params.duplicate) ? params.duplicate : null;
  const actor = await getSessionUser();
  await auditRequest({ actor, method: "GET", path: "/feedback/new", via: "ui" });
  const viewer = await getViewer();

  return (
    <Shell>
      <div className={styles.detail}>
        <Link href="/feedback" className={styles.back}>
          ← Feedback
        </Link>
        <h1 className={styles.detailTitle}>Post feedback</h1>
        <p className={styles.subline}>
          Something in BAB broken, confusing or missing? Search the list first and vote if it is already there. No secrets, client
          names or personal data.
        </p>

        {!viewer ? (
          <p className={styles.error}>
            BAB does not know who you are yet. Link your browser on the <Link href="/me/devices">Your devices</Link> page, then come back.
          </p>
        ) : null}
        {message ? (
          <p className={styles.error} role="alert">
            {message}
            {duplicate ? (
              <>
                {" "}
                <Link href={`/feedback/${duplicate}`}>Open the existing item</Link> and vote on it.
              </>
            ) : null}
          </p>
        ) : null}

        <form className={styles.form} method="post" action="/feedback/submit">
          <label>
            Kind
            <select name="kind" defaultValue="bug" required>
              {FEEDBACK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label>
            Area
            <select name="area" defaultValue="other" required>
              {FEEDBACK_AREAS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label>
            Title
            <input type="text" name="title" maxLength={160} required />
          </label>
          <label>
            What happened, what you expected
            <textarea name="body" maxLength={8000} required />
          </label>
          <label className={styles.checkRow}>
            <input type="checkbox" name="confirmNotDuplicate" />
            Only tick this after a duplicate warning, when yours is genuinely different.
          </label>
          <div>
            <button type="submit" className={styles.primary}>
              Post
            </button>
          </div>
        </form>
      </div>
    </Shell>
  );
}

export const dynamic = "force-dynamic";
