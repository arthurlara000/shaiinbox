// =====================================================================
// SHAI INBOX — Service Worker
// =====================================================================
// Estratégia:
// - index.html / manifest / icon → cache-first com fallback de rede
// - Recursos externos (fontes, Supabase JS CDN) → stale-while-revalidate
// - Chamadas pro Supabase REST/Storage → SEMPRE network (não cachear dados)
// =====================================================================

const CACHE_VERSION = 'shai-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 🚫 Nunca cachear chamadas pro Supabase (dados dinâmicos)
  if (url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.in')) {
    return; // browser default
  }

  // App shell (mesmo origin) → cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) {
          // refresh em background
          fetch(req).then((res) => {
            if (res && res.ok) {
              caches.open(CACHE_VERSION).then((c) => c.put(req, res.clone()));
            }
          }).catch(() => {});
          return cached;
        }
        return fetch(req).then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
          }
          return res;
        }).catch(() => caches.match('/index.html'));
      })
    );
    return;
  }

  // Recursos externos (fontes, CDN supabase-js, etc) → stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkPromise = fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkPromise;
    })
  );
});
