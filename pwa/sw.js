/* Arnav Music service worker. Built by vite.config.ts (`pwaPlugin`), which fills in the version and
 * the list of build files, and served as /sw.js.
 *
 *   App shell (/)      network first, the saved copy when offline — updates show on the next load
 *   /assets/*          cache first: file names carry a content hash, so a file never changes
 *   artwork, fonts,    saved as they're used (stale-while-revalidate), so your library looks
 *   icons              right offline
 *   everything else    straight to the network (the API, YouTube, Firebase, sockets)
 */
const VERSION = '__VERSION__'
const ASSETS = __ASSETS__
const SHELL = `arnav-shell-${VERSION}`
const STATIC = 'arnav-static'
const ART = 'arnav-art'
const FONTS = 'arnav-fonts'
const ART_MAX = 600
const NAV_TIMEOUT_MS = 4000

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL)
    await shell.add(new Request('/', { cache: 'reload' }))
    // Every build file, so any page opens offline. Files already saved (same hash) are skipped,
    // so an update only downloads what changed.
    const stat = await caches.open(STATIC)
    const have = new Set((await stat.keys()).map((r) => new URL(r.url).pathname))
    const missing = ASSETS.filter((a) => !have.has(a))
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.all(missing.slice(i, i + 8).map((a) => stat.add(a).catch(() => undefined)))
    }
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('arnav-shell-') && key !== SHELL) await caches.delete(key)
    // Build files from older versions are dropped.
    const keep = new Set(ASSETS)
    const stat = await caches.open(STATIC)
    for (const r of await stat.keys()) if (!keep.has(new URL(r.url).pathname)) await stat.delete(r)
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => undefined)
  })())
})

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  const same = url.origin === self.location.origin

  if (req.mode === 'navigate' && same && !url.pathname.startsWith('/api/')) {
    event.respondWith(shellFirstFromNetwork(event))
    return
  }
  if (same && url.pathname.startsWith('/assets/')) { event.respondWith(cacheFirst(req, STATIC)); return }
  if (same && (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest')) { event.respondWith(staleWhileRevalidate(req, STATIC)); return }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { event.respondWith(staleWhileRevalidate(req, FONTS)); return }
  if (req.destination === 'image' && /(^|\.)ytimg\.com$|(^|\.)ggpht\.com$|googleusercontent\.com$|mzstatic\.com$/.test(url.hostname)) {
    event.respondWith(artwork(req))
  }
})

async function shellFirstFromNetwork(event) {
  const cache = await caches.open(SHELL)
  try {
    const preload = await event.preloadResponse
    const res = preload || await withTimeout(fetch(event.request), NAV_TIMEOUT_MS)
    // Every app route serves the same index.html: keep the newest copy for offline starts.
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) await cache.put('/', res.clone())
    return res
  } catch {
    return (await cache.match('/')) || Response.error()
  }
}

async function cacheFirst(req, name) {
  const cache = await caches.open(name)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) await cache.put(req, res.clone())
  return res
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name)
  const hit = await cache.match(req)
  const fresh = fetch(req).then(async (res) => { if (res.ok || res.type === 'opaque') await cache.put(req, res.clone()); return res })
  if (hit) { fresh.catch(() => undefined); return hit }
  return fresh
}

/** Cover art: asked for with CORS so it can be saved (opaque copies cost far more storage). */
async function artwork(req) {
  const cache = await caches.open(ART)
  const hit = await cache.match(req.url)
  if (hit) return hit
  try {
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' })
    if (res.ok) {
      await cache.put(req.url, res.clone())
      void trim(cache, ART_MAX)
    }
    return res
  } catch {
    // No CORS on this host, or offline: let the browser try it the usual way.
    return fetch(req)
  }
}

async function trim(cache, max) {
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i])
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}
