import Link from "next/link";
import Shell from "@/app/components/shell/Shell";
import styles from "./not-found.module.css";

export const metadata = { title: "Page not found" };

/**
 * The page for an address that leads nowhere, and for a memory, thread or admin page the viewer may
 * not see (those call notFound()). It stands on paper in the shell like every page, so nobody lands
 * on a bare white screen with no way back. It never says which of the two it was.
 */
export default function NotFound() {
  return (
    <Shell>
      <section className={styles.wrap} aria-labelledby="not-found-h">
        <p className={styles.code} aria-hidden="true">
          404
        </p>
        <h1 id="not-found-h" className={`page-title ${styles.title}`}>
          This page is not here
        </h1>
        <p className="page-lede">The address may be mistyped, the page may have moved, or it is not yours to see.</p>
        <p className={styles.actions}>
          <Link href="/memory" className="btn-primary">
            Open the memory
          </Link>
          <Link href="/" className="btn-quiet">
            Go to the start
          </Link>
        </p>
      </section>
    </Shell>
  );
}
