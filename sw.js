// ============ Service Worker：離線快取應用程式外殼 ============
const CACHE = 'nav-shell-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/utils.js',
  './js/map.js',
  './js/search.js',
  './js/routing.js',
  './js/navigation.js',
  './js/voice.js',
  './js/places.js',
  './icon.svg',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Mapbox API（圖磚 / 路線 / 搜尋）永遠走網路，由 Mapbox GL 自行管理圖磚快取
  if (url.origin !== location.origin) return;
  // 同源的應用程式檔案：先取網路（保持最新），失敗時退回快取（離線可開）
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
