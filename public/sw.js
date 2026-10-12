/*
 * Tombstone. Browser notifications were removed (owner, 2026-09-30), but browsers that
 * registered this file keep running the old worker until the file changes. This version
 * drops any push subscription and unregisters itself, and handles nothing else.
 * It can be deleted after a few weeks, once nobody is left with the old worker.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const subscription = await self.registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();
      } catch {
        // Nothing to drop, or the browser refused; unregistering still stops the worker.
      }
      await self.registration.unregister();
    })(),
  );
});
