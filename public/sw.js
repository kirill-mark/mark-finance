// Офлайн-кеш. Страница — сначала из сети; ассеты — из кеша с обновлением.
// Запросы к Supabase (данные, вход, обновления) никогда не кешируются.
const CACHE = "mark-finance-__VERSION__";
const SHELL = ["./", "./index.html", "./manifest.json", "./assets/app.js?v=__VERSION__", "./assets/app.css?v=__VERSION__", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-180.png"];
const HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== CACHE).map((x) => caches.delete(x)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin && !HOSTS.includes(url.hostname)) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { const c = r.clone(); caches.open(CACHE).then((x) => x.put("./index.html", c)); return r; }).catch(() => caches.match("./index.html")));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((r) => { if (r.ok || r.type === "opaque") { const c = r.clone(); caches.open(CACHE).then((x) => x.put(req, c)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
