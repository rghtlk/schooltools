// Keeps the app itself on the device, so it opens with no network at all.
// The data is not here: it lives in IndexedDB (js/db.js). /api is never cached.
//
// On the phone: the cached copy answers at once — never a wait for a network
// that may hang (a Wi-Fi where the Mac cannot be reached does not fail fast,
// it stalls). A new version is fetched in the background, all files together,
// and only swapped in once every one of them has arrived; the page is then told,
// and offers a reload.
//
// On the Mac (localhost), the server is right there: network first, so a
// change shows up on the next reload.

const CACHE = 'classbook-v7';
const SHELL = [
  '/', '/style.css', '/manifest.webmanifest',
  '/js/app.js', '/js/db.js', '/js/model.js', '/js/ui.js', '/js/plan.js', '/js/planviews.js', '/js/grades.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png',
];
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);
const CHECK_EVERY = 60 * 1000;   // look for a new version at most once a minute
const TIMEOUT = 8000;            // a background fetch that takes longer is given up

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter((k) => k !== CACHE);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    // Replacing an earlier version: an app already open still runs the old one.
    if (old.length) for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage('updated');
  })());
});

// The page asks when it comes back to the foreground: an installed app can sit
// in the background for days without ever being reopened.
self.addEventListener('message', (e) => {
  if (e.data === 'check-update' && !LOCAL) e.waitUntil(checkForUpdate());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // The Mac's documents and PDFs are made fresh each time; attached files
  // (/files/…) are cached like the app, so a note's pictures show offline too.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/plan/') || url.pathname.endsWith('.crt')) return;
  const key = e.request.mode === 'navigate' ? '/' : url.pathname;
  if (LOCAL) e.respondWith(networkFirst(e.request, key));
  else {
    e.respondWith(cacheFirst(e.request, key));
    if (e.request.mode === 'navigate') e.waitUntil(checkForUpdate());
  }
});

function fetchWithTimeout(request, ms = TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal, cache: 'no-cache' }).finally(() => clearTimeout(timer));
}

async function cacheFirst(request, key) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key, { ignoreSearch: true });
  if (hit) return hit;
  // Not cached yet (KaTeX, a note's picture): fetch it, and keep it.
  const r = await fetch(request);
  if (r.ok) cache.put(key, r.clone());
  return r;
}

async function networkFirst(request, key) {
  const cache = await caches.open(CACHE);
  try {
    const r = await fetchWithTimeout(request, 2500);
    if (r.ok) cache.put(key, r.clone());
    return r;
  } catch {
    return (await cache.match(key, { ignoreSearch: true })) || Response.error();
  }
}

// All of the app, or none of it: a half-updated app (a new app.js with an old
// model.js) could not start, so nothing is replaced until every file is here.
let lastCheck = 0;
async function checkForUpdate() {
  if (Date.now() - lastCheck < CHECK_EVERY) return;
  lastCheck = Date.now();
  const cache = await caches.open(CACHE);
  let fresh;
  try {
    fresh = await Promise.all(SHELL.map(async (path) => {
      const r = await fetchWithTimeout(path);
      if (!r.ok) throw new Error(path);
      return [path, r, await r.clone().text()];
    }));
  } catch {
    return;   // the Mac is not reachable (or answered oddly): keep what we have
  }
  let changed = false;
  for (const [path, , text] of fresh) {
    const old = await cache.match(path);
    if (!old || (await old.text()) !== text) { changed = true; break; }
  }
  if (!changed) return;
  await Promise.all(fresh.map(([path, r]) => cache.put(path, r)));
  for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage('updated');
}
