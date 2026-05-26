const CACHE = 'void-v10';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Only handle http(s) — skip chrome-extension://, data:, blob:, etc.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Never cache: API calls, Google services, CDNs, external audio
  if (
    url.hostname.includes('youtube.com') ||
    url.hostname.includes('ytimg.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('googlevideo.com') ||
    url.hostname.includes('googleusercontent.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('sndcdn.com') ||
    url.hostname.includes('saavncdn.com') ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('jsdelivr.net') ||
    url.pathname.startsWith('/api/')
  ) {
    return; // fall through to network, no SW involvement
  }

  // ── index.html: ALWAYS network-first so CSP headers stay fresh ──
  // Never serve index.html from cache — it must come from the server
  // so helmet's Content-Security-Policy headers are always up to date.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for true static assets (manifest, icons)
  const isStatic = STATIC_ASSETS.some(a => url.pathname === a);
  if (isStatic) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // Network-first with cache fallback for everything else
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r && r.status === 200 && r.type !== 'opaque') {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
