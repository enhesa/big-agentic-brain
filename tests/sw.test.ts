import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * public/sw.js is plain browser JS, so it runs here in a vm context with a fake service
 * worker global. It is a tombstone for the removed browser notifications: it must drop
 * any push subscription and unregister itself, and handle nothing else.
 */

const source = readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");

type Listener = (event: Record<string, unknown>) => void;

function boot(getSubscription: () => Promise<{ unsubscribe: () => Promise<boolean> } | null>) {
  const listeners: Record<string, Listener> = {};
  const unregister = vi.fn(async () => true);
  const self = {
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn;
    },
    registration: { pushManager: { getSubscription }, unregister },
    skipWaiting: vi.fn(),
  };
  vm.runInNewContext(source, { self, Promise });
  return { listeners, self, unregister };
}

async function activate(env: ReturnType<typeof boot>) {
  let pending: Promise<unknown> = Promise.resolve();
  env.listeners.activate({ waitUntil: (p: Promise<unknown>) => (pending = p) });
  await pending;
}

describe("sw.js tombstone", () => {
  it("listens for install and activate only", () => {
    const env = boot(async () => null);
    expect(Object.keys(env.listeners).sort()).toEqual(["activate", "install"]);
  });

  it("skips waiting on install", () => {
    const env = boot(async () => null);
    env.listeners.install({});
    expect(env.self.skipWaiting).toHaveBeenCalledOnce();
  });

  it("unsubscribes an existing push subscription, then unregisters", async () => {
    const unsubscribe = vi.fn(async () => true);
    const env = boot(async () => ({ unsubscribe }));
    await activate(env);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(env.unregister).toHaveBeenCalledOnce();
  });

  it("unregisters when there is no subscription", async () => {
    const env = boot(async () => null);
    await activate(env);
    expect(env.unregister).toHaveBeenCalledOnce();
  });

  it("still unregisters when reading or dropping the subscription throws", async () => {
    const env = boot(async () => {
      throw new Error("denied");
    });
    await activate(env);
    expect(env.unregister).toHaveBeenCalledOnce();
  });
});
