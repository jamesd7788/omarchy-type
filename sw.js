/* Service worker: make omarchy-type installable and usable offline.
 *
 * The app is a handful of static files, so the whole thing is precached on
 * install. Two rules keep that from fighting the live-theme design:
 *
 *   - /theme and /theme/stream are NEVER cached. They are live desktop
 *     state and the SSE stream must not be buffered; both bypass the
 *     worker entirely and go straight to the network.
 *   - Navigations are network-first. The server sends no-store because the
 *     page is edited in place and reloaded constantly; a cache-first worker
 *     would reintroduce exactly the stale-UI bug that header exists to
 *     prevent. Cache is the offline fallback, not the fast path.
 *
 * Bump VERSION to retire the old cache.
 */
const VERSION = "omarchy-type-v1";

const PRECACHE = [
  "./",
  "index.html",
  "words/english.json",
  "manifest.webmanifest",
  "icon.svg",
  "icon-maskable.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // Individually, so one 404 can't fail the whole install.
      .then((c) => Promise.all(
        PRECACHE.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Live theme state and its event stream: always the network, never cached.
  if (url.pathname === "/theme" || url.pathname.startsWith("/theme/")) return;

  // Navigations: network first, cache only when the network is gone.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match("index.html").then((r) => r || caches.match("./"))
        )
    );
    return;
  }

  // Static assets: serve from cache, refresh it in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
