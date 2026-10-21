// SocraticAI Service Worker v35.1
const CACHE_NAME = 'socratic-v35.1.0-20260825-r3';
const APP_SHELL = [
  '/',
  '/static/styles.css',
  '/static/v35-overrides.css',
  '/static/modules/main.js',
  '/static/modules/hrd-program.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key.startsWith('socratic-') && key !== CACHE_NAME).map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

async function networkFirst(request, fallbackPath) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(request)) || (fallbackPath ? await cache.match(fallbackPath) : null);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // API payloads can contain user data and must never be cached by the service worker.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Navigation and same-origin modules use the network first so HTML/module versions
  // cannot drift apart. The v35.1 cache is only an offline fallback.
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, '/'));
    return;
  }
  if (url.pathname.startsWith('/static/') || url.pathname === '/manifest.json') {
    event.respondWith(networkFirst(event.request));
  }
});
