import styles from "./Shell.module.css";
import TopNav from "./TopNav";
import { branding } from "@/lib/branding";

/**
 * The shell itself has no controls: no identity block, no sign-out, no buttons or forms.
 * Pages add their own forms where they need one (feedback, /me/devices, /inbox); agents write
 * through the JSON API (see app/api/**).
 *
 * The bar itself lives in TopNav (a client component: it marks the current page and
 * badges the Inbox) and is styled to match the landing page's top bar exactly.
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <TopNav orgName={branding().orgName} />
      <div className={styles.content}>
        <div className="container">{children}</div>
      </div>
    </>
  );
}
