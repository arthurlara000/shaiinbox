// Shai Caixa — service worker
// O caixa precisa abrir mesmo sem internet: a tela e as bibliotecas (Supabase, código de barras,
// fontes, ícones) ficam guardadas. A tela sempre tenta a versão nova primeiro; as bibliotecas vêm
// do cache e se atualizam por trás. Dados do Supabase e chamadas ao Bling nunca passam pelo cache.
const CACHE = 'shai-caixa-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/assets/icon-192.png', '/assets/icon-512.png'];
const LIBS = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  if (LIBS.test(req.url)) {
    e.respondWith(
      caches.match(req).then(cached => {
        const rede = fetch(req).then(res => {
          if (res.ok || res.type === 'opaque') { const copia = res.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
          return res;
        }).catch(() => cached);
        return cached || rede;
      })
    );
  }
});
