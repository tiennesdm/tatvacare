// TatvaCare PWA Service Worker — offline shell + network-first strategy.
const CACHE = 'tatvacare-patient-v1';
const ASSETS = [
  '/patient',
  '/static/style.css',
  '/static/app.js',
  '/static/icon-192.png',
  '/static/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
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
  // API: network first, fall back to cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }
  // Static: cache first
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((r) => {
        if (r.status === 200 && (url.pathname.endsWith('.css') || url.pathname.endsWith('.js') || url.pathname.endsWith('.png') || url.pathname.endsWith('.html'))) {
          const c = r.clone();
          caches.open(CACHE).then((cache) => cache.put(req, c));
        }
        return r;
      }).catch(() => caches.match('/patient'));
    })
  );
});
