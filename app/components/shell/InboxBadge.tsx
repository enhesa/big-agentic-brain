import { badgeLabel } from "@/lib/inbox-live-state";
import styles from "./InboxBadge.module.css";

/** The unread count next to the Inbox link in the top bars. Nothing at zero; a count only, never message text. */
export default function InboxBadge({ count }: { count: number }) {
  const label = badgeLabel(count);
  if (!label) return null;
  return (
    <span className={styles.badge} aria-label={`${count} unread`}>
      {label}
    </span>
  );
}
