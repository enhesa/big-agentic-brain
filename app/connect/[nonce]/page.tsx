import Shell from "@/app/components/shell/Shell";
import styles from "@/app/me/devices/devices.module.css";

/**
 * /connect/<nonce> is retired. Links used to connect a device through a browser sign-in; since
 * the honour-system decision Claude tells BAB who the person is itself, with
 * bab_identify, so there is nothing to open. The route stays only so a link someone already has
 * lands on a plain explanation instead of a 404. It reads nothing, binds nothing and does not
 * look at the nonce.
 */
export default function ConnectPage() {
  return (
    <Shell>
      <h1 className={styles.h1}>This link is no longer needed</h1>
      <div className="card">
        <p className={styles.muted}>Claude now identifies itself. You can close this tab.</p>
      </div>
    </Shell>
  );
}
