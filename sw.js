// Sarwa Chronic – keeps the app page available for start-up; all data always comes live from the cloud (never cached here).
// The page itself is always fetched fresh from the network (bypassing the browser cache), so a new version shows on the next open.
const CACHE = 'sarwa-chronic-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // cloud data / sign-in: never cached
  const fresh = e.request.mode === 'navigate' ? fetch(e.request.url, { cache: 'no-store' }) : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(fresh.then(r => { const copy = r.clone(); if (r.ok) caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(m => m || caches.match('./index.html'))));
});
