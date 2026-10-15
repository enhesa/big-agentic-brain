import { parseDbTime } from "@/lib/dates";
import ThreadTimeline from "../ThreadTimeline";
import Link from "next/link";
import { notFound } from "next/navigation";
import Shell from "@/app/components/shell/Shell";
import LiveUpdates from "@/app/components/shell/LiveUpdates";
import Avatar from "@/app/components/shell/Avatar";
import { auditRequest } from "@/lib/request-audit";
import { getViewer } from "@/lib/notify-auth";
import { ForbiddenError } from "@/lib/errors";
import { threadForViewer } from "@/lib/messages";
import { formatRelativeTime } from "@/lib/relative-time";
import styles from "../conversations.module.css";
import { formatDate, DATE_TIME } from "@/lib/branding";

/** One thread as a chat: the person who started it on the left, the other side on the
 *  right, consecutive messages from the same sender grouped under one name. */
export default async function ConversationDetailPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  // Participants and maintainers only. The same 404 for "no such thread", "not yours" and "not
  // signed in", so the page cannot be used to probe thread ids (as /inbox does).
  const viewer = await getViewer();
  await auditRequest({ actor: viewer?.actor ?? null, method: "GET", path: `/conversations/${threadId}`, via: "ui" });
  if (!viewer) notFound();

  let result: ReturnType<typeof threadForViewer>;
  try {
    result = threadForViewer(threadId, viewer.ownerId);
  } catch (err) {
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
  if (!result) notFound();
  const { thread, messages } = result;

  const people = new Map<string, { name: string }>();
  for (const m of messages) {
    if (!people.has(m.from_id)) people.set(m.from_id, { name: m.fromName ?? m.from_id });
  }

  return (
    <Shell>
      <div className={styles.detail}>
        <Link href="/conversations" className={styles.back}>
          ← Conversations
        </Link>

        <div className={styles.detailHeader}>
          <div className={styles.detailTitleRow}>
            <h1 className={styles.detailTitle}>{thread.subject || "(no subject)"}</h1>
            <LiveUpdates topics="message" />
          </div>
          <div className={styles.people}>
            {[...people.values()].map((p, k) => (
              <span key={p.name} className={styles.person}>
                {k > 0 ? <span className={styles.arrow}>↔</span> : null}
                <Avatar name={p.name} size={22} />
                <span>{p.name}</span>
              </span>
            ))}
            <span className={styles.started} title={formatDate(parseDbTime(thread.created_at), DATE_TIME)}>
              started {formatRelativeTime(thread.created_at)} · {messages.length} message{messages.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        <p>
          <Link href={`/inbox?thread=${encodeURIComponent(threadId)}`}>Continue in Claude</Link>
        </p>

        <ThreadTimeline thread={thread} messages={messages} />

        <p className={styles.apiNote}>
          Read-only. Agents reply with <code>POST /api/messages {"{ threadId }"}</code>
        </p>
      </div>
    </Shell>
  );
}

export const dynamic = "force-dynamic";
