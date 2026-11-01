/* StreamPulse PWA Service Worker — Static shell only, NEVER intercepts /api/iptv streams */
const CACHE_NAME = 'streampulse-shell-v2';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/streampulse/streampulse.css',
  '/streampulse/streampulse.js',
  '/app.js',
  '/manifest.webmanifest',
  '/assets/pwa-icon-192.png',
  '/assets/pwa-icon-512.png',
  '/assets/standby-backdrop.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && SHELL_ASSETS.includes(url.pathname)) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
