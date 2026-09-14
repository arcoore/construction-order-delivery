// Minimal PWA service worker: network-first for everything, falling back to
// a runtime cache only when the network is unavailable (offline). This is
// deliberately NOT a precaching / app-shell service worker - this project
// redeploys straight to public/ multiple times a day with no build-time
// versioning, so any strategy that could ever serve stale JS/CSS over a
// fresh network response was already flagged as a real risk (see
// CLAUDE.md/PROGRESS.md's perf-pass notes on why a service worker was
// deferred before) and is deliberately avoided here. Online users always
// get the live network response, unchanged; offline users get whatever
// they've already visited, so the app degrades to "last seen state"
// instead of a blank connection-error page. Nothing more than that.
const CACHE_NAME = 'sitestock-runtime-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only GET, same-origin requests - never intercept Supabase REST/Realtime
  // traffic, Cloudflare Turnstile/analytics, postcodes.io, or any POST/RPC
  // call. Those must always go straight to the network untouched.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req))
  );
});
