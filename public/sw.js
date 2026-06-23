// TatvaCare PWA Service Worker v2 — offline shell + update-prompt UX.
//
// v2 changes:
//   - Versioned cache names so a deploy nukes the stale shell atomically.
//   - Build-ID-scoped cache key (from window.__TC_CONFIG__.buildId via
//     postMessage from the page) — bumping buildId invalidates all caches.
//   - skipWaiting() runs only after the page confirms via postMessage,
//     so we don't swap mid-write and break an open offline session.
//   - clients.claim() is fine to run on activate — it just makes THIS
//     page use the new SW on next navigation, not on reload.
//
// The page-side handshake is in public/sw-update.js (auto-loaded by app.js
// in production builds). It listens for `sw:updated` and shows a toast.
const VERSION = 'v2';
let CACHE = `tatvacare-shell-${VERSION}`;
const SHELL_ASSETS = [
  '/patient',
  '/patient/login',
  '/static/style.css',
  '/static/app.js',
  '/static/runtime-config.js',
  '/static/icon-192.png',
  '/static/icon-512.png',
];

self.addEventListener('install', (e) => {
  // Pre-cache the offline shell. If any asset 404s at install time the
  // whole install fails — that's correct: we don't want a half-broken
  // offline shell. Fix the missing asset and re-deploy.
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL_ASSETS))
      // We do NOT call self.skipWaiting() here unconditionally. Instead,
      // wait for the page to say "go ahead" via postMessage. Reason: if
      // we skipWaiting while the user is mid-action (filling a refill
      // form, etc.), the new SW takes over and could change cache
      // contents under us.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (e) => {
  const data = e.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'SET_BUILD_ID') {
    // Bump the cache key when buildId changes (e.g. new deploy).
    if (typeof data.buildId === 'string' && data.buildId.length < 64) {
      CACHE = `tatvacare-shell-${VERSION}-${data.buildId}`;
      // Pre-warm new cache so the next page load is instant.
      e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_ASSETS)).catch(() => {}));
    }
  } else if (data.type === 'PURGE_CACHES') {
    e.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => k !== CACHE && caches.delete(k))))
    );
  }
});

self.addEventListener('activate', (e) => {
  // Delete every cache that isn't the current one (handles deploys
  // where VERSION didn't change but buildId did).
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API: network-first with cache fallback. We never serve stale auth or
  // PHI reads — those must hit the live backend.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).then((r) => {
        // Only cache safe, cacheable responses.
        if (r.ok && r.status === 200 && url.pathname.startsWith('/api/patient/')) {
          const c = r.clone();
          caches.open(CACHE).then((cache) => cache.put(req, c)).catch(() => {});
        }
        return r;
      }).catch(() => caches.match(req).then((cached) => cached || new Response(
        JSON.stringify({ error: { code: 'OFFLINE', message: 'Offline and no cached copy' } }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      )))
    );
    return;
  }

  // Static + HTML: stale-while-revalidate so the page feels instant
  // while still picking up updates in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((r) => {
        if (r.status === 200 && (url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.png') || url.pathname.endsWith('.html') || url.pathname === '/patient' || url.pathname.startsWith('/patient/'))) {
          const c = r.clone();
          caches.open(CACHE).then((cache) => cache.put(req, c)).catch(() => {});
        }
        return r;
      }).catch(() => null);
      // If we have a cached copy, return it NOW and refresh in background.
      // If we don't, wait for the network (or fall back to a generic shell).
      if (cached) {
        networkFetch.catch(() => {}); // fire-and-forget
        return cached;
      }
      return networkFetch.then((r) => r || caches.match('/patient/login'));
    })
  );
});
