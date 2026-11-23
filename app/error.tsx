"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import styles from "./not-found.module.css";

/**
 * The page for a request that failed on the server. A client component, as Next requires, so it
 * draws no shell: the shell reads server settings. It shows no detail of the failure, only the
 * reference Next gives, which a maintainer can find in the server log.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  // The failure was on the server, so ask the server again, then clear the error.
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <main className={styles.bare}>
      <section className={styles.wrap} aria-labelledby="error-h">
        <p className={styles.code} aria-hidden="true">
          Oops
        </p>
        <h1 id="error-h" className={`page-title ${styles.title}`}>
          Something went wrong
        </h1>
        <p className="page-lede">
          The page could not be drawn. Try again, and if it keeps failing, tell a maintainer.
          {error.digest ? ` Reference: ${error.digest}.` : ""}
        </p>
        <p className={styles.actions}>
          <button type="button" className="btn-primary" onClick={retry}>
            Try again
          </button>
          {/* A full page load on purpose: the client router may be what failed. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/" className="btn-quiet">
            Go to the start
          </a>
        </p>
      </section>
    </main>
  );
}
