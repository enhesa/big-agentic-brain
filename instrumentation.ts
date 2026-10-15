/**
 * Next.js instrumentation hook: runs once when the server process starts.
 *
 * SIGTERM is what Kubernetes sends on every release. Next's own handler closes the HTTP
 * server and waits for in-flight requests; without help that wait is as long as the
 * longest inbox long-poll (25s), and the new pod cannot start until this one is gone
 * (see lib/shutdown.ts). So: wake every waiter immediately, give the server a moment to
 * flush the now-finished responses, then exit. Two seconds is a ceiling, not a target;
 * in practice the process is gone well under one.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  let beginShutdown: () => void;
  let closeDb: () => void;
  try {
    ({ beginShutdown } = await import("./lib/shutdown"));
    ({ closeDb } = await import("./lib/db"));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  // After the drain: flush the WAL so the volume holds one clean file. A close error must never block exit.
  const closeQuietly = () => {
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
