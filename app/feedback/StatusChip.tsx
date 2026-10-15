import styles from "./feedback.module.css";

const VARIANT: Record<string, string> = {
  open: styles.chipOpen,
  planned: styles.chipPlanned,
  done: styles.chipDone,
  wontfix: styles.chipWontfix,
  duplicate: styles.chipDuplicate,
};

/** The coloured status pill shared by the list and the detail page. */
export default function StatusChip({ status }: { status: string }) {
  return <span className={`${styles.chip} ${VARIANT[status] ?? ""}`}>{status}</span>;
}
