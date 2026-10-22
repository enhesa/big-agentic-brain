import { listMine } from "./todos";
import { isValidIdentityEmail } from "./identity";
import { todayUtc, toCalendarDate } from "./dates";
import type { TodoRow } from "./types";
import type { SessionUser } from "./session";

/**
 * Maps a resolved session identity to the todos.owner_id it is allowed to see.
 *
 * owner_id is always the long-form email: every reminder is created through
 * bab_remind, which authenticates the caller via X-Bab-Actor-* headers (see
 * lib/session.ts's fromAgentHeaders/toSessionUser), so `owner_id` is that
 * declared email, never a proxy id.
 *
 * A "declared" or "device" SessionUser already has this: its `id` IS the validated email.
 * A "proxy" SessionUser is keyed on its long-form email too (lib/session.ts
 * fromProxy), but its `email` is re-checked here anyway so this page never depends
 * on that staying true.
 * Anything that doesn't resolve to a confident long-form address returns
 * null, never a guess.
 */
export function ownerIdFor(actor: Pick<SessionUser, "id" | "email" | "source"> | null): string | null {
  if (!actor) return null;
  // A device user is an agent like a declared one: its id is the validated long-form email
  // (lib/devices.ts binds devices to it). Neither is ever a browser viewer, see getViewer.
  if (actor.source === "declared" || actor.source === "device" || actor.source === "connection") return actor.id;

  const email = actor.email?.trim().toLowerCase() ?? "";
  return isValidIdentityEmail(email) ? email : null;
}

export interface ReminderGroups {
  overdue: TodoRow[];
  dueSoon: TodoRow[];
  later: TodoRow[];
  done: TodoRow[];
}

/** Cap on how many recently-done reminders the page shows; it's a glance-back, not an archive. */
const DONE_LIMIT = 20;

/**
 * The owner's reminders, split the same way the CLI/API already reason about
 * them (lib/todos.ts's TodoFilter: overdue / due_soon / open), plus a short
 * recently-done tail. Read-only: three extra listMine() calls reusing its own
 * due-date logic rather than re-deriving it here.
 */
export function remindersFor(ownerId: string): ReminderGroups {
  const overdue = listMine(ownerId, "overdue");
  const dueSoon = listMine(ownerId, "due_soon");
  const open = listMine(ownerId, "open");

  const overdueIds = new Set(overdue.map((t) => t.id));
  const dueSoonIds = new Set(dueSoon.map((t) => t.id));
  const later = open.filter((t) => !overdueIds.has(t.id) && !dueSoonIds.has(t.id));

  const done = listMine(ownerId, "done").slice(0, DONE_LIMIT);

  return { overdue, dueSoon, later, done };
}

/**
 * Plain-language phrase for a reminder's due_at ("today", "tomorrow", "in 5 days",
 * "3 days overdue"), or null when there's no due date to show. `today` is injectable
 * for deterministic tests, same pattern as lib/relative-time.ts's `now` parameter. For a timed
 * reminder (`hasTime`) the day is the UTC day of its instant, and it reads "overdue" once the
 * instant has passed.
 */
export function formatDueDate(
  dueAt: string | null,
  today: string = todayUtc(),
  hasTime = false,
  nowMs: number = Date.now(),
): string | null {
  if (!dueAt) return null;
  const due = toCalendarDate(dueAt);
  const diffDays = Math.round(
    (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );

  // A timed reminder whose instant has passed is overdue, even on its own day.
  if (hasTime && Date.parse(dueAt) <= nowMs && diffDays >= 0) return "overdue";
  if (diffDays === 0) return "due today";
  if (diffDays === 1) return "due tomorrow";
  if (diffDays > 1) return `due in ${diffDays} days`;
  if (diffDays === -1) return "1 day overdue";
  return `${-diffDays} days overdue`;
}

export type DueState = "overdue" | "today" | "soon" | "later" | "done";

/**
 * Drives the due chip's colour. `soon` versus `later` is decided by the group the
 * reminder was listed in (lib/todos.ts owns the due-soon window), so the chip can
 * never disagree with the heading above it.
 */
export function dueState(
  group: keyof ReminderGroups,
  dueAt: string | null,
  today: string = todayUtc(),
): DueState {
  if (group === "done") return "done";
  if (group === "overdue") return "overdue";
  if (dueAt && toCalendarDate(dueAt) === today) return "today";
  return group === "dueSoon" ? "soon" : "later";
}
