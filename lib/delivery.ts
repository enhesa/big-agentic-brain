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

/** True when the recipient has sent at least one message to this sender, in any thread, a group one included. */
function recipientHasWrittenTo(recipientId: string, senderId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 AS n FROM message_recipients r JOIN messages m ON m.id = r.message_id
       WHERE r.user_id = ? AND m.from_id = ? LIMIT 1`,
    )
    .get(senderId, recipientId);
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

/**
 * One delivery for a group send, from each recipient's. `page` is "connected" when at least one
 * recipient's page counts as open under the same rule as deliveryFor (each person's own entry
 * says which); the note never names anyone.
 */
export function groupDelivery(each: Delivery[]): Delivery {
  const page = each.some((d) => d.page === "connected") ? "connected" : "none";
  const note =
    page === "connected"
      ? "Sent to their BAB inboxes. At least one of them has their Inbox page open, so they can see it now."
      : "Sent to their BAB inboxes. Messages are async: each of them sees it the next time they use Claude, or within seconds if Claude is already open.";
  return { page, note };
}

/**
 * The sender's view of their last group message in an Inbox thread: who read it, then whether any
 * recipient's Inbox is open. Names are the readers' own; nothing is said about who has not read.
 */
export function groupOutgoingStatus(input: { readers: string[]; total: number; page: Delivery["page"] }): string {
  const n = input.readers.length;
  const first =
    n === 0
      ? `None of the ${input.total} recipients has read your last message yet.`
      : n === input.total
        ? `All ${input.total} recipients read your last message.`
        : `${input.readers.join(", ")} read your last message; ${input.total - n} of ${input.total} have not yet.`;
  return input.page === "connected" ? `${first} At least one of their Inboxes is open.` : first;
}

/** The sender's view of their last message in an Inbox thread: read or not, then whether their Inbox is open. */
export function outgoingStatus(input: { toName: string; readAt: string | null; page: Delivery["page"] }): string {
  const first = input.readAt
    ? `${input.toName} read your last message ${formatRelativeTime(input.readAt)}.`
    : `${input.toName} has not read your last message yet.`;
  return input.page === "connected" ? `${first} Their Inbox is open.` : first;
}
