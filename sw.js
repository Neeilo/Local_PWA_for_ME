/* Neil OS Service Worker v22 — HTML network-first，其餘資產 cache-first */
const CACHE = 'neil-os-v22';
const ASSETS = ['./', './index.html', './manifest.json', './neilos-icon.svg', './neilos-icon-192.png', './neilos-icon-512.png', './neilos-icon-ios-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const isHTML = req.mode === 'navigate' || req.url.endsWith('/') || req.url.endsWith('index.html');
  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then(res => { caches.open(CACHE).then(c => c.put(req, res.clone())); return res; })
        .catch(() => caches.match(req))
    );
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
