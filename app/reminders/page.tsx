import Shell from "@/app/components/shell/Shell";
import { getSessionUser, pendingForgeLinkUser } from "@/lib/session";
import ReminderBody from "./ReminderBody";
import { auditRequest } from "@/lib/request-audit";
import {
  ownerIdFor,
  remindersFor,
  formatDueDate,
  dueState,
  type DueState,
  type ReminderGroups,
} from "@/lib/reminders-view";
import { formatRelativeTime } from "@/lib/relative-time";
import { toCalendarDate } from "@/lib/dates";
import type { TodoRow } from "@/lib/types";
import styles from "./reminders.module.css";

/**
 * Read-only. Reminders are private to their owner (see lib/todos.ts), so unlike
 * /memory or /usage this page needs a real, resolved identity before it can show
 * anything — see lib/reminders-view.ts's ownerIdFor() for how a SessionUser maps
 * to a todos.owner_id. With no such identity, the page shows one line and nothing
 * else: never a guess, never someone else's list. (owner, 2026-09-25)
 *
 * A viewer with an identity sees the list and nothing about browsers or devices: devices
 * handle identity now, and linking, unlinking and the device list live on /me/devices
 * (owner, 2026-10-01). A trusted Forge viewer who is signed in but not yet linked
 * (production's short alias email, no forge_links row) is a real person with no reminders
 * identity yet, not an absent one — that viewer is pointed at /me/devices to confirm who
 * they are, alongside the privacy line (see lib/session.ts's pendingForgeLinkUser()). The
 * one-click "Yes, that's me" is on /me/devices, not here.
 */
export default async function RemindersPage() {
  const actor = await getSessionUser();
  await auditRequest({ actor, method: "GET", path: "/reminders", via: "ui" });

  const ownerId = ownerIdFor(actor);
  const forge = ownerId ? null : await pendingForgeLinkUser();

  return (
    <Shell>
      <h1 className={styles.h1}>Reminders</h1>
      {ownerId ? (
        <RemindersList groups={remindersFor(ownerId)} />
      ) : (
        <div className={`card ${styles.privacy}`}>
          {forge ? (
            <p>
              Confirm who you are on <a href="/me/devices">/me/devices</a> to see your reminders here.
            </p>
          ) : null}
          <p>
            Reminders are private to their owner. Ask your agent to list yours with bab_remind.
          </p>
        </div>
      )}
    </Shell>
  );
}

function RemindersList({ groups }: { groups: ReminderGroups }) {
  const { overdue, dueSoon, later, done } = groups;
  const total = overdue.length + dueSoon.length + later.length + done.length;

  if (total === 0) {
    return (
      <div className={`card ${styles.empty}`}>
        <p className={styles.emptyTitle}>No reminders yet</p>
        <p>
          Ask your agent: <em>remind me on Friday to renew the VPN certificate</em>. It shows up here, and your
          agent brings it up when it is due.
        </p>
      </div>
    );
  }

  return (
    <>
      <ReminderGroup label="Overdue" group="overdue" items={overdue} />
      <ReminderGroup label="Due soon" group="dueSoon" items={dueSoon} />
      <ReminderGroup label="Later" group="later" items={later} />
      <ReminderGroup label="Done" group="done" items={done} collapsed />
    </>
  );
}

function ReminderGroup({
  label,
  group,
  items,
  collapsed = false,
}: {
  label: string;
  group: keyof ReminderGroups;
  items: TodoRow[];
  collapsed?: boolean;
}) {
  if (items.length === 0) return null;

  // A template string keeps this one text node; JSX would split it with comment markers.
  const heading = `${label} · ${items.length}`;
  const list = (
    <ul className={styles.list}>
      {items.map((t) => (
        <ReminderCard key={t.id} t={t} group={group} />
      ))}
    </ul>
  );

  if (collapsed) {
    // Native disclosure: no JS, and the heading stays a real h2 for screen readers.
    return (
      <details className={styles.group}>
        <summary className={styles.summary}>
          <h2 className={styles.groupTitle}>{heading}</h2>
        </summary>
        {list}
      </details>
    );
  }

  return (
    <section className={styles.group}>
      <h2 className={`${styles.groupTitle} ${group === "overdue" ? styles.groupTitleOverdue : ""}`}>{heading}</h2>
      {list}
    </section>
  );
}

const CHIP_CLASS: Record<DueState, string> = {
  overdue: styles.chipOverdue,
  today: styles.chipToday,
  soon: styles.chipSoon,
  later: styles.chipLater,
  done: styles.chipDone,
};

function ReminderCard({ t, group }: { t: TodoRow; group: keyof ReminderGroups }) {
  const state = dueState(group, t.due_at);
  const chipText = state === "done" ? "Done" : (formatDueDate(t.due_at) ?? "No due date");
  const updated = t.updated_at !== t.created_at;

  return (
    <li className={`card ${styles.card} ${state === "done" ? styles.done : ""}`}>
      <h3 className={styles.title}>{t.title}</h3>
      <div className={styles.meta}>
        <span className={`${styles.chip} ${CHIP_CLASS[state]}`} data-state={state}>
          {chipText}
        </span>
        {t.due_at && state !== "done" ? <time dateTime={toCalendarDate(t.due_at)}>{toCalendarDate(t.due_at)}</time> : null}
        <span>Created {formatRelativeTime(t.created_at)}</span>
        {state === "done" ? (
          <span>Completed {formatRelativeTime(t.updated_at)}</span>
        ) : updated ? (
          <span>Updated {formatRelativeTime(t.updated_at)}</span>
        ) : null}
      </div>
      {t.body ? <ReminderBody text={t.body} /> : null}
    </li>
  );
}

export const dynamic = "force-dynamic";
