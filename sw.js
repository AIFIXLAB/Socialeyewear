const V = 'seo-v50';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.endsWith('supabase.co')) return; // ข้อมูลไม่แคชที่นี่
  // cache: 'no-store' กันเบราว์เซอร์เสิร์ฟไฟล์เก่าจาก HTTP cache ของตัวเอง (เคยทำให้เห็น app.js รุ่นเก่าแม้อัปไฟล์ใหม่แล้ว)
  e.respondWith(fetch(e.request, { cache: 'no-store' }).then(r => { if (r.ok || r.type === 'opaque') { const c = r.clone(); caches.open(V).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
