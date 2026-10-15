/**
 * Fast, clean shutdown. Measured on the 2026-09-18 release: the old pod took ~25s to
 * stop because long-lived requests kept the server's in-flight count above zero, and
 * Kubernetes only starts the NEW pod once the old one is gone (the disk is ReadWriteOnce,
 * so the chart uses `Recreate`). Every second here is a second of downtime for everyone.
 *
 * `beginShutdown()` flips a flag and wakes every registered waiter; an open Inbox stream
 * (app/inbox/events/route.ts) closes at once and the page reconnects to the new pod.
 * `instrumentation.ts` wires it to SIGTERM.
 */

let shuttingDown = false;
const wakers = new Set<() => void>();

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Register a callback to run the moment shutdown begins. Returns the unregister. */
export function onShutdown(wake: () => void): () => void {
  if (shuttingDown) {
    wake();
    return () => {};
  }
  wakers.add(wake);
  return () => {
    wakers.delete(wake);
  };
}

export function beginShutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const wake of [...wakers]) {
    wakers.delete(wake);
    try {
      wake();
    } catch {
      // a waiter that throws must not stop the others from waking
    }
  }
  // The database is NOT closed here: requests still in flight during the drain need it.
  // instrumentation.ts closes it right before process.exit.
}

/** Test hook. */
export function _resetShutdownForTests(): void {
  shuttingDown = false;
  wakers.clear();
}
