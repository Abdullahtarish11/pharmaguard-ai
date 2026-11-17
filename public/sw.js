/**
 * Service Worker — تخزين هيكل التطبيق فقط.
 * قواعد صارمة: لا تُخزَّن أي استجابة من /api إطلاقًا (بيانات صيدلية حسّاسة)،
 * ولا تُخزَّن صفحات المستخدم بعد تسجيل الدخول.
 */
const CACHE = 'pharmaguard-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // لا تخزين لأي طلب API أو مصادقة
  if (url.pathname.startsWith('/api/')) return;

  // طلبات التنقل: شبكة أولًا مع رجوع للنسخة المخزّنة عند انقطاع الشبكة فقط
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/').then((cached) => cached ?? new Response('غير متصل', { status: 503 })),
      ),
    );
    return;
  }

  // الأصول الثابتة: من الكاش ثم الشبكة
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        });
      }),
    );
  }
});
