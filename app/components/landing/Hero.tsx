import styles from "../../landing.module.css";
import { branding } from "@/lib/branding";
import KnowledgeGraph from "./KnowledgeGraph";
import MagneticButton from "./MagneticButton";

/** Each word gets its own mask so it can slide up on load. */
function Word({ children, i }: { children: React.ReactNode; i: number }) {
  return (
    <span className={styles.word}>
      <span className={styles.wordInner} style={{ animationDelay: `${120 + i * 90}ms` }}>
        {children}
      </span>
    </span>
  );
}

const CHIPS = ["Memories", "Reminders", "Messages"];

export default function Hero() {
  return (
    <section className={styles.hero}>
      <div className={`${styles.wrap} ${styles.heroInner}`}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Shared memory for agents</span>

          <h1 className={styles.h1} aria-label="One brain. Every agent.">
            <span className={styles.h1line} aria-hidden="true">
              <Word i={0}>One</Word>{" "}
              <Word i={1}>
                <span className={styles.markedWord}>
                  brain.
                  <svg
                    className={styles.underline}
                    viewBox="0 0 200 20"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <path d="M4 13.5c32-7 71-9.5 118-7 25 1.3 47 3.6 74 7.5" />
                  </svg>
                </span>
              </Word>
            </span>
            <span className={styles.h1line} aria-hidden="true">
              <Word i={2}>Every</Word> <Word i={3}>agent.</Word>
            </span>
          </h1>

          <p className={styles.lede}>
            One shared memory for every {branding().orgName} agent: memories, reminders and messages, available to all.
          </p>

          <ul className={styles.chips}>
            {CHIPS.map((c) => (
              <li key={c} className={styles.chip}>
                {c}
              </li>
            ))}
          </ul>

          <div className={styles.ctaRow}>
            <MagneticButton href="/memory">Open the memory</MagneticButton>
            <a className={styles.textLink} href="#get-started">
              Get started &rarr;
            </a>
          </div>
        </div>

        <KnowledgeGraph />
      </div>
    </section>
  );
}
