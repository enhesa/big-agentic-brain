import Link from "next/link";
import Shell from "@/app/components/shell/Shell";
import LiveUpdates from "@/app/components/shell/LiveUpdates";
import Avatar from "@/app/components/shell/Avatar";
import { getSessionUser } from "@/lib/session";
import { auditRequest } from "@/lib/request-audit";
import { search, searchTotal, list, expiryState, voteCounts, parseKindFilter, parseSort, LEARNING_KINDS, GENERAL_PROJECT_KEY } from "@/lib/learnings";
import type { ListFilters } from "@/lib/learnings";
import { parseAppliesToFilter, STACK_LABELS, platformLabels, EVERYWHERE } from "@/lib/applies-to";
import { standingText } from "@/lib/standing";
import type { LearningKind, LearningStatus } from "@/lib/types";
import { liveNumbers, topTags, topProjects, allAuthors, generalProjectCount } from "@/lib/stats";
import { formatAge, formatExpiry } from "@/lib/relative-time";
import FilterBar from "./FilterBar";
import type { FilterField } from "./FilterBar";
import { memoryHref } from "./memory-url";
import type { FilterValues } from "./memory-url";
import styles from "./memory.module.css";

type MemoryFilters = { q?: string; tag?: string; repo?: string; project?: string; author?: string; status?: string; kind?: string; applies?: string; sort?: string; page?: string };

/** Rows per page — matches search()'s own historical default, so an unfiltered
 *  first page looks exactly as it always did. */
const PAGE_SIZE = 20;

/** Human label for a UI-only status filter value (see BoardPage below for "all"'s meaning). */
const STATUS_FILTER_LABELS: Record<string, string> = {
  all: "include archived",
  archived: "archived only",
};

function describeStatusFilter(status: string): string {
  return STATUS_FILTER_LABELS[status] ?? status;
}

/** "General" for the reserved no-project sentinel, the raw key otherwise (filter pill / active-filters text). */
function describeProjectFilter(project: string): string {
  return project === GENERAL_PROJECT_KEY ? "General" : project;
}

/** Team tag -> accent, so a glance at the left edge says whose world a row is from. */
export const TEAM_COLORS: Record<string, string> = {
  marketing: "var(--teal)",
  sales: "var(--amber)",
  engineering: "var(--navy)",
  product: "#7c5cff",
  legal: "var(--coral)",
  regulatory: "var(--coral)",
  management: "#2f855a",
  operations: "#2f855a",
  finance: "#2f855a",
  hr: "#c05621",
  content: "var(--teal)",
  data: "#7c5cff",
  it: "var(--navy)",
};

export function teamAccent(tags: readonly string[]): string {
  for (const t of tags) if (TEAM_COLORS[t]) return TEAM_COLORS[t];
  return "var(--steel)";
}

function badgeClass(state: string) {
  if (state === "archived") return styles.badgeArchived;
  return styles.badgeExpired;
}

/** The memory list, compact and scannable: one row per entry, accent by team, title +
 *  one-line snippet, then who/when/signals. Tag filters stay chips (click to toggle);
 *  the search box and selects are one filter bar (FilterBar) that applies as it changes and
 *  keeps every combination a plain, linkable, no-JS-required URL. */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<MemoryFilters>;
}) {
  // Read-only page: no identity is required to browse the memory. If a proxy
  // SSO session (or agent headers, on a direct hit) resolves one anyway, the
  // audit row carries it; otherwise it's logged as anonymous.
  const actor = await getSessionUser();
  await auditRequest({ actor, method: "GET", path: "/memory", via: "ui" });
  const params = await searchParams;
  const q = params.q ?? "";
  const tag = params.tag ?? "";
  const repo = params.repo ?? "";
  const project = params.project ?? "";
  const author = params.author ?? "";
  const status = params.status ?? "";
  // A bad ?kind= only shows all kinds on this page; REST and MCP refuse it instead, because
  // an agent that mistypes a kind must not read "unfiltered" as "no standards exist".
  let kindFilter: LearningKind[] | undefined;
  try {
    kindFilter = parseKindFilter(params.kind);
  } catch {
    kindFilter = undefined;
  }
  const kind = kindFilter?.join(",") ?? "";
  // Same as kind: a bad ?applies= shows everything here (REST and MCP refuse it).
  let appliesFilter: string[] | undefined;
  try {
    appliesFilter = parseAppliesToFilter(params.applies);
  } catch {
    appliesFilter = undefined;
  }
  const applies = appliesFilter?.join(",") ?? "";
  // An unknown ?sort= keeps the default order, like a bad ?kind= above.
  const sortOrder = parseSort(params.sort);
  // Top is already the default without a search, so ?sort=top shows (and links) as the plain list.
  const sort = sortOrder === "top" && !q ? "" : (sortOrder ?? "");
  // 1-based; anything unparsable or below 1 collapses to page 1 rather than erroring.
  const requestedPage = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  // status is a three-way UI choice: unset = active (the ListFilters default),
  // "archived" = archived only (ListFilters already supports this directly), "all" =
  // "include archived" over active+archived. The data layer's own "all" also
  // returns `deleted` rows (an explicit, audited admin action, lib/maintenance.ts) which
  // this browser never shows, so that one value is filtered again below.
  const listStatus: LearningStatus | "all" | undefined =
    status === "archived" ? "archived" : status === "all" ? "all" : undefined;
  const learningFilters: ListFilters = {
    tag: tag || undefined,
    repo: repo || undefined,
    project: project || undefined,
    author: author || undefined,
    status: listStatus,
    kind: kindFilter,
    appliesTo: appliesFilter,
    sort: sortOrder,
  };

  // The count behind "Showing X-Y of N" for THESE filters, not the global count
  // (liveNumbers() below stays global — it's the header line, unrelated to a filtered
  // page). searchTotal() ignores limit/offset already; "all" needs its own deleted count
  // subtracted the same way `results` above already does, so N matches what's on screen.
  const total =
    status === "all"
      ? searchTotal(q, learningFilters) - list({ ...learningFilters, status: "deleted" }).length
      : searchTotal(q, learningFilters);
  // A page past the end (e.g. ?page=999999999) shows the last page instead of an empty one.
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, lastPage);
  const offset = (page - 1) * PAGE_SIZE;
  const rawResults = search(q, learningFilters, PAGE_SIZE, offset);
  const results = status === "all" ? rawResults.filter((r) => r.status !== "deleted") : rawResults;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + results.length, total);
  const hasPrev = page > 1;
  const hasNext = offset + PAGE_SIZE < total;

  const numbers = liveNumbers();
  const tags = topTags(14);
  const projects = topProjects(14);
  const generalCount = generalProjectCount();
  const authors = allAuthors();
  const authorOptions = authors.map((a) => ({ value: a.authorId, label: `${a.name} (${a.n})` }));
  // Past this many, the long tail moves to an A-Z group so a native select stays easy to scan.
  const MOST_ACTIVE_AUTHORS = 14;
  const authorChoices: FilterField["options"] =
    authorOptions.length > MOST_ACTIVE_AUTHORS
      ? [
          { group: "Most active", options: authorOptions.slice(0, MOST_ACTIVE_AUTHORS) },
          {
            group: "Everyone else",
            options: authorOptions.slice(MOST_ACTIVE_AUTHORS).sort((a, b) => a.label.localeCompare(b.label)),
          },
        ]
      : authorOptions;
  const filtered = Boolean(q || tag || repo || project || author || status || kind || applies);

  const href = (next: Partial<FilterValues>) => memoryHref({ q, tag, repo, project, author, status, kind, applies, sort, ...next });

  /** Same filters as href(), plus a `page` param (omitted for page 1, so the plain
   *  unfiltered/first-page URL never grows one it doesn't need). */
  const pageHref = (targetPage: number) => memoryHref({ q, tag, repo, project, author, status, kind, applies, sort, page: targetPage });

  const authorName = (id: string) => authors.find((a) => a.authorId === id)?.name ?? id;

  const activeFilters: Array<{ key: string; text: string; label: string; clear: Partial<FilterValues> }> = [];
  if (q) activeFilters.push({ key: "q", text: `search: ${q}`, label: `remove search filter ${q}`, clear: { q: "" } });
  if (project)
    activeFilters.push({
      key: "project",
      text: `project: ${describeProjectFilter(project)}`,
      label: `remove project filter ${describeProjectFilter(project)}`,
      clear: { project: "" },
    });
  if (author)
    activeFilters.push({
      key: "author",
      text: `author: ${authorName(author)}`,
      label: `remove author filter ${authorName(author)}`,
      clear: { author: "" },
    });
  if (tag) activeFilters.push({ key: "tag", text: `tag: ${tag}`, label: `remove tag filter ${tag}`, clear: { tag: "" } });
  if (status)
    activeFilters.push({
      key: "status",
      text: `status: ${describeStatusFilter(status)}`,
      label: `remove status filter ${describeStatusFilter(status)}`,
      clear: { status: "" },
    });
  if (kind) activeFilters.push({ key: "kind", text: `kind: ${kind}`, label: `remove kind filter ${kind}`, clear: { kind: "" } });
  if (applies)
    activeFilters.push({
      key: "applies",
      text: `applies to: ${applies.split(",").join(", ")}`,
      label: `remove applies to filter ${applies}`,
      clear: { applies: "" },
    });
  if (repo)
    activeFilters.push({ key: "repo", text: `repo: ${repo}`, label: `remove repo filter ${repo}`, clear: { repo: "" } });

  const projectDescription = "The repo, client or product a memory is about. Company-wide memories have none.";
  const filterFields: FilterField[] = [
    {
      name: "project",
      id: "memory-filter-project",
      label: "Project",
      description: projectDescription,
      options: [
        { value: "", label: "All projects" },
        { value: GENERAL_PROJECT_KEY, label: `General (${generalCount})` },
        ...projects.map((p) => ({ value: p.project, label: `${p.project} (${p.n})` })),
        ...(project && project !== GENERAL_PROJECT_KEY && !projects.some((p) => p.project === project)
          ? [{ value: project, label: project }]
          : []),
      ],
    },
    ...(authors.length > 0
      ? [
          {
            name: "author" as const,
            id: "memory-filter-author",
            label: "Author",
            options: [
              { value: "", label: "All authors" },
              ...authorChoices,
              ...(author && !authors.some((a) => a.authorId === author) ? [{ value: author, label: authorName(author) }] : []),
            ],
          },
        ]
      : []),
    {
      name: "status",
      id: "memory-filter-status",
      label: "Status",
      options: [
        { value: "", label: "Active" },
        { value: "all", label: "Include archived" },
        { value: "archived", label: "Archived only" },
      ],
    },
    {
      name: "kind",
      id: "memory-filter-kind",
      label: "Kind",
      description:
        "Learnings are gotchas and facts. Practices say what to do, standards what you must do, decisions record what was chosen and why.",
      options: [
        { value: "", label: "All kinds" },
        // A comma list (?kind=standard,decision from a link) has no single option; without
        // this the select would show "All kinds" while the filter is still on.
        ...(kind.includes(",") ? [{ value: kind, label: `Custom: ${kind.split(",").join(", ")}` }] : []),
        ...LEARNING_KINDS.map((k) => ({ value: k, label: k.charAt(0).toUpperCase() + k.slice(1) })),
      ],
    },
    {
      name: "applies",
      id: "memory-filter-applies",
      label: "Applies to",
      description: "The stack or platform a memory holds for. Everywhere means it holds for any stack.",
      options: [
        { value: "", label: "Any" },
        ...(applies.includes(",") ? [{ value: applies, label: `Custom: ${applies.split(",").join(", ")}` }] : []),
        { value: EVERYWHERE, label: "Everywhere" },
        { group: "Stack", options: STACK_LABELS.map((l) => ({ value: l, label: l })) },
        { group: "Platform", options: platformLabels().map((l) => ({ value: l, label: l })) },
      ],
    },
    {
      name: "sort",
      id: "memory-filter-sort",
      label: "Sort",
      description: "Top ranks by colleagues' votes. Recently used means last read by an agent.",
      options: [
        // The default follows the search: relevance while searching, votes otherwise.
        { value: "", label: q ? "Best match" : "Top" },
        ...(q ? [{ value: "top", label: "Top" }] : []),
        { value: "newest", label: "Newest" },
        { value: "oldest", label: "Oldest" },
        { value: "updated", label: "Recently updated" },
        { value: "used", label: "Recently used" },
      ],
    },
  ];

  return (
    <Shell>
      <div className={styles.header}>
        <div>
          <h1 className={styles.h1}>Memory</h1>
          <p className={styles.subline}>
            {numbers.learnings} {numbers.learnings === 1 ? "memory" : "memories"} from {numbers.people}{" "}
            {numbers.people === 1 ? "colleague" : "colleagues"}. Agents read it before they guess.
          </p>
        </div>
        <LiveUpdates topics="learning,vote,kudos,flag" />
      </div>

      <FilterBar values={{ q, tag, repo, project, author, status, kind, applies, sort }} fields={filterFields} />

      {tags.length > 0 ? (
        <div className={styles.chips} aria-label="Filter by tag">
          <Link href={href({ tag: "" })} className={`${styles.chip} ${!tag ? styles.chipOn : ""}`}>
            All
          </Link>
          {tags.map((t) => (
            <Link key={t.tag} href={href({ tag: t.tag === tag ? "" : t.tag })} className={`${styles.chip} ${t.tag === tag ? styles.chipOn : ""}`}>
              <span className={styles.chipDot} style={{ background: TEAM_COLORS[t.tag] ?? "var(--steel)" }} aria-hidden="true" />
              {t.tag}
              <span className={styles.chipN}>{t.n}</span>
            </Link>
          ))}
        </div>
      ) : null}

      <p className={styles.resultsCount} role="status" aria-live="polite" aria-atomic="true">
        {total === 0
          ? "0 memories"
          : `Showing ${rangeStart}-${rangeEnd} of ${total} ${total === 1 ? "memory" : "memories"}`}
      </p>

      {activeFilters.length > 0 ? (
        <div className={styles.activeFilters} aria-label="Active filters">
          {activeFilters.map((f) => (
            <Link key={f.key} href={href(f.clear)} className={styles.pill} aria-label={f.label}>
              {f.text} <span aria-hidden="true">×</span>
            </Link>
          ))}
          {activeFilters.length > 1 ? (
            <Link href="/memory" className={styles.clearAll}>
              Clear all
            </Link>
          ) : null}
        </div>
      ) : null}

      {results.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{filtered ? "Nothing matches." : "The memory is empty."}</p>
          <p className={styles.emptyBody}>
            {filtered ? (
              <>
                {activeFilters.length > 0 ? `Filters: ${activeFilters.map((f) => f.text).join(", ")}. ` : null}
                Try fewer words, or <Link href="/memory">clear the filters</Link>.
              </>
            ) : (
              <>
                Agents add the first entry. <Link href="/#get-started">Install the skill</Link> and ask yours to save something.
              </>
            )}
          </p>
        </div>
      ) : (
        <ol className={styles.list}>
          {results.map((l, i) => {
            const state = l.status === "archived" ? "archived" : expiryState(l);
            const tagList: string[] = JSON.parse(l.tags || "[]");
            const votes = voteCounts(l.id);
            const rowAuthor = l.authorName ?? l.author_id;
            return (
              <li key={l.id} className={styles.row} style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}>
                {/* The row card is a plain div, not a link: the title carries the one real
                    anchor, stretched over the whole card with .title::after (see the CSS
                    module) so the whole row stays clickable without nesting an <a> inside
                    an <a>. That leaves the project chip below free to be its own real,
                    independently-clickable link (raised above the stretched overlay via
                    z-index) instead of a dead span like the tags. */}
                <div className={styles.rowLink}>
                  <span className={styles.accent} style={{ background: teamAccent(tagList) }} aria-hidden="true" />
                  <div className={styles.rowMain}>
                    <div className={styles.rowTop}>
                      <Link href={`/memory/${l.id}`} className={styles.title}>
                        {l.title}
                      </Link>
                      {state !== "active" ? <span className={`${styles.badge} ${badgeClass(state)}`}>{state}</span> : null}
                      {l.kind !== "learning" ? <span className={styles.kindBadge}>{l.kind}</span> : null}
                      {l.source === "confluence" ? <span className={styles.sourceChip}>Confluence</span> : null}
                    </div>
                    <p className={styles.snippet} dangerouslySetInnerHTML={{ __html: l.snippet }} />
                    <div className={styles.meta}>
                      <Avatar name={rowAuthor} size={20} />
                      <span className={styles.author}>{rowAuthor}</span>
                      <span className={styles.dot}>·</span>
                      <span>{`Saved ${formatAge(l.ageDays)}${formatExpiry(l.expiresInDays) ? ` · ${formatExpiry(l.expiresInDays)}` : ""}`}</span>
                      {l.project ? (
                        <>
                          <span className={styles.dot}>·</span>
                          <Link href={href({ project: l.project })} className={styles.project}>
                            {l.project}
                          </Link>
                        </>
                      ) : null}
                      {l.repo ? (
                        <>
                          <span className={styles.dot}>·</span>
                          <span className={styles.repo}>{l.repo}</span>
                        </>
                      ) : null}
                      <span className={styles.tags}>
                        {tagList.map((t) => (
                          <span key={t} className={styles.tag}>
                            {t}
                          </span>
                        ))}
                        {l.appliesTo.map((a) => (
                          <span key={`applies-${a}`} className={styles.appliesChip} title={`Applies to ${a}`}>
                            {a}
                          </span>
                        ))}
                      </span>
                    </div>
                  </div>
                  <div className={styles.signals} aria-label="Signals">
                    {votes.helpful > 0 ? (
                      <span className={styles.signal} title={`${votes.helpful} found this helpful`}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3 7.5h2.5V14H3zM6.5 14V7.2l2.6-5.4a1.6 1.6 0 0 1 1.5 1.6V6h2.5a1.4 1.4 0 0 1 1.4 1.7l-1 5.1a1.6 1.6 0 0 1-1.6 1.2z" />
                        </svg>
                        {votes.helpful}
                      </span>
                    ) : null}
                    {votes.kudos > 0 ? (
                      <span className={`${styles.signal} ${styles.signalKudos}`} title={`${votes.kudos} kudos`}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M8 1.5l1.9 4 4.4.5-3.3 3 .9 4.4L8 11.2 4.1 13.4l.9-4.4-3.3-3 4.4-.5z" />
                        </svg>
                        {votes.kudos}
                      </span>
                    ) : null}
                    {/* title is plain text (React escapes it): counts and dates only, no note text. */}
                    <span className={`${styles.standing} ${styles[`standing_${l.standing}`]}`} title={standingText(l.standing, l.standingReason)}>
                      {standingText(l.standing)}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {hasPrev || hasNext ? (
        <nav className={styles.pagination} aria-label="Pagination">
          {hasPrev ? (
            <Link href={pageHref(page - 1)} className={styles.pageLink}>
              Previous
            </Link>
          ) : (
            <span className={styles.pageDisabled} aria-disabled="true">
              Previous
            </span>
          )}
          <span>{`Page ${page}`}</span>
          {hasNext ? (
            <Link href={pageHref(page + 1)} className={styles.pageLink}>
              Next
            </Link>
          ) : (
            <span className={styles.pageDisabled} aria-disabled="true">
              Next
            </span>
          )}
        </nav>
      ) : null}
    </Shell>
  );
}

export const dynamic = "force-dynamic";
