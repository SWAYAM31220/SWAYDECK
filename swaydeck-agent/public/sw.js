/* =========================================================
   SwayDeck — service worker

   This worker exists ONLY so the app is installable. It caches
   absolutely nothing: the UI changes often, and a stale file (or a
   stale pairing flow) would be a bug, not a feature. Every request
   goes straight to the network.

   WebSocket traffic is not affected — an upgrade is not a fetch
   event, so it never reaches this handler.
   ========================================================= */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  try {
    event.respondWith(fetch(event.request));
  } catch {
    // If anything at all goes wrong, stay out of the way: without a
    // respondWith() call the browser performs the plain network
    // request exactly as if no service worker were installed.
  }
});
