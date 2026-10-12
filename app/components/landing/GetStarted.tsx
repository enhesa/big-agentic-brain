import styles from "../../landing.module.css";
import { branding } from "@/lib/branding";
import CopyPrompt from "./CopyPrompt";
import Reveal from "./Reveal";

/**
 * BAB ships as an opt-in plugin from the configured plugin marketplace (owner, 2026-09-23):
 * nobody gets it automatically, so this section is the only place a colleague learns how
 * to add it. The old "paste this prompt" installer (/instructions/install.md) still
 * works and stays served for the legacy hook, but it is no longer what we point people at.
 * The annotated screenshot carries the steps; a separate step row only repeated it
 * (owner, 2026-09-23).
 */
export default function GetStarted() {
  const { installCommands } = branding();
  return (
    <section className={styles.section} id="get-started">
      <div className={styles.wrap}>
        <div className={styles.sectionHead}>
          <span className={styles.eyebrow}>Get started</span>
          <h2 className={styles.h2}>Installation</h2>
          <p className={styles.sub}>
            Add the Big Agentic Brain plugin in Claude Code.
          </p>
        </div>

        <h3 className={styles.cliHead}>Two commands</h3>
        <p className={styles.cliSub}>Run these in Claude Code, one after the other.</p>
        <div className={styles.cliRows}>
          <Reveal className={styles.promptCard}>
            <CopyPrompt text={installCommands.marketplace} />
          </Reveal>
          <Reveal className={styles.promptCard} delay={110}>
            <CopyPrompt text={installCommands.install} />
          </Reveal>
        </div>
        <p className={styles.cliSub}>When Claude asks for the BAB server URL, enter this site&apos;s address.</p>
      </div>
    </section>
  );
}
