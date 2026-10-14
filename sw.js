const CACHE = 'wikifeed-v1'
const SHELL = [
  './', './index.html', './style.css', './manifest.json',
  './src/app.js', './src/api.js', './src/db.js',
  './src/algorithm.js', './src/renderer.js',
]
// Wikipedia API responses cached for 1 hour
const API_TTL = 3600 * 1000

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (url.hostname.endsWith('wikipedia.org') || url.hostname.endsWith('wikidata.org')) {
    e.respondWith(networkFirstCached(e.request))
  } else {
    e.respondWith(cacheFirst(e.request))
  }
})

async function cacheFirst(req) {
  const cached = await caches.match(req)
  if (cached) return cached
  const res = await fetch(req)
  if (res.ok) {
    const cache = await caches.open(CACHE)
    cache.put(req, res.clone())
  }
  return res
}

async function networkFirstCached(req) {
  const cache = await caches.open(CACHE)
  // Check for a cached response that isn't too old
  const cached = await cache.match(req)
  if (cached) {
    const date = cached.headers.get('sw-cached-at')
    if (date && Date.now() - parseInt(date) < API_TTL) return cached
  }
  try {
    const res = await fetch(req)
    if (res.ok) {
      // Clone and add timestamp header
      const headers = new Headers(res.headers)
      headers.set('sw-cached-at', String(Date.now()))
      const stamped = new Response(await res.clone().blob(), {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
      cache.put(req, stamped)
      return res
    }
    return cached || res
  } catch {
    return cached || Response.error()
  }
}
