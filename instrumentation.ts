/**
 * Next.js instrumentation hook: runs once when the server process starts.
 * The Node-only work lives in instrumentation-node.ts and is imported only under the
 * Node.js runtime, so the Edge bundle never sees process.exit or process.once.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
