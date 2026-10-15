import { getDb } from "./db";
import { pageConnected } from "./page-presence";
import { formatRelativeTime } from "./relative-time";
import type { UserRow } from "./types";

/**
 * What BAB can honestly say about whether a message can be seen right now. Messaging is async
 * and inbox driven, so there is one signal: the recipient's Inbox page holds a live stream
 * (lib/page-presence.ts). It never says a person read it; "read" comes from read_at on the
 * message.
 *
 * The open page says when a person is at their desk, so it is revealed only to a sender the
 * recipient has already written to (recipientHasWrittenTo). To anyone else `page` stays "none",
 * which here means "not known to be open", and the note never says the page is closed.
 */

export interface Delivery {
  page: "connected" | "none";
  /** One plain sentence for the sender (and the sender's agent) to relay. */
  note: string;
}

/** True when the recipient has sent at least one message to this sender, in any thread. */
function recipientHasWrittenTo(recipientId: string, senderId: string): boolean {
  const row = getDb().prepare("SELECT 1 AS n FROM messages WHERE from_id = ? AND to_id = ? LIMIT 1").get(recipientId, senderId);
  return row !== undefined;
}

export function deliveryFor(recipient: Pick<UserRow, "id"> | undefined, senderId: string): Delivery {
  const page =
    recipient && pageConnected(recipient.id) && recipientHasWrittenTo(recipient.id, senderId) ? "connected" : "none";

  const note =
    page === "connected"
      ? "Sent to their BAB inbox. Their Inbox page is open, so they can see it now."
      : "Sent to their BAB inbox. Messages are async: they see it the next time they use Claude, or within seconds if Claude is already open.";
  return { page, note };
}

/** The sender's view of their last message in an Inbox thread: read or not, then whether their Inbox is open. */
export function outgoingStatus(input: { toName: string; readAt: string | null; page: Delivery["page"] }): string {
  const first = input.readAt
    ? `${input.toName} read your last message ${formatRelativeTime(input.readAt)}.`
    : `${input.toName} has not read your last message yet.`;
  return input.page === "connected" ? `${first} Their Inbox is open.` : first;
}
