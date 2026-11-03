/* Versioned public assets only. No HTML, no API, no credentials, no video, no login.
 * A cached shell can never bypass server authentication or quota checks.
 */
const CACHE_NAME = 'onda-shell-__SHELL_VERSION__';
const SHELL_ASSETS = __SHELL_ASSETS__;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('onda-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.searchParams.has('v') || !SHELL_ASSETS.includes(url.pathname + url.search)) return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache => {
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  }));
});
