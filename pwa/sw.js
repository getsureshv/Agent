/**
 * Cricket Scorer — Service Worker
 * Dev 1: PWA Shell
 *
 * Cache names — do NOT change these strings without bumping CACHE_VERSION.
 * Other devs reference these names directly (especially 'vosk-model-v1').
 */

// Bump CACHE_VERSION to evict old app-shell assets on next activate.
const CACHE_VERSION = 'v5-20260520-2010';

const CACHE_APP_SHELL      = 'app-shell-' + CACHE_VERSION;
const CACHE_VENDOR_MP      = 'vendor-mediapipe-v1';                  // big binaries — don't re-download on every bump
const CACHE_API            = 'api-' + CACHE_VERSION;
const CACHE_VOSK_MODEL     = 'vosk-model-v1';                        // populated by Dev 3's downloadVoskModel() — keep stable

// All known caches — anything not in this list will be deleted on activate
const ALL_CACHES = [CACHE_APP_SHELL, CACHE_VENDOR_MP, CACHE_API, CACHE_VOSK_MODEL];

// App-shell assets to precache on install. PWA is mounted at /pwa/ on the
// Agent base, so all asset paths must be prefixed accordingly.
const APP_SHELL_ASSETS = [
  '/pwa/',
  '/pwa/index.html',
  '/pwa/styles.css',
  '/pwa/manifest.json',
  '/pwa/icons/icon-48.png',
  '/pwa/icons/icon-72.png',
  '/pwa/icons/icon-96.png',
  '/pwa/icons/icon-144.png',
  '/pwa/icons/icon-180.png',
  '/pwa/icons/icon-192.png',
  '/pwa/icons/icon-512.png',
];

// ─── Install ────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_APP_SHELL)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ───────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !ALL_CACHES.includes(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
      .then(() => notifyClients(navigator.onLine ? 'app:online' : 'app:offline'))
  );
});

// ─── Fetch ──────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle http(s) requests
  if (!url.protocol.startsWith('http')) return;

  // 1. /pwa/vendor/mediapipe/** → Cache First (CACHE_VENDOR_MP)
  if (url.pathname.startsWith('/pwa/vendor/mediapipe/')) {
    event.respondWith(cacheFirst(request, CACHE_VENDOR_MP));
    return;
  }

  // 2. /pwa/vendor/vosk/** → Cache First if model cache exists (populated by Dev 3)
  if (url.pathname.startsWith('/pwa/vendor/vosk/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request))
    );
    return;
  }

  // 3. Agent base API GET requests → Stale-While-Revalidate (CACHE_API)
  //    Matches requests to BASE_URL/api/** or any origin with /api/ in the path.
  const configBase = (self.__APP_CONFIG__?.BASE_URL ?? '').replace(/\/$/, '');
  const isApiRequest = request.method === 'GET' && (
    (configBase && url.href.startsWith(configBase + '/api/')) ||
    url.pathname.startsWith('/api/')
  );
  if (isApiRequest) {
    event.respondWith(staleWhileRevalidate(request, CACHE_API));
    return;
  }

  // 4a. PWA JS/HTML/CSS app code → Stale-While-Revalidate so code updates ship on next load
  //     without requiring a CACHE_VERSION bump.
  if (
    url.origin === self.location.origin &&
    (
      url.pathname === '/pwa/' ||
      url.pathname === '/pwa/index.html' ||
      url.pathname === '/pwa/styles.css' ||
      url.pathname === '/pwa/manifest.json' ||
      url.pathname === '/pwa/config.js' ||
      url.pathname === '/pwa/app.js' ||
      url.pathname.startsWith('/pwa/src/')
    )
  ) {
    event.respondWith(staleWhileRevalidate(request, CACHE_APP_SHELL));
    return;
  }

  // 4b. PWA Icons — truly static, safe to cache-first
  if (
    url.origin === self.location.origin &&
    url.pathname.startsWith('/pwa/icons/')
  ) {
    event.respondWith(cacheFirst(request, CACHE_APP_SHELL));
    return;
  }

  // 5. Everything else — network only (no caching)
});

// ─── Strategies ─────────────────────────────────────────────────────────────

/**
 * Cache First: serve from cache; if missing, fetch → cache → return.
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Network failed and nothing in cache — return a simple offline response
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

/**
 * Stale-While-Revalidate: serve cached version immediately while fetching update.
 * Used for Agent base REST GET responses.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  return cached || fetchPromise || new Response('Offline', { status: 503 });
}

// ─── Online / Offline Detection ─────────────────────────────────────────────

self.addEventListener('online', () => notifyClients('app:online'));
self.addEventListener('offline', () => notifyClients('app:offline'));

/**
 * Broadcast a message type to all controlled clients.
 * main.js receives these and re-dispatches as window events.
 */
async function notifyClients(type) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type }));
}

// ─── Message Handler ────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // Dev 4's SyncEngine can send 'CHECK_ONLINE' to request current status
  if (event.data && event.data.type === 'CHECK_ONLINE') {
    notifyClients(navigator.onLine ? 'app:online' : 'app:offline');
  }
});
