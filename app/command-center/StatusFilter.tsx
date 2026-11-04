"use client";

import { useEffect, useState } from "react";
import styles from "./command-center.module.css";

type Count = { status: string; label: string; n: number };

/**
 * The status counts above the cards. A press shows only that status (data-filter on the card
 * flow; the CSS hides the rest); a second press, or All, shows every card again.
 */
export default function StatusFilter({ counts }: { counts: Count[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  useEffect(() => {
    const flow = document.querySelector<HTMLElement>("[data-cc-flow]");
    if (!flow) return;
    if (filter) flow.dataset.filter = filter;
    else delete flow.dataset.filter;
  }, [filter]);
  return (
    <div className={styles.filters} role="group" aria-label="Filter initiatives by status">
      <button type="button" className={styles.filter} aria-pressed={filter === null} onClick={() => setFilter(null)}>
        All
        <span className={styles.filterCount}>{counts.reduce((n, c) => n + c.n, 0)}</span>
      </button>
      {counts.map((c) => (
        <button
          key={c.status}
          type="button"
          className={`${styles.filter} ${styles[`badge_${c.status}`] ?? ""}`}
          data-status-filter={c.status}
          aria-pressed={filter === c.status}
          disabled={c.n === 0 && filter !== c.status}
          onClick={() => setFilter(filter === c.status ? null : c.status)}
        >
          <span className={styles.badgeDot} aria-hidden="true" />
          {c.label}
          <span className={styles.filterCount}>{c.n}</span>
        </button>
      ))}
    </div>
  );
}
