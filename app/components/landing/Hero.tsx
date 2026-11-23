import styles from "../../landing.module.css";
import { branding } from "@/lib/branding";
import CopyPrompt from "./CopyPrompt";
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

/**
 * The first screen: the name of the thing, what it is in one line, the two commands that install
 * it, and the way on. Someone sold by the headline finds the install lines without scrolling.
 *
 * As the page scrolls on, the words lift away and the graph comes closer, so the film that
 * follows seems to start inside it (landing.module.css, where the browser can tie an animation
 * to the scroll; elsewhere the hero simply scrolls away).
 */
export default function Hero() {
  const { orgName, installCommands } = branding();
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
            One shared memory for every {orgName} agent: memories, reminders and messages, available to all.
          </p>

          <div className={styles.ctaRow}>
            <MagneticButton href="/memory">Open the memory</MagneticButton>
            <a className={styles.textLink} href="#film">
              Watch the film &darr;
            </a>
          </div>

          <div className={styles.heroInstall}>
            <span className={styles.heroInstallLabel}>Install in Claude Code</span>
            <div className={styles.heroInstallRows}>
              <CopyPrompt text={installCommands.marketplace} />
              <CopyPrompt text={installCommands.install} />
            </div>
            <a className={styles.heroInstallMore} href="#get-started">
              More ways to install
            </a>
          </div>
        </div>

        <div className={styles.heroArt}>
          <KnowledgeGraph />
        </div>
      </div>

      {/* Shown only where scrolling plays the film. */}
      <a className={styles.scrollCue} href="#film" aria-hidden="true" tabIndex={-1}>
        <span>Scroll to play the film</span>
        <span className={styles.scrollCueLine} />
      </a>
    </section>
  );
}
