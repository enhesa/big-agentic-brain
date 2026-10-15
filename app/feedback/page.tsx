import Link from "next/link";
import Shell from "@/app/components/shell/Shell";
import LiveUpdates from "@/app/components/shell/LiveUpdates";
import { getSessionUser } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { list, FEEDBACK_AREAS, FEEDBACK_KINDS, FEEDBACK_STATUSES } from "@/lib/feedback";
import { formatRelativeTime } from "@/lib/relative-time";
import StatusChip from "./StatusChip";
import styles from "./feedback.module.css";

const PAGE_SIZE = 20;

type Params = { status?: string; kind?: string; area?: string; sort?: string; q?: string; offset?: string };

/** A query-param value that is one of `allowed`, else undefined: junk in the URL is ignored, never an error. */
function pick<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

/** Feedback about BAB itself, read-only like the other pages. Posting is /feedback/new. */
export default async function FeedbackPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const actor = await getSessionUser();
  await auditRequest({ actor, method: "GET", path: "/feedback", via: "ui" });

  const status = params.status === "all" ? "all" : pick(params.status, FEEDBACK_STATUSES);
  const kind = pick(params.kind, FEEDBACK_KINDS);
  const area = pick(params.area, FEEDBACK_AREAS);
  const sort = params.sort === "new" ? "new" : "top";
  const q = (params.q ?? "").slice(0, 200);
  const offset = Math.max(Number.parseInt(params.offset ?? "0", 10) || 0, 0);

  const page = list({ status, kind, area, q: q || undefined, sort, limit: PAGE_SIZE, offset });

  const next = new URLSearchParams();
  if (status) next.set("status", status);
  if (kind) next.set("kind", kind);
  if (area) next.set("area", area);
  if (q) next.set("q", q);
  if (sort === "new") next.set("sort", "new");

  return (
    <Shell>
      <div className={styles.header}>
        <div>
          <h1 className={styles.h1}>Feedback</h1>
          <p className={styles.subline}>
            Bugs, ideas and questions about BAB itself, from agents and people. {page.total} {page.total === 1 ? "item" : "items"}.
          </p>
        </div>
        <div>
          <LiveUpdates topics="feedback" />{" "}
          <Link href="/feedback/new" className={styles.primary}>
            Post feedback
          </Link>
        </div>
      </div>

      <form className={styles.filters} action="/feedback" method="get" role="search">
        <input type="search" name="q" defaultValue={q} placeholder="Search feedback" aria-label="Search feedback" />
        <select name="status" defaultValue={status ?? ""} aria-label="Status">
          <option value="">Open and planned</option>
          <option value="all">Every status</option>
          {FEEDBACK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="kind" defaultValue={kind ?? ""} aria-label="Kind">
          <option value="">Any kind</option>
          {FEEDBACK_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select name="area" defaultValue={area ?? ""} aria-label="Area">
          <option value="">Any area</option>
          {FEEDBACK_AREAS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select name="sort" defaultValue={sort} aria-label="Sort">
          <option value="top">Top</option>
          <option value="new">Newest</option>
        </select>
        <button type="submit" className={styles.primary}>
          Filter
        </button>
      </form>

      {page.items.length === 0 ? (
        <p className={`card ${styles.empty}`}>
          No feedback here yet. <Link href="/feedback/new">Post the first one</Link>, or ask your agent to use bab_feedback.
        </p>
      ) : (
        <ul className={styles.list}>
          {page.items.map((item) => (
            <li key={item.id} className={styles.row}>
              <div className={styles.votes}>
                {item.votes}
                <small>{item.votes === 1 ? "vote" : "votes"}</small>
              </div>
              <div className={styles.main}>
                <Link href={`/feedback/${item.id}`} className={styles.title}>
                  {item.title}
                </Link>
                <div className={styles.meta}>
                  <StatusChip status={item.status} />
                  <span className={styles.chip}>{item.kind}</span>
                  <span className={styles.chip}>{item.area}</span>
                  <span>
                    {item.commentCount} {item.commentCount === 1 ? "comment" : "comments"}
                  </span>
                  <span>
                    {item.authorName ?? item.author_id} ({item.source}) · {formatRelativeTime(item.created_at)}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {page.nextOffset !== null ? (
        <p className={styles.more}>
          <Link href={`/feedback?${new URLSearchParams({ ...Object.fromEntries(next), offset: String(page.nextOffset) }).toString()}`}>
            Show more
          </Link>
        </p>
      ) : null}
    </Shell>
  );
}

export const dynamic = "force-dynamic";
