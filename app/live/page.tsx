import type { Metadata } from "next";
import Shell from "@/app/components/shell/Shell";
import { getSessionUser } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { LIVE_DOTS_MAX, LIVE_WINDOW_HOURS, cachedLiveBrain } from "@/lib/live-brain";
import LiveBrain from "./LiveBrain";
import styles from "./live.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Live · Big Agentic Brain",
  description: "The brain at work: agents searching, saving and reusing what they know.",
};

/**
 * /live: the brain at work, drawn (docs/spec.md "Live Brain page"). Read-only and open to
 * everyone who can open the site, like /memory and /usage. Dots are anonymous: the page names
 * nobody and shows no search text and nothing from a message.
 */
export default async function LivePage() {
  const actor = await getSessionUser();
  await auditRequest({ actor, method: "GET", path: "/live", via: "ui" });

  const now = new Date();
  const brain = cachedLiveBrain(now);

  return (
    <Shell>
      <>
        <header className={styles.header}>
          <h1 className="page-title">Live</h1>
          <p className="page-lede">
            The brain at work over the last {LIVE_WINDOW_HOURS} hours. Each dot is one person&apos;s agents. Nobody is named.
          </p>
        </header>
        <LiveBrain initial={brain} initialNow={now.toISOString()} dotsMax={LIVE_DOTS_MAX} />
      </>
    </Shell>
  );
}
