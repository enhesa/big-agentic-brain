import Link from "next/link";
import { KUDOS_NOTE_MAX, type OwnReactions } from "@/lib/learnings";
import type { ReactCode } from "@/lib/memory-react-web";
import styles from "../memory.module.css";

/**
 * Helpful, Not helpful and Kudos on a memory's page. Plain HTML forms, so they work without
 * JavaScript; the POST goes to ./react, which applies the same rules as bab_react. Flag, confirm,
 * retire and keep need evidence and stay with agents.
 */
export default function ReactionPanel({
  learningId,
  state,
  mine,
  message,
}: {
  learningId: string;
  /** "link": signed in but not linked yet. "own": the viewer wrote it. "open": may react. */
  state: "link" | "own" | "open";
  mine: OwnReactions | null;
  message: { code: ReactCode; text: string } | null;
}) {
  const action = `/memory/${encodeURIComponent(learningId)}/react`;
  return (
    <section className={styles.react} aria-labelledby="react-heading">
      <h2 id="react-heading" className={styles.reactHeading}>
        Did this help you?
      </h2>
      {message ? (
        <p role="status" className={message.code === "done" || message.code === "same" ? styles.reactOk : styles.reactNote}>
          {message.text}
        </p>
      ) : null}

      {state === "link" ? (
        <p className={styles.reactHint}>
          Link your browser on <Link href="/me/devices">/me/devices</Link> to react here.
        </p>
      ) : state === "own" ? (
        <p className={styles.reactHint}>This is your memory, so you cannot react to it.</p>
      ) : (
        <>
          <form method="post" action={action} className={styles.reactRow} role="group" aria-label="Your vote">
            <button
              type="submit"
              name="action"
              value="helpful"
              aria-pressed={mine?.vote === "helpful"}
              className={styles.reactBtn}
            >
              Helpful
            </button>
            <button
              type="submit"
              name="action"
              value="not_helpful"
              aria-pressed={mine?.vote === "not_helpful"}
              className={styles.reactBtn}
            >
              Not helpful
            </button>
          </form>

          {mine?.kudos ? (
            <p className={styles.reactHint}>You gave kudos on this memory.</p>
          ) : (
            <form method="post" action={action} className={styles.reactRow}>
              <input type="hidden" name="action" value="kudos" />
              <label htmlFor="kudos-note" className={styles.reactLabel}>
                Kudos note (optional)
              </label>
              <input
                id="kudos-note"
                name="note"
                type="text"
                maxLength={KUDOS_NOTE_MAX}
                className={styles.reactInput}
                placeholder="Thanks, this saved me an hour"
              />
              <button type="submit" className={styles.reactBtn}>
                Give kudos
              </button>
            </form>
          )}

          <p className={styles.reactHint}>
            One vote each. Pick the other button to change yours. Kudos is once per memory.
          </p>
        </>
      )}
    </section>
  );
}
