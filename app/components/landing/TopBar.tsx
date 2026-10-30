"use client";

import Link from "next/link";
import styles from "../../landing.module.css";
import { NAV_ITEMS } from "../nav-items";
import InboxBadge from "../shell/InboxBadge";
import { useInboxUnread } from "../shell/useInboxUnread";

export default function TopBar({ orgName }: { orgName: string }) {
  const inbox = useInboxUnread();

  return (
    <header className={styles.topbar}>
      <div className={`${styles.wrap} ${styles.topbarInner}`}>
        <div className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/branding/logo-light.svg" alt={orgName} className={styles.wordmark} />
          <span className={styles.brandSep} aria-hidden="true" />
          <span className={styles.brandName}>Big Agentic Brain</span>
        </div>

        <nav className={styles.nav} aria-label="Primary">
          {NAV_ITEMS.map((item) =>
            // The Inbox item hides while BAB_INBOX_PAGE=0 and carries the unread count.
            item.href === "/inbox" && inbox.off ? null : (
              <Link key={item.href} className={styles.navLink} href={item.href}>
                {item.label}
                {item.href === "/inbox" ? <InboxBadge count={inbox.count} /> : null}
              </Link>
            ),
          )}
        </nav>
      </div>
    </header>
  );
}
