import { config } from "./config";
import { getDb } from "./db";
import { inboxFor, thread, threadForViewer, type ViewerMessage } from "./messages";
import { getUsersByIds } from "./users";
import { THREAD_ID_RE } from "./handoff";
import type { BabEvent } from "./events";
import type { ThreadRow } from "./types";

/**
 * Data for the /inbox page and its routes. Everything here is scoped to one viewer id (the
 * long-form email of the signed-in SSO viewer, see getViewer in lib/notify-auth.ts): a thread
 * is only ever returned to someone who sent or received a message in it.
 */

/** Kill switch (docs/plans, Phase 2): BAB_INBOX_PAGE=0/false/no/off hides the nav item and switches the page and its routes off. Unset means on. */
export function inboxEnabled(): boolean {
  return config().inboxPage;
}

/** The list is a glance at recent threads, not an archive; the unread total is not capped. */
export const INBOX_LIST_MAX = 50;
const SNIPPET_MAX = 120;

export interface InboxListItem {
  id: string;
  subject: string;
  unread: number;
  lastAt: string;
  /** The other person in the thread, from the viewer's side: who they last wrote to or heard from. */
  otherName: string;
  lastFromViewer: boolean;
  snippet: string;
}

export interface InboxSummary {
  unread: number;
  threads: InboxListItem[];
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX) : flat;
}

export function inboxSummary(viewerId: string): InboxSummary {
  const all = inboxFor(viewerId);
  const unread = all.reduce((n, t) => n + t.unreadCount, 0);
  const shown = all.slice(0, INBOX_LIST_MAX);

  const otherIds = shown.map((t) => (t.lastMessage.from_id === viewerId ? t.lastMessage.to_id : t.lastMessage.from_id));
  const names = getUsersByIds(Array.from(new Set(otherIds)));

  return {
    unread,
    threads: shown.map((t, i) => ({
      id: t.thread.id,
      subject: t.thread.subject || "(no subject)",
      unread: t.unreadCount,
      lastAt: t.lastMessage.created_at,
      otherName: names.get(otherIds[i])?.name ?? otherIds[i],
      lastFromViewer: t.lastMessage.from_id === viewerId,
      snippet: oneLine(t.lastMessage.body),
    })),
  };
}

/**
 * The thread with names, for a participant only. threadForViewer has no such restriction
 * (/conversations is open to all staff by design), so the gate is thread(), which returns
 * undefined to a non-participant. A malformed id is undefined too: callers answer 404.
 */
export function threadForParticipant(
  threadId: string,
  viewerId: string,
): { thread: ThreadRow; messages: ViewerMessage[] } | undefined {
  if (!THREAD_ID_RE.test(threadId)) return undefined;
  if (!thread(threadId, viewerId)) return undefined;
  return threadForViewer(threadId);
}

export interface InboxLiveEvent {
  threadId: string;
  kind: "message" | "read";
}

/**
 * Whether a bus event is the viewer's business, and if so the only thing the stream may tell
 * them: the thread id and "message" or "read". The bus itself is public (/api/events), so
 * nothing about the message travels here, and a message between two colleagues produces no
 * event on anyone else's stream.
 *
 * A send carries the message id in `payload.id` (one lookup of its two ends); a read carries
 * the thread id there (see markRead), which needs a participant check.
 */
export function eventConcernsViewer(event: BabEvent, viewerId: string): InboxLiveEvent | null {
  if (event.type !== "message.created") return null;
  const id = event.payload.id;
  if (typeof id !== "string" || !id) return null;
  const db = getDb();

  if (event.payload.kind === "read") {
    const row = db
      .prepare("SELECT 1 AS n FROM messages WHERE thread_id = ? AND (from_id = ? OR to_id = ?) LIMIT 1")
      .get(id, viewerId, viewerId);
    return row ? { threadId: id, kind: "read" } : null;
  }

  const msg = db.prepare("SELECT thread_id, from_id, to_id FROM messages WHERE id = ?").get(id) as unknown as
    | { thread_id: string; from_id: string; to_id: string }
    | undefined;
  if (!msg || (msg.from_id !== viewerId && msg.to_id !== viewerId)) return null;
  return { threadId: msg.thread_id, kind: "message" };
}
