// Network-first for the app shell only, so the installed app still opens offline.
// Everything else (cchost's API, SSE, blog, files) goes straight to the network.
const CACHE = "cc-v1";
const SHELL = ["", "index.html", "manifest.json", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable.png"].map((p) => new URL(p, registration.scope).pathname);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !SHELL.includes(url.pathname)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request, { cache: "no-cache" });
      if (res.ok) cache.put(url.pathname, res.clone());
      return res;
    } catch {
      return (await cache.match(url.pathname)) ?? Response.error();
    }
  })());
});
