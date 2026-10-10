/* Service worker: the app is static with zero runtime dependencies, so caching
   the shell is enough for it to work fully offline -- including generation,
   which is all client-side.

   Navigation is network-first so a deployed update shows up on the next load,
   falling back to the cached shell when offline. Static assets are cache-first
   with a background refresh, which keeps the board instant.

   BECAUSE of that cache-first path, changing css/ or js/ without bumping CACHE
   means a returning visitor sees the previous build on their first load and
   the new one only on the second. Bump CACHE with every shell change.

   There is deliberately NO skipWaiting() here. A freshly installed worker parks
   in `waiting` and the page offers the update; the user's tap sends
   SKIP_WAITING and the worker takes over. Skipping straight through would swap
   the shell under a live game without anyone agreeing to it. */

const CACHE = 'sudoku-shell-v5';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/board.js',
  './js/solver.js',
  './js/generator.js',
  './js/canon.js',
  './js/store.js',
  './js/metrics.js',
  './js/prng.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
    // No skipWaiting(): stay `waiting` until the user asks for the update.
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  // Never touch cross-origin requests, and never try to cache token POSTs etc.
  if (url.origin !== self.location.origin) return;

  // Never intercept the worker script itself. It is not in SHELL, but this
  // handler caches whatever it fetches, and a cached sw.js would pin the old
  // worker and stop updates being detected at all.
  if (url.pathname.endsWith('/sw.js')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
