// Hearth Chat — service worker
// Strategy:
//  - HTML navigations: network-first with a 3s timeout + navigation preload,
//    falling back to cache, then to offline.html (never blocks the user)
//  - Immutable assets (icons/screenshots): cache-first (zero network on repeat)
//  - Same-origin static assets + CDN libraries (fonts/font-awesome):
//    stale-while-revalidate (instant cache, refreshed in the background)
//  - Supabase/API/data calls: always network-only, never cached

const VERSION = "v13";
const SHELL_CACHE = "hearth-shell-" + VERSION;
const RUNTIME_CACHE = "hearth-runtime-" + VERSION;

const SHELL_ASSETS = [
  "./",
  "index.html",
  "login.html",
  "signup.html",
  "oauth-callback.html",
  "app.html",
  "admin.html",
  "offline.html",
  "styles.css",
  "config.js",
  "supabase.js",
  "db.js",
  "articles.js",
  "cloudinary.js",
  "nav.js",
  "app.js",
  "admin.js",
  "manifest.json",
  "favicon.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "screenshot-mobile.png",
  "screenshot-desktop.png"
];

// Hosts that serve live/user data and must never be served from cache.
const NEVER_CACHE_HOSTS = [
  "supabase.co",
  "supabase.in",
  "cloudinary.com"
];

// Files that never change once deployed — serve them straight from cache.
const CACHE_FIRST_ASSETS = [
  "favicon.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "screenshot-mobile.png",
  "screenshot-desktop.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // Cache each asset individually so one missing/failing file can never
      // abort the whole service worker install (a failed install means the
      // page is never controlled and beforeinstallprompt never fires).
      .then((cache) => Promise.allSettled(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn("[sw] skip precache:", url, err))
        )
      ))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn("[sw] precache failed", err))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )),
      // Pre-fetch navigations in parallel with the SW boot (faster loads).
      self.registration.navigationPreload
        ? self.registration.navigationPreload.enable().catch(() => {})
        : Promise.resolve(),
      self.clients.claim()
    ])
  );
});

function isNeverCache(url) {
  return NEVER_CACHE_HOSTS.some((host) => url.hostname.indexOf(host) !== -1);
}

// Resolve to `undefined` if the network takes longer than `ms`, so a slow
// connection never blocks the user (cache/offline fallback kicks in fast).
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(undefined); }
    );
  });
}

// Cross-origin CDN responses arrive as "opaque" (status 0) — cache those too
// so Google Fonts / Font Awesome are instant on repeat visits.
function isCacheable(response) {
  return response && (response.status === 200 || response.type === "opaque");
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.status === 200) cache.put(request, fresh.clone());
  return fresh;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (isCacheable(response)) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || networkFetch;
}

async function networkFirstNavigation(request, preloadPromise) {
  const NAV_TIMEOUT_MS = 3000;
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request)
    || await cache.match(new URL(request.url).pathname.replace(/^\//, ""));

  // Use the navigation preload response when available (it races the SW boot).
  const fresh = await withTimeout(preloadPromise || fetch(request), NAV_TIMEOUT_MS);
  if (fresh && fresh.status === 200) {
    cache.put(request, fresh.clone());
    return fresh;
  }
  if (cached) return cached;
  if (fresh) return fresh;
  return cache.match("offline.html");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept writes (POST/PUT/DELETE to Supabase, etc.)

  const url = new URL(request.url);

  // Dynamic backend calls: always go to the network, never cached.
  if (isNeverCache(url)) {
    return; // let the browser handle it natively
  }

  // Page navigations: network-first (with preload + timeout) + offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request, event.preloadResponse));
    return;
  }

  // Same-origin static assets or trusted CDN libraries.
  const sameOrigin = url.origin === self.location.origin;
  const trustedCdn = ["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net"]
    .some((h) => url.hostname === h);

  if (sameOrigin || trustedCdn) {
    const filename = url.pathname.split("/").pop();
    // Immutable assets (icons/screenshots): serve straight from cache.
    if (CACHE_FIRST_ASSETS.indexOf(filename) !== -1) {
      event.respondWith(cacheFirst(request));
      return;
    }
    event.respondWith(staleWhileRevalidate(request));
  }
});

// Allow the page to trigger an immediate activation after prompting the user.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
