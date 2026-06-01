// RG Plaza · RG Hub — Service Worker
// СТРАТЕГИЯ (важно для понимания):
//   • HTML-страницы  → NETWORK-FIRST с таймаутом: всегда тянем свежую версию из сети,
//     на кэш падаем ТОЛЬКО если сеть недоступна/медленная. Это убирает «старый кэш»:
//     любой деплой виден при обычном обновлении страницы, без ручного сброса.
//   • Статика (библиотеки, шрифты, иконки) → CACHE-FIRST + фоновое обновление.
//   • Supabase API → NETWORK-FIRST (данные всегда живые), кэш только для офлайна.
//
// CACHE_VERSION бампать НЕ обязательно при каждом деплое HTML (network-first сам отдаёт
// свежий HTML). Версию меняем, только если надо принудительно сбросить кэш СТАТИКИ.
const CACHE_VERSION = 'rgh-v2.1.0';
const CACHE_NAME = `rgh-cache-${CACHE_VERSION}`;

// Таймаут сети для HTML: если за это время не ответило — отдаём кэш (что-то показать
// лучше, чем бесконечный спиннер при плохой сети/без VPN). При живой сети — всегда свежее.
const HTML_NETWORK_TIMEOUT_MS = 5000;

// App Shell — то, что нужно для офлайна. HTML тоже кладём (как запасной вариант офлайн).
const APP_SHELL = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/buh.html',
  '/insurance.html',
  '/owners.html',
  '/manifest.json',
  '/offline.html',
  '/icon-192.png',
  '/icon-512.png',
  // Библиотеки лежат локально в репозитории (/lib) — не зависим от внешних CDN,
  // которые без VPN иногда не грузятся («XLSX is not defined» и т.п.). 01.06.2026.
  '/lib/supabase.js',
  '/lib/chart.umd.js',
  '/lib/xlsx.full.min.js',
  // Шрифты — некритично (без них просто другой шрифт)
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700;800&display=swap',
];

// === INSTALL: предзагружаем App Shell, по одному (миссы не валят установку) ===
self.addEventListener('install', event => {
  console.log('[SW] Installing version:', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        APP_SHELL.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Cache miss:', url, err.message))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// === ACTIVATE: удаляем старые кэши и сразу берём управление ===
self.addEventListener('activate', event => {
  console.log('[SW] Activating version:', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names
          .filter(name => name.startsWith('rgh-cache-') && name !== CACHE_NAME)
          .map(name => { console.log('[SW] Deleting old cache:', name); return caches.delete(name); })
      )
    ).then(() => self.clients.claim())
  );
});

// Является ли запрос загрузкой HTML-страницы (навигация).
function isHtmlRequest(req) {
  if (req.mode === 'navigate') return true;
  if (req.destination === 'document') return true;
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

// Сеть с таймаутом: если сеть не ответила за ms — реджектим, чтобы упасть на кэш.
function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('network-timeout')), ms);
    fetch(req).then(
      res => { clearTimeout(t); resolve(res); },
      err => { clearTimeout(t); reject(err); }
    );
  });
}

// === FETCH ===
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Не-GET (Supabase POST/PATCH/DELETE) — мимо SW, напрямую в сеть.
  if (req.method !== 'GET') return;

  // === HTML-страницы: NETWORK-FIRST с таймаутом ===
  // Всегда пытаемся взять свежую версию. Обновили деплой → менеджер видит сразу,
  // без сброса кэша. Сеть недоступна/медленная → отдаём последнюю кэшированную, затем offline.
  if (isHtmlRequest(req)) {
    event.respondWith(
      fetchWithTimeout(req, HTML_NETWORK_TIMEOUT_MS)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(req)
            .then(cached => cached || caches.match('/index.html'))
            .then(cached => cached || caches.match('/offline.html'))
            .then(cached => cached || new Response('Нет связи', { status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
        )
    );
    return;
  }

  // === Supabase API: NETWORK-FIRST, кэш только для офлайна ===
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(req)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(req, clone))
              .catch(() => {/* сеть упала при кэшировании — молча игнорируем */});
          }
          return response;
        })
        .catch(() =>
          caches.match(req).then(cached =>
            cached || new Response(
              JSON.stringify({ error: 'offline', message: 'Нет связи с сервером' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            )
          )
        )
    );
    return;
  }

  // === Статика (библиотеки, шрифты, иконки): CACHE-FIRST + фоновое обновление ===
  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(req, clone))
              .catch(() => {/* молча */});
          }
          return response;
        })
        .catch(() => undefined);
      if (cached) { networkFetch; return cached; }
      return networkFetch.then(res => {
        if (res) return res;
        if (isHtmlRequest(req)) return caches.match('/offline.html').then(o => o || new Response('', { status: 504 }));
        return new Response('', { status: 504 });
      });
    })
  );
});

// === MESSAGE: команда обновиться (с кнопки в приложении) ===
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
