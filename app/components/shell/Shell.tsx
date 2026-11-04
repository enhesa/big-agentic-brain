import styles from "./Shell.module.css";
import TopNav from "./TopNav";
import Footer from "./Footer";
import { branding } from "@/lib/branding";

/**
 * The shell itself has no controls: no identity block, no sign-out, no buttons or forms.
 * Pages add their own forms where they need one (feedback, /me/devices, /inbox); agents write
 * through the JSON API (see app/api/**).
 *
 * The bar itself lives in TopNav (a client component: it marks the current page and
 * badges the Inbox) and is styled to match the landing page's top bar exactly.
 *
 * Bar, main column and footer all sit in the shared `.container` box (--shell-max-width and
 * --shell-gutter in app/globals.css), the same box the home page uses, so the bar never moves
 * between pages. The footer is the home page's footer (./Footer.tsx).
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.frame}>
      <TopNav orgName={branding().orgName} />
      <main className={styles.content}>
        <div className="container">{children}</div>
      </main>
      <Footer />
    </div>
  );
}
