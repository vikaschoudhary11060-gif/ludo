/* ============================================================
   Khelbro service worker

   Static shell is cache-first so the app opens instantly and
   still opens with no signal. API calls are network-first with
   no caching — balances and battles must never be stale.
   ============================================================ */
const VERSION = 'khelbro-3e269ba6d828';
const SHELL = [
  '/', '/index.html', '/battles.html', '/battle.html', '/wallet.html', '/profile.html',
  '/leaderboard.html', '/how-to-play.html', '/support.html', '/login.html', '/offline.html',
  '/assets/css/app.css',
  '/assets/js/i18n.js', '/assets/js/api.js', '/assets/js/app.js',
  '/assets/img/mark.svg', '/assets/img/favicon.svg',
  '/assets/img/board-lite.svg', '/assets/img/board-rich.svg',
  '/manifest.webmanifest',
];

/* Populate the cache straight from the network.

   cache.add() and a bare fetch() may both be answered by the browser's own
   HTTP cache, so a freshly-installed worker could copy the PREVIOUS build's
   files into its new cache — the version bump would change the cache name and
   still serve stale code. 'reload' forces the request past that cache. */
const fetchFresh = req => fetch(new Request(req, { cache: 'reload' }));

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      // Individual failures must not abort the whole install.
      .then(c => Promise.allSettled(SHELL.map(async u => {
        const res = await fetchFresh(u);
        if (res.ok) await c.put(u, res);
      })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache the API or socket traffic — stale money is worse than no money.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // The staleness check itself must never be answered from the cache.
  if (url.pathname === '/version.json') return;

  // Uploaded evidence: cache after first fetch, it never changes.
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.open(VERSION).then(c =>
        c.match(request).then(hit => hit || fetch(request).then(res => {
          if (res.ok) c.put(request, res.clone());
          return res;
        }).catch(() => hit)))
    );
    return;
  }

  // Navigations: try the network, fall back to cache, then to the offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetchFresh(request)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then(hit => hit || caches.match('/offline.html')))
    );
    return;
  }

  // Everything else (CSS, JS, images): cache-first, refresh in the background.
  event.respondWith(
    caches.match(request).then(hit => {
      // Revalidate from the network, not from the HTTP cache, or the refresh
      // can write the same stale copy straight back.
      const net = fetchFresh(request).then(res => {
        if (res.ok) caches.open(VERSION).then(c => c.put(request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

/* ---------- push ---------- */

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  const title = data.title || 'Khelbro';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/assets/img/icon-192.png',
    badge: '/assets/img/icon-192.png',
    tag: data.tag || 'khelbro',
    renotify: true,
    vibrate: [60, 40, 60],
    data: { url: data.url || '/notifications.html' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Reuse an open tab if there is one rather than piling up windows.
      for (const c of list) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
