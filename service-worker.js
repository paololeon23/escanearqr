// service-worker.js - Cache para funcionar con y sin internet
const CACHE_NAME = "qr-val-v3";
const assets = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./network.js",
  "./manifest.json",
  "./librerias/lucide.min.js",
  "./librerias/sweetalert2.all.min.js",
  "./librerias/sweetalert2.min.css",
  "./librerias/html5-qrcode.min.js",
  "./Logo.png",
  "./Logo2.png",
  "./icono.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.allSettled(assets.map(function (url) { return cache.add(url).catch(function () {}); })).then(function () {});
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; }).map(function (n) { return caches.delete(n); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// Cache primero para la app (funciona sin internet); red para actualizar en segundo plano
function isAppRequest(req) {
  var u = new URL(req.url);
  if (u.origin !== self.location.origin) return false;
  var path = u.pathname.replace(/^\//, "") || "index.html";
  return /^(index\.html)?$/.test(path) || /\.(js|css|json|png|jpg|jpeg|gif|ico|svg|woff2?)$/i.test(path) || path.startsWith("librerias/");
}

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET" || !e.request.url.startsWith("http")) return;
  if (!isAppRequest(e.request)) {
    e.respondWith(fetch(e.request).catch(function () { return new Response("", { status: 503, statusText: "Offline" }); }));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      var fetchPromise = fetch(e.request).then(function (res) {
        if (res && res.status === 200 && res.url.startsWith(self.location.origin)) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(e.request, clone); });
        }
        return res;
      });
      return cached || fetchPromise;
    }).then(function (res) { return res || new Response("", { status: 404, statusText: "Not Found" }); })
  );
});