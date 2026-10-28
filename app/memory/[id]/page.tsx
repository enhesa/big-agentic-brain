import { parseDbTime, todayUtc } from "@/lib/dates";
import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/app/components/shell/Shell";
import LiveUpdates from "@/app/components/shell/LiveUpdates";
import Avatar from "@/app/components/shell/Avatar";
import { readAppliesTo } from "@/lib/applies-to";
import { CONFIDENCE_LABEL, STANDING_LABEL } from "@/lib/standing";
import { getSessionUser, pendingProxyLinkUser } from "@/lib/session";
import { getViewer } from "@/lib/notify-auth";
import { reactMessage } from "@/lib/memory-react-web";
import ReactionPanel from "./ReactionPanel";
import { auditRequest } from "@/lib/request-audit";
import {
  getById,
  expiryState,
  voteCounts,
  findSupersededBy,
  ageInfo,
  assertSourceUrl,
  standingsFor,
  recentNotes,
  lastRetire,
  readAliases,
  ownReactions,
} from "@/lib/learnings";
import { formatRelativeTime, formatAge, formatExpiry } from "@/lib/relative-time";
import { getDb } from "@/lib/db";
import { discoveryCostOf } from "@/lib/effort-cost";
import styles from "../memory.module.css";
import Markdown from "@/app/components/Markdown";
import { formatDate, DATE_TIME } from "@/lib/branding";

/**
 * Why the sweep archived a memory, when it did (the `auto-archive` or `downvote_archived` audit row,
 * lib/maintenance.ts). Only
 * when that row is the last thing that happened to it: a later archive by flags or a retire moves
 * updated_at past the row. The audit log is kept 180 days, so an old one says nothing.
 */
function autoArchiveReason(id: string, updatedAt: string): "inactive" | "valid-until" | "downvoted" | null {
  const row = getDb()
    .prepare(
      `SELECT CASE WHEN action = 'downvote_archived' THEN 'downvoted' ELSE json_extract(details, '$.reason') END AS reason, at
       FROM audit_log
       WHERE action IN ('auto-archive', 'downvote_archived') AND entity = 'learning' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(id) as { reason: string | null; at: string } | undefined;
  if (!row || row.at < updatedAt) return null;
  return row.reason === "inactive" || row.reason === "valid-until" || row.reason === "downvoted" ? row.reason : null;
}

function badgeClass(state: string) {
  if (state === "active") return styles.badgeActive;
  if (state === "archived") return styles.badgeArchived;
  return styles.badgeExpired;
}

function authorName(authorId: string): string {
  const db = getDb();
  const row = db.prepare("SELECT name FROM users WHERE id = ?").get(authorId) as { name: string | null } | undefined;
  return row?.name ?? authorId;
}

export default async function LearningDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ react?: string | string[] }>;
}) {
  const { id } = await params;
  const { react } = (await searchParams) ?? {};
  // Read-only page: no identity required, see app/memory/page.tsx.
  const actor = await getSessionUser();
  await auditRequest({ actor, method: "GET", path: `/memory/${id}`, via: "ui" });
  const learning = getById(id);
  if (!learning) notFound();

  const state = learning.status === "archived" ? "archived" : expiryState(learning);
  const archivedWhy = learning.status === "archived" ? autoArchiveReason(learning.id, learning.updated_at) : null;
  const tags: string[] = JSON.parse(learning.tags || "[]");
  const appliesTo = readAppliesTo(learning.applies_to);
  const aliases = readAliases(learning.aliases);
  const supersedes = learning.supersedes_id ? getById(learning.supersedes_id) : undefined;
  const supersededBy = findSupersededBy(learning.id);
  const votes = voteCounts(learning.id);
  const author = authorName(learning.author_id);
  const { ageDays, expiresInDays } = ageInfo(learning);
  const expiryText = formatExpiry(expiresInDays);
  // Re-checked here, not only in create(): a row written around create() (an import, a manual
  // fix) with a bad source_url must never become a link.
  let sourceHref: string | null = null;
  if (learning.source === "confluence") {
    try {
      sourceHref = assertSourceUrl(learning.source_url);
    } catch {
      sourceHref = null;
    }
  }

  const standing = standingsFor([learning]).get(learning.id)!;
  const notes = recentNotes(learning.id);
  const retireEvent = lastRetire(learning);

  // Reacting needs a person: a browser linked to a BAB identity (getViewer). A signed-in viewer
  // who is not linked yet is pointed at /me/devices; with no sign-in at all the panel says nothing.
  const viewer = learning.status === "deleted" ? null : await getViewer();
  const needsLink = !viewer && learning.status !== "deleted" && (await pendingProxyLinkUser()) !== null;
  const mine = viewer && viewer.ownerId !== learning.author_id ? ownReactions(learning.id, viewer.ownerId) : null;

  const facts: Array<[string, string]> = [
    [STANDING_LABEL, `${standing.standing} (${standing.standingReason})`],
    ["Helpful", String(votes.helpful)],
    ["Kudos", String(votes.kudos)],
    // Always shown, next to Helpful and Kudos: three not-helpful votes that outnumber the support
    // archive a learning or practice no agent read for 90 days (docs/spec.md "Swarm garbage
    // collection"), and two flags archive it.
    ["Not helpful", String(votes.not_helpful)],
    ["Flags", String(votes.flag)],
    ["Score", String(learning.score)],
    [CONFIDENCE_LABEL, learning.confidence],
  ];
  // Only a time-bound fact has a date of its own: memories do not expire by default.
  if (learning.expires_at) facts.push(["Valid until", learning.expires_at.slice(0, 10)]);
  // Agent reads only (lib/learnings.ts touchRead): a person opening this page is not counted.
  // last_accessed_at is the first read of the latest UTC day, so a relative time ("15 hr ago") would mislead.
  const lastRead = learning.last_accessed_at?.slice(0, 10);
  facts.push(["Last read by an agent", lastRead ? (lastRead === todayUtc() ? "today" : lastRead) : "not yet"]);
  facts.push(["Days read by agents", String(learning.access_days)]);
  if (votes.confirm > 0) facts.push(["Confirmations", String(votes.confirm)]);
  if (learning.repo) facts.push(["Repo", learning.repo]);
  // Self-declared by the author, shown as text only; it is not part of standing or confidence.
  if (learning.model) facts.push(["Written with", learning.model]);
  // Measured by the plugin when it was saved (lib/effort-cost.ts); numbers only, for /usage.
  const found = discoveryCostOf(learning.id);
  if (found) facts.push(["Agent effort to find", `${found.activeMs < 60_000 ? "under 1" : Math.round(found.activeMs / 60_000)} min, ${found.tokens.toLocaleString("en-GB")} tokens`]);

  return (
    <Shell>
      <div className={styles.detail}>
        <Link href="/memory" className={styles.back}>
          ← Memory
        </Link>

        {learning.status === "archived" ? (
          <div className={styles.banner}>
            {archivedWhy === "inactive"
              ? "This memory was archived automatically: no agent read it for a year. Any agent can restore it with keep."
              : archivedWhy === "valid-until"
                ? "This memory was archived automatically: its valid-until date passed."
                : archivedWhy === "downvoted"
                  ? "This memory was archived automatically: colleagues marked it not helpful and no agent read it for 90 days. Any agent can restore it with keep."
                  : "This memory is archived."}
          </div>
        ) : null}

        <div className={styles.detailTop}>
          <h1>{learning.title}</h1>
          <span className={`${styles.badge} ${badgeClass(state)}`}>{state}</span>
          {learning.kind !== "learning" ? <span className={styles.kindBadge}>{learning.kind}</span> : null}
          <LiveUpdates topics="learning,vote,kudos,flag" />
        </div>

        <div className={styles.byline}>
          <Avatar name={author} size={24} />
          <strong>{author}</strong>
          <span>·</span>
          <span title={formatDate(parseDbTime(learning.created_at), DATE_TIME)}>{`Saved ${formatAge(ageDays)}${expiryText ? ` · ${expiryText}` : ""}`}</span>
          {learning.updated_at !== learning.created_at ? <span>· updated {formatRelativeTime(learning.updated_at)}</span> : null}
          {learning.project ? (
            <>
              <span>·</span>
              <Link href={`/memory?project=${encodeURIComponent(learning.project)}`} className={styles.project}>
                {learning.project}
              </Link>
            </>
          ) : null}
          {tags.length ? (
            <span className={styles.tags}>
              {tags.map((t) => (
                <Link key={t} href={`/memory?tag=${encodeURIComponent(t)}`} className={styles.tag}>
                  {t}
                </Link>
              ))}
            </span>
          ) : null}
        </div>

        <p className={styles.appliesTo} aria-label="Applies to">
          <span className={styles.appliesToLabel}>Applies to:</span>
          {appliesTo.length > 0 ? (
            appliesTo.map((a) => (
              <Link key={a} href={`/memory?applies=${encodeURIComponent(a)}`} className={styles.appliesChip}>
                {a}
              </Link>
            ))
          ) : (
            <span className={styles.appliesEverywhere}>everywhere</span>
          )}
        </p>

        {aliases.length > 0 ? (
          <p className={styles.aliases}>Also searched as: {aliases.join(", ")}</p>
        ) : null}

        <Markdown source={learning.body} className={styles.body} />

        <ul className={styles.facts}>
          {facts.map(([k, v]) => (
            <li key={k} className={styles.fact}>
              <span className={styles.factK}>{k}</span>
              <span className={styles.factV}>{v}</span>
            </li>
          ))}
          {learning.source === "confluence" ? (
            <li className={styles.fact}>
              <span className={styles.factK}>Source</span>
              <span className={styles.factV}>
                {sourceHref ? (
                  <a href={sourceHref} rel="noopener noreferrer" target="_blank" className={styles.link}>
                    {learning.source_version == null ? "Confluence page" : `Confluence page, v${learning.source_version}`}
                  </a>
                ) : (
                  "Confluence page"
                )}
              </span>
            </li>
          ) : null}
        </ul>

        {viewer || needsLink ? (
          <ReactionPanel
            learningId={learning.id}
            state={!viewer ? "link" : mine ? "open" : "own"}
            mine={mine}
            message={reactMessage(Array.isArray(react) ? react[0] : react)}
          />
        ) : null}

        {notes.length > 0 || retireEvent ? (
          <section className={styles.notes} aria-label="Recent confirmations, flags and retirements">
            <h2>Recent confirmations, flags and retirements</h2>
            {/* JSX text only, never dangerouslySetInnerHTML: a note is written by any agent. */}
            {retireEvent ? (
              <p className={styles.retired}>
                <strong>{retireEvent.kind === "retire" ? "Retired" : "Restored"}</strong>
                {` by ${retireEvent.voterName}, ${formatRelativeTime(retireEvent.at)}${retireEvent.note ? `: ${retireEvent.note}` : ""}`}
              </p>
            ) : null}
            {notes.length > 0 ? (
              <ul>
                {notes.map((n, i) => (
                  <li key={`${n.kind}-${n.voterName}-${n.at}-${i}`}>
                    <strong>{n.kind}</strong> {n.voterName}, {formatRelativeTime(n.at)}
                    {n.note ? `: ${n.note}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {supersedes ? (
          <p className={styles.related}>
            Replaces{" "}
            <Link href={`/memory/${supersedes.id}`} className={styles.link}>
              {supersedes.title}
            </Link>
          </p>
        ) : null}
        {supersededBy ? (
          <p className={styles.related}>
            Replaced by{" "}
            <Link href={`/memory/${supersededBy.id}`} className={styles.link}>
              {supersededBy.title}
            </Link>
          </p>
        ) : null}

        <p className={styles.apiNote}>
          Agents fetch this as JSON: <code>GET /api/learnings/{learning.id}</code>
        </p>
      </div>
    </Shell>
  );
}

export const dynamic = "force-dynamic";
