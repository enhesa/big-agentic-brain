import type { Metadata } from "next";
import { branding } from "@/lib/branding";
import { headers } from "next/headers";
import Link from "next/link";
import Shell from "@/app/components/shell/Shell";
import Avatar from "@/app/components/shell/Avatar";
import ThreadTimeline from "@/app/conversations/ThreadTimeline";
import { auditRequest } from "@/lib/request-audit";
import { getViewer, type Viewer } from "@/lib/notify-auth";
import { pendingForgeLinkUser } from "@/lib/session";
import { buildHandoffLinks } from "@/lib/handoff";
import { publicOrigin } from "@/lib/origin";
import { formatRelativeTime } from "@/lib/relative-time";
import { inboxTitle } from "@/lib/inbox-live-state";
import { unreadCountFor } from "@/lib/messages";
import { deliveryFor, outgoingStatus } from "@/lib/delivery";
import { getUser } from "@/lib/users";
import { inboxEnabled, inboxSummary, threadForParticipant, type InboxListItem } from "@/lib/inbox-page";
import HandoffButtons from "./HandoffButtons";
import InboxLive from "./InboxLive";
import styles from "./inbox.module.css";

/**
 * "(2) Inbox" in the tab title, from the count alone. InboxLive keeps it current between
 * refreshes; setting it here too means a reload or a refresh never shows a stale one.
 */
export async function generateMetadata(): Promise<Metadata> {
  const viewer = inboxEnabled() ? await getViewer() : null;
  return { title: inboxTitle(viewer ? unreadCountFor(viewer.ownerId) : 0) };
}

/**
 * The signed-in viewer's own threads, with unread counts (docs/spec.md "Inbox page").
 *
 * SSO viewer only: getViewer refuses agent headers, devices and connections, so this page
 * can never be driven by anyone typing a header, and one person never sees another's
 * threads (the selected thread goes through threadForParticipant, a participant check).
 * Message text, subjects and names are rendered as React text, nothing else. Opening a thread
 * marks nothing read: that is the explicit "Mark as read" button or the agent opening it.
 *
 * `?thread=<id>&open=app` also opens the Claude app once (/handoff/<id> redirects
 * here). Only the exact value `app` counts, and the flag only reaches the buttons after
 * threadForParticipant passed, so a non-participant, a bad id and the plain list never trigger it.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string | string[]; open?: string | string[] }>;
}) {
  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: "/inbox", via: "ui" });

  if (!inboxEnabled()) {
    return (
      <Shell>
        <h1 className={styles.h1}>Inbox</h1>
        <div className={`card ${styles.notice}`}>
          <p>The Inbox page is switched off right now. Your agent still gets your messages.</p>
        </div>
      </Shell>
    );
  }

  if (!viewer) return <SignedOut />;

  const { thread: threadParam, open } = await searchParams;
  const selectedId = Array.isArray(threadParam) ? threadParam[0] : threadParam;
  const summary = inboxSummary(viewer.ownerId);

  return (
    <Shell>
      {/* use-credentials: a manifest fetched without the SSO cookie gets the login page. React hoists this into <head>. */}
      <link rel="manifest" href="/inbox/manifest" crossOrigin="use-credentials" />
      <div className={styles.header}>
        <h1 className={styles.h1}>Inbox</h1>
        <p className={styles.subline}>
          {summary.unread > 0
            ? `${summary.unread} unread ${summary.unread === 1 ? "message" : "messages"}`
            : "Nothing unread"}
        </p>
        <InboxLive unread={summary.unread} accent={branding().accentColor} />
      </div>

      <div className={styles.layout}>
        <ThreadList threads={summary.threads} selectedId={selectedId} />
        <div className={styles.detail}>
          {selectedId !== undefined ? (
            <SelectedThread viewer={viewer} threadId={selectedId} autoOpenApp={open === "app"} />
          ) : (
            <p className={styles.placeholder}>
              {summary.threads.length > 0 ? "Pick a thread to read it." : "No messages yet. When a colleague's agent writes to you, it shows up here."}
            </p>
          )}
        </div>
      </div>
    </Shell>
  );
}

async function SignedOut() {
  // A signed-in proxy viewer with no identity yet (a short alias email, no link) is a real
  // person who needs /me/devices, unlike a visitor with no session or an agent header.
  const pending = await pendingForgeLinkUser();
  return (
    <Shell>
      <h1 className={styles.h1}>Inbox</h1>
      <div className={`card ${styles.notice}`}>
        {pending ? (
          <p>
            Confirm who you are on <a href="/me/devices">/me/devices</a> to see your inbox here.
          </p>
        ) : (
          <p>
            Sign in with your {branding().orgName} account in a browser to see your inbox. This page is for a signed-in browser; an
            agent reads its messages with bab_inbox.
          </p>
        )}
      </div>
    </Shell>
  );
}

function ThreadList({ threads, selectedId }: { threads: InboxListItem[]; selectedId: string | undefined }) {
  if (threads.length === 0) return <div className={styles.list} />;
  return (
    <ol className={styles.list} aria-label="Your threads">
      {threads.map((t) => (
        <li key={t.id}>
          <Link
            href={`/inbox?thread=${t.id}`}
            className={`${styles.row} ${t.id === selectedId ? styles.rowOn : ""} ${t.unread > 0 ? styles.rowUnread : ""}`}
            aria-current={t.id === selectedId ? "true" : undefined}
          >
            <Avatar name={t.otherName} size={30} />
            <span className={styles.rowMain}>
              <span className={styles.rowTop}>
                <span className={styles.rowTitle}>{t.subject}</span>
                <span className={styles.when}>{formatRelativeTime(t.lastAt)}</span>
              </span>
              <span className={styles.snippet}>
                <span className={styles.who}>{t.lastFromViewer ? `You to ${t.otherName}` : t.otherName}</span>
                {t.snippet ? ` · ${t.snippet}` : ""}
              </span>
            </span>
            {t.unread > 0 ? (
              <span className={styles.unread} aria-label={`${t.unread} unread`}>
                {t.unread}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ol>
  );
}

async function SelectedThread({ viewer, threadId, autoOpenApp }: { viewer: Viewer; threadId: string; autoOpenApp: boolean }) {
  const result = threadForParticipant(threadId, viewer.ownerId);
  // The same answer for "no such thread" and "not yours", so the page cannot be used to probe ids.
  if (!result) return <p className={styles.placeholder}>That thread was not found.</p>;
  const { thread, messages } = result;

  const unread = messages.filter((m) => m.to_id === viewer.ownerId && !m.read_at).length;
  const lastRequest = [...messages].reverse().find((m) => m.request)?.request ?? null;
  const links = buildHandoffLinks({ id: thread.id, repo: lastRequest?.repo ?? null }, publicOrigin(await headers()));

  const people = new Map<string, { name: string }>();
  for (const m of messages) {
    if (!people.has(m.from_id)) people.set(m.from_id, { name: m.fromName ?? m.from_id });
  }

  // Honest delivery for the sender: whether the last message they wrote here was read, and
  // whether their Inbox page is open right now.
  const outgoing = [...messages].reverse().find((m) => m.from_id === viewer.ownerId && m.to_id !== viewer.ownerId);
  let delivery: string | null = null;
  if (outgoing) {
    const live = deliveryFor(getUser(outgoing.to_id), viewer.ownerId);
    delivery = outgoingStatus({
      toName: outgoing.toName ?? outgoing.to_id,
      readAt: outgoing.read_at,
      page: live.page,
    });
  }

  return (
    <>
      <div className={styles.threadHeader}>
        <h2 className={styles.threadTitle}>{thread.subject || "(no subject)"}</h2>
        <div className={styles.people}>
          {[...people.values()].map((p, k) => (
            <span key={p.name} className={styles.person}>
              {k > 0 ? <span className={styles.arrow}>↔</span> : null}
              <Avatar name={p.name} size={22} />
              <span>{p.name}</span>
            </span>
          ))}
        </div>
        {unread > 0 ? (
          <form method="post" action="/inbox/read" className={styles.readForm}>
            <input type="hidden" name="threadId" value={thread.id} />
            <span className={styles.readText}>
              {unread} unread {unread === 1 ? "message" : "messages"} for you.
            </span>
            <button type="submit" className={styles.btn}>
              Mark as read
            </button>
          </form>
        ) : null}
        {delivery ? (
          <p className={styles.delivery} data-delivery>
            {delivery}
          </p>
        ) : null}
      </div>

      <HandoffButtons links={links} autoOpenApp={autoOpenApp} />
      <ThreadTimeline thread={thread} messages={messages} />
    </>
  );
}

export const dynamic = "force-dynamic";
