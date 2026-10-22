import styles from "../../landing.module.css";
import { branding } from "@/lib/branding";
import CopyPrompt from "./CopyPrompt";
import Reveal from "./Reveal";

/**
 * BAB ships as an opt-in plugin from the configured plugin marketplace:
 * nobody gets it automatically, so this section is the only place a colleague learns how
 * to add it. The old "paste this prompt" installer (/instructions/install.md) still
 * works and stays served for the legacy hook, but it is no longer what we point people at.
 * A screenshot of the Claude app flow (Customize, search, Add) comes first; an organization can
 * swap it for its own or hide it (BAB_INSTALL_SCREENSHOT). The commands follow it.
 */
export default function GetStarted() {
  const { installCommands, installScreenshot } = branding();
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

        {installScreenshot ? (
          <Reveal as="figure" className={styles.installShot}>
            {/* Plain img: a static screenshot needs none of next/image's resizing. */}
            <img src={installScreenshot.src} alt={installScreenshot.alt} loading="lazy" />
          </Reveal>
        ) : null}

        <h3 className={styles.cliHead}>{installScreenshot ? "Prefer the terminal?" : "Two commands"}</h3>
        <p className={styles.cliSub}>Run these in Claude Code, one after the other.</p>
        <div className={styles.cliRows}>
          <Reveal className={styles.promptCard}>
            <CopyPrompt text={installCommands.marketplace} />
          </Reveal>
          <Reveal className={styles.promptCard} delay={110}>
            <CopyPrompt text={installCommands.install} />
          </Reveal>
        </div>
        <p className={styles.cliSub}>When Claude asks for the BAB server URL, enter this site&apos;s address, without a trailing slash.</p>
        <p className={styles.cliSub}>Fewer prompts: allow <code>bab_search</code>, <code>bab_inbox</code>, <code>bab_remind</code> and <code>bab_people</code>.</p>
        <p className={styles.cliSub}>In Claude Code, add them as <code>mcp__plugin_bab_bab__&lt;tool&gt;</code> to <code>permissions.allow</code> in <code>~/.claude/settings.json</code>.</p>
        <p className={styles.cliSub}>In the Claude desktop app, allow the same four.</p>
        <p className={styles.cliSub}>They read, or only change your own inbox, reminders and profile. Sending, saving and reacting still ask.</p>
      </div>
    </section>
  );
}
