/**
 * Node-only startup work, loaded from instrumentation.ts so the Edge bundle never sees
 * process.exit or process.once.
 *
 * SIGTERM is what Kubernetes sends on every release. Next's own handler closes the HTTP
 * server and waits for in-flight requests; without help that wait is as long as the
 * longest inbox long-poll (25s), and the new pod cannot start until this one is gone
 * (see lib/shutdown.ts). So: wake every waiter immediately, give the server a moment to
 * flush the now-finished responses, then exit. Two seconds is a ceiling, not a target;
 * in practice the process is gone well under one.
 */
export async function registerNode(): Promise<void> {
  let beginShutdown: () => void;
  let closeDb: () => void;
  let flushKvSnapshot: () => void;
  let flushCommandCenterSnapshot: () => void;
  try {
    ({ beginShutdown } = await import("./lib/shutdown"));
    ({ closeDb } = await import("./lib/db"));
    ({ flushKvSnapshot } = await import("./lib/kv"));
    ({ flushCommandCenterSnapshot } = await import("./lib/command-center"));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  // After the drain: write the key-value snapshot (lib/kv.ts) and flush the WAL so the volume holds
  // one clean file. Neither may block exit; the snapshot write never throws and is skipped when unchanged.
  // Command Center first: it saves only while this process holds the lease, which the key-value flush gives up.
  const closeQuietly = () => {
    flushCommandCenterSnapshot();
    flushKvSnapshot();
    try {
      closeDb();
    } catch {
      // ignore
    }
  };
  const onSignal = () => {
    beginShutdown();
    setTimeout(() => {
      closeQuietly();
      process.exit(0);
    }, 2000).unref();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  // Next's own SIGTERM handler may call process.exit() before that timer fires; the "exit"
  // event is the last chance to checkpoint the WAL, and closeDb is synchronous.
  process.once("exit", closeQuietly);
  try {
    const { logEffectiveConfig } = await import("./lib/config");
    logEffectiveConfig();
    const { logStartupSummary } = await import("./lib/db");
    logStartupSummary();
  } catch (err) {
    // A bad configuration must stop the process, not serve 500s.
    console.error(err);
    process.exit(1);
  }
}
