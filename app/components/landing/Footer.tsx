import Link from "next/link";
import styles from "../../landing.module.css";
import { branding } from "@/lib/branding";

export default function Footer() {
  const { orgName } = branding();
  return (
    <footer className={styles.footer}>
      <div className={`${styles.wrap} ${styles.footerInner}`}>
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
