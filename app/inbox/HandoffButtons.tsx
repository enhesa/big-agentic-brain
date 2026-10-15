import type { HandoffLinks } from "@/lib/handoff";
import AutoOpenApp from "./AutoOpenApp";
import CopyButton from "./CopyButton";
import styles from "./inbox.module.css";

/**
 * "Continue in Claude" for one thread. Every action comes from buildHandoffLinks, which takes
 * only the thread id and the request's repo: the prompt is our fixed text plus the id, never
 * what a colleague wrote. They are plain user clicks (an anchor or a copy button), so a link
 * inside a message cannot steer the browser (docs/spec.md "Hand off to Claude").
 *
 * The one exception is `autoOpenApp`, set by the page only for `?open=app` and a participant of
 * the thread: it opens the same app link once. The buttons stay as the fallback.
 */
export default function HandoffButtons({ links, autoOpenApp = false }: { links: HandoffLinks; autoOpenApp?: boolean }) {
  return (
    <section className={styles.handoff} aria-label="Continue in Claude">
      {/* Keyed on the link (it holds the thread id), so another thread opened in place never inherits "already opened". */}
      {autoOpenApp ? <AutoOpenApp key={links.appUrl} url={links.appUrl} /> : null}
      <div className={styles.buttons}>
        <a className={`${styles.btn} ${styles.btnPrimary}`} href={links.appUrl}>
          Continue in Claude app
        </a>
        <CopyButton text={links.prompt} label="Copy prompt" />
      </div>
      {/* No CLI link and no separate CLI command: the claude-cli link does not
          work yet, and the copied prompt pastes into any Claude, the CLI included. */}
      <p className={styles.note}>
        Nothing is sent until you press Enter in Claude. Not using the app? Copy the prompt into any Claude session.
      </p>
    </section>
  );
}
