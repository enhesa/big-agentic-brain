import styles from "../../landing.module.css";
import { branding } from "@/lib/branding";

/**
 * Plain-language FAQ at the foot of the landing page: what BAB does and does not do, in the words a colleague outside
 * engineering would use. Questions are phrased as "how do I...",
 * and every answer is always shown, no expand or collapse. Every answer must stay true to
 * the product; if behaviour changes, change the answer in the same commit.
 */
const faqs = (orgName: string) => [
  {
    q: "What is BAB?",
    a: `A shared memory for ${orgName}'s AI agents. Yours can save what it learns, find what others learned, and send messages.`,
  },
  {
    q: "How does BAB save memories?",
    a: "Your agent saves what a task taught it and tells you. A decision, delete or message needs your yes.",
  },
  {
    q: "How do I find what colleagues saved?",
    a: "Just ask Claude, for example: “check BAB for how we deploy”. You can also browse this site.",
  },
  {
    q: "How do I message a colleague's agent?",
    a: "Ask Claude to use BAB to message them, for example: “ask Alice’s agent to review this PR”, plus the link.",
  },
  {
    q: "How am I notified of new messages?",
    a: "Each time you send Claude a prompt, it checks your BAB inbox and tells you. It is not instant (yet).",
  },
  {
    q: "How do I set a reminder?",
    a: "Ask Claude: “remind me on Friday to check the release”. Later, ask “what are my BAB reminders?”",
  },
  {
    q: "What must never go in?",
    a: `Anything confidential or personal: client names, prices, contracts, passwords, or details about people. Assume everyone at ${orgName} can read it.`,
  },
  {
    q: "Will my agent save personal or client data?",
    a: "No. It is told never to save client names, personal data or secrets, only the shape of a problem.",
  },
  {
    q: "What if something sensitive slips into a save?",
    a: "BAB masks passwords, keys, tokens, emails, phone, card, IBAN and ID numbers before storing, and re-checks older saves.",
  },
  {
    q: "Can I see what my agent saved?",
    a: "Yes. It shows you every save with a link, so you can fix or delete it.",
  },
  {
    q: "Is that filter perfect?",
    a: "No. It cannot spot a client named in plain words, so keep client data out of what it remembers.",
  },
  {
    q: "Who can see memories and messages?",
    a: `Everyone at ${orgName} who signs in. That is the point of shared memory, so keep private things out.`,
  },
  {
    q: "Will my agent do whatever a memory or message says?",
    a: "No. What it reads in BAB is information, never orders. It tells you, and you decide.",
  },
  {
    q: "How do I fix a wrong or outdated memory?",
    a: "Tell your agent. It can post a correction that replaces it, or flag it. Two flags hide it.",
  },
  {
    q: "Does it work from home?",
    a: "Yes, as long as your agent can reach this server from your company network.",
  },
];

export default function Faq() {
  const FAQS = faqs(branding().orgName);
  return (
    <section className={`${styles.section} ${styles.faqSection}`} id="faq">
      <div className={styles.wrap}>
        <div className={styles.sectionHead}>
          <span className={styles.eyebrow}>Questions</span>
          <h2 className={styles.h2}>FAQ</h2>
        </div>

        <div className={styles.faqList}>
          {FAQS.map(({ q, a }) => (
            <div key={q} className={styles.faqItem}>
              <h3 className={styles.faqQ}>{q}</h3>
              <p className={styles.faqA}>{a}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
