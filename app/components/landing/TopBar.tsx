"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "../../landing.module.css";
import { NAV_ITEMS } from "../nav-items";
import InboxBadge from "../shell/InboxBadge";
import { useInboxUnread } from "../shell/useInboxUnread";

export default function TopBar({ orgName }: { orgName: string }) {
  const [small, setSmall] = useState(false);
  const inbox = useInboxUnread();

  useEffect(() => {
    const onScroll = () => setSmall(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`${styles.topbar} ${small ? styles.topbarSmall : ""}`}>
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
