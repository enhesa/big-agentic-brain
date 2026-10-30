"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Shell.module.css";
import { NAV_ITEMS } from "../nav-items";
import InboxBadge from "./InboxBadge";
import { useInboxUnread } from "./useInboxUnread";

/**
 * The inner-page bar, deliberately identical in style to the landing page's TopBar
 * (app/components/landing/TopBar.tsx): the same light sticky bar, solid white so the page
 * does not show through it, the same navy wordmark, the same steel links. The bar keeps one size at every
 * scroll position: it used to shrink on scroll, which was jumpy, so that is gone. Decided: "the navbar on the inner pages the same as the homepage".
 *
 * A client component for two reasons: marking the page you are on, and the live Inbox
 * badge. The Shell around it stays a server component.
 */
export default function TopNav({ orgName }: { orgName: string }) {
  const pathname = usePathname() ?? "";
  const inbox = useInboxUnread();

  return (
    <header className={styles.topbar}>
      <div className={`container ${styles.topbarInner}`}>
        <Link href="/" className={styles.brand} aria-label="Big Agentic Brain, home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/branding/logo-light.svg" alt={orgName} className={styles.wordmark} />
          <span className={styles.brandSep} aria-hidden="true" />
          <span className={styles.brandName}>Big Agentic Brain</span>
        </Link>

        <nav className={styles.nav} aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            // The Inbox item hides while BAB_INBOX_PAGE=0 and carries the unread count.
            if (item.href === "/inbox" && inbox.off) return null;
            const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navLink} ${current ? styles.navLinkOn : ""}`}
                aria-current={current ? "page" : undefined}
              >
                {item.label}
                {item.href === "/inbox" ? <InboxBadge count={inbox.count} /> : null}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
