// RG Plaza · RG Hub — Service Worker
// Версия меняй при каждом обновлении кэша
const CACHE_VERSION = 'rgh-v1.0.0';
const CACHE_NAME = `rgh-cache-${CACHE_VERSION}`;

// Файлы которые нужны для офлайн-работы (App Shell)
const APP_SHELL = [
  '/',
  '/index.html',
  '/dashboard.html',
  '/buh.html',
  '/insurance.html',
  '/manifest.json',
  '/offline.html',
  // Иконки
  '/icon-192.png',
  '/icon-512.png',
  // Внешние библиотеки (нагружают первый раз — потом из кэша)
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js',
  // Шрифты
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600;700;800&display=swap',
];

// === INSTALL: предзагружаем App Shell ===
self.addEventListener('install', event => {
  console.log('[SW] Installing version:', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Кэшируем по одному (если что-то недоступно — не валим установку)
      return Promise.all(
        APP_SHELL.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Cache miss:', url, err.message))
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// === ACTIVATE: удаляем старые кэши ===
self.addEventListener('activate', event => {
  console.log('[SW] Activating version:', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(names => {
      return Promise.all(
        names
          .filter(name => name.startsWith('rgh-cache-') && name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// === FETCH: стратегии для разных типов запросов ===
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Игнорируем не-GET запросы (Supabase POST/PATCH идут напрямую)
  if (req.method !== 'GET') return;

  // === Supabase API запросы (network-first, с фолбэком на cache) ===
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(req)
        .then(response => {
          // Кэшируем успешные ответы для офлайн-просмотра
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req)) // офлайн → из кэша если есть
    );
    return;
  }

  // === Все остальные ресурсы (cache-first) ===
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) {
        // Параллельно обновляем кэш в фоне (stale-while-revalidate)
        fetch(req)
          .then(response => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
            }
          })
          .catch(() => {/* офлайн — игнорируем */});
        return cached;
      }
      // Нет в кэше — пробуем загрузить
      return fetch(req)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => {
          // Если это HTML-страница — отдаём offline.html
          if (req.headers.get('accept')?.includes('text/html')) {
            return caches.match('/offline.html');
          }
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
