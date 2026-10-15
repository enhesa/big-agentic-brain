import styles from "../../landing.module.css";
import Reveal from "./Reveal";

/**
 * "What you get": one section in place of "What it saves you" and "Features" (merged: the
 * old pair looked cramped and repeated itself). Three big
 * columns, one per thing BAB holds, each led by the benefit rather than the mechanism;
 * the four house rules shrink to a single row of pills underneath, because their titles
 * already say everything the old one-line subtitles did.
 *
 * The old section ids stay (#why, #what-it-holds, #rules) so any link into them lands.
 */

function LearningIcon() {
  return (
    <svg viewBox="0 0 96 72" className={styles.holdIcon} aria-hidden="true">
      <rect x="10" y="8" width="76" height="56" rx="10" fill="#fff" stroke="var(--teal)" strokeWidth="2.5" />
      <line x1="24" y1="26" x2="72" y2="26" className={`${styles.ink} ${styles.ink1}`} />
      <line x1="24" y1="38" x2="60" y2="38" className={`${styles.ink} ${styles.ink2}`} />
      <line x1="24" y1="50" x2="48" y2="50" className={`${styles.ink} ${styles.ink3}`} />
      <g className={styles.holdBadge}>
        <circle cx="78" cy="14" r="10" fill="var(--teal)" />
        <path d="M73 14 L77 18 L84 10" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

function ReminderIcon() {
  return (
    <svg viewBox="0 0 96 72" className={styles.holdIcon} aria-hidden="true">
      <circle cx="48" cy="38" r="26" fill="#fff" stroke="var(--amber)" strokeWidth="2.5" />
      <line x1="48" y1="38" x2="48" y2="22" stroke="var(--navy)" strokeWidth="3" strokeLinecap="round" className={styles.hand} />
      <line x1="48" y1="38" x2="60" y2="38" stroke="var(--navy)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="48" cy="38" r="2.5" fill="var(--navy)" />
      <g className={styles.holdBell}>
        <path d="M74 20 C74 12 77 6 82 6 C87 6 90 12 90 20 Z" fill="var(--amber)" />
        <rect x="72" y="20" width="20" height="3" rx="1.5" fill="var(--amber)" />
      </g>
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg viewBox="0 0 96 72" className={styles.holdIcon} aria-hidden="true">
      <rect x="8" y="16" width="40" height="30" rx="8" fill="#fff" stroke="var(--teal)" strokeWidth="2.5" />
      <rect x="48" y="30" width="40" height="30" rx="8" fill="#fff" stroke="var(--amber)" strokeWidth="2.5" className={styles.holdReply} />
      <g className={styles.plane}>
        <path d="M0 0 L16 -6 L6 10 L4 3 Z" fill="var(--navy)" />
      </g>
    </svg>
  );
}

const ITEMS = [
  {
    kind: "Memories",
    headline: "Store & retrieve memory",
    body: "Your agent saves what it learns. Every other agent can find it.",
    Icon: LearningIcon,
    accent: "teal",
  },
  {
    kind: "Reminders",
    headline: "Create reminders",
    body: "Pick a date. The reminder comes back to you that day.",
    Icon: ReminderIcon,
    accent: "amber",
  },
  {
    kind: "Messages",
    headline: "Let agents chat",
    body: "Your agent can message a colleague's agent. You can read every message.",
    Icon: MessageIcon,
    accent: "coral",
  },
];

const RULES = ["Acts only as you", "Asks before saving", "Reference, not orders", "Everything audited"];

export default function Holds() {
  return (
    <section className={`${styles.section} ${styles.getSection}`} id="what-it-holds">
      <span id="why" className={styles.anchor} aria-hidden="true" />
      <div className={styles.wrap}>
        <div className={styles.sectionHead}>
          <span className={styles.eyebrow}>What you get</span>
          <h2 className={styles.h2}>Features</h2>
        </div>

        <ul className={styles.getList}>
          {ITEMS.map(({ kind, headline, body, Icon, accent }, i) => (
            <Reveal as="li" key={kind} className={styles.getCard} delay={i * 100}>
              <span className={styles.getGlow} data-accent={accent} aria-hidden="true" />
              <Icon />
              <span className={styles.getKind} data-accent={accent}>
                {kind}
              </span>
              <h3 className={styles.getHeadline}>{headline}</h3>
              <p className={styles.getBody}>{body}</p>
            </Reveal>
          ))}
        </ul>

        <div className={styles.safeRow} id="rules">
          <span className={styles.safeLabel}>Safe by default</span>
          <ul className={styles.safeList}>
            {RULES.map((rule) => (
              <li key={rule} className={styles.safePill}>
                <svg viewBox="0 0 16 16" className={styles.safeCheck} aria-hidden="true" focusable="false">
                  <path d="M3.5 8.4 6.6 11.4 12.6 4.8" />
                </svg>
                {rule}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
