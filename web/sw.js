// The app shell from the cache at once, a fresh copy fetched behind it for the next open
// (cc-phone.html proposal 2); the page checks index.html's Last-Modified itself and reloads
// when it changed. With nothing cached yet, the network. Everything else (cchost's API,
// SSE, blog, files) goes straight to the network.
const CACHE = "cc-v1";
const SHELL = [
  "",
  "index.html",
  "manifest.json",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable.png",
].map((p) => new URL(p, registration.scope).pathname);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (
    e.request.method !== "GET" || url.origin !== location.origin ||
    !SHELL.includes(url.pathname)
  ) return;
  // the page's own fetch of a new version, which it writes to the cache before reloading
  if (e.request.cache === "no-store") return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fresh = fetch(e.request, { cache: "no-cache" }).then((res) => {
      if (res.ok) cache.put(url.pathname, res.clone());
      return res;
    });
    const hit = await cache.match(url.pathname);
    if (hit) {
      e.waitUntil(fresh.catch(() => {}));
      return hit;
    }
    return fresh.catch(() => Response.error());
  })());
});
