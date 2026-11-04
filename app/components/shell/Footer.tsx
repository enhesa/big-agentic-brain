import Link from "next/link";
import styles from "./Footer.module.css";
import { branding } from "@/lib/branding";

/**
 * The one footer, on the home page and on every page in the Shell. How it works (/docs) and
 * Feedback live here, not in the top bar (tests/nav-consistency.test.ts). Its inner box is
 * the shared `.container`, so it lines up with the bar above it.
 */
export default function Footer() {
  const { orgName } = branding();
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.footerInner}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/branding/logo-light.svg" alt={orgName} className={styles.footerMark} />
        <div className={styles.footerLinks}>
          <Link href="/memory">Open the memory</Link>
          <Link href="/docs">How it works</Link>
          <Link href="/changelog">News</Link>
          <Link href="/feedback">Feedback</Link>
          <span>{orgName} &copy; {new Date().getFullYear()}</span>
        </div>
      </div>
    </footer>
  );
}
