import type { Metadata } from "next";
import Shell from "@/app/components/shell/Shell";
import { getSessionUser } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { CHANGELOG } from "@/lib/changelog";
import styles from "./changelog.module.css";

export const metadata: Metadata = {
  title: "News — Big Agentic Brain",
  description: "What changed in BAB, by date.",
};

function parts(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  const fmt = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
  return {
    day: fmt({ day: "numeric" }),
    month: fmt({ month: "long" }),
    weekday: fmt({ weekday: "long" }),
    year: fmt({ year: "numeric" }),
  };
}

/** "Today" / "Yesterday" for the two most recent days, in UTC like the dates themselves. */
function relative(iso: string, now: Date): string | null {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.round((today - Date.parse(`${iso}T00:00:00Z`)) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : null;
}

export default async function ChangelogPage() {
  // Read-only page: no identity required, see app/memory/page.tsx.
  const actor = await getSessionUser();
  await auditRequest({ actor, method: "GET", path: "/changelog", via: "ui" });

  const now = new Date();

  return (
    <Shell>
      <>
        <header className={styles.header}>
          <h1 className={styles.h1}>News</h1>
          <p className={styles.lede}>What changed in BAB, newest first.</p>
        </header>
        <ol className={styles.list}>
          {CHANGELOG.map((entry, i) => {
            const p = parts(entry.date);
            const rel = relative(entry.date, now);
            return (
              <li
                key={entry.date}
                id={entry.date}
                className={`${styles.entry} ${i === 0 ? styles.latest : ""}`}
              >
                <div className={styles.dateRow}>
                  <time className={styles.date} dateTime={entry.date}>
                    <span className={styles.day}>{p.day}</span>
                    <span className={styles.monthYear}>
                      <span className={styles.month}>{p.month}</span>
                      <span className={styles.weekday}>
                        {p.weekday} · {p.year}
                      </span>
                    </span>
                  </time>
                  {rel && <span className={styles.rel}>{rel}</span>}
                </div>
                <h2 className={styles.title}>{entry.title}</h2>
                <ul className={styles.changes}>
                  {entry.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </>
    </Shell>
  );
}

export const dynamic = "force-dynamic";
