/* Service worker: app shell precache + cache-first for immutable pipeline
 * output (IR JSON and converted assets). The shell itself is network-first so
 * code updates land on the next reload; the cache is the offline fallback.
 * Bump VERSION to invalidate pipeline data. */
const VERSION = "{{SW_CACHE}}";
const SHELL = ["./", "index.html", "bundle.js", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "records", "records.html", "records-bundle.js", "game.json", "narrative.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const isPipelineData = url.pathname.includes("/ir/") || url.pathname.includes("/assets/");
  const isShell = SHELL.some((s) => url.pathname.endsWith(s.replace("./", "/")));
  if (!isPipelineData && !isShell) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      if (isPipelineData) {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      }
      try {
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        throw new Error(`offline and not cached: ${url.pathname}`);
      }
    }),
  );
});
