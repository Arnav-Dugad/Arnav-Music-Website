/**
 * Arnav Music edge API — one implementation shared by Cloudflare Workers, Cloudflare Pages
 * Functions and Vercel Edge Functions. Uses only Web-standard Request/Response/fetch.
 *
 *   GET /api/health                 → { ok, youtube }
 *   GET /api/yt?ep=search&…         → YouTube Data API v3 (key stays on the server)
 *   GET /api/img?u=<ytimg url>      → artwork with CORS headers (for on-device colour extraction)
 *   GET /api/lyrics?ep=get|search&… → LRCLIB (open lyrics database), identified with a User-Agent
 */

export interface ApiEnv {
  /** YouTube Data API v3 key. Set as a secret: `wrangler secret put YOUTUBE_API_KEY` / Vercel env. */
  YOUTUBE_API_KEY?: string
  /** Optional: only for keys restricted to the Android app (same headers the Android app sends). */
  YOUTUBE_ANDROID_PACKAGE?: string
  YOUTUBE_ANDROID_CERT?: string
  /** Optional KV namespace (Cloudflare) used as a shared response cache to save quota. */
  YT_CACHE?: KVNamespace
}

interface Endpoint {
  path: string
  /** Query parameters forwarded to Google; everything else is dropped. */
  params: string[]
  /** Shared cache lifetime in seconds. */
  ttl: number
}

const YT_ENDPOINTS: Record<string, Endpoint> = {
  search: {
    path: 'search',
    params: ['part', 'q', 'type', 'maxResults', 'pageToken', 'safeSearch', 'videoCategoryId', 'videoEmbeddable', 'regionCode', 'channelId', 'order', 'relevanceLanguage', 'topicId'],
    ttl: 6 * 3600,
  },
  videos: { path: 'videos', params: ['part', 'id', 'chart', 'videoCategoryId', 'maxResults', 'regionCode', 'pageToken'], ttl: 12 * 3600 },
  playlistItems: { path: 'playlistItems', params: ['part', 'playlistId', 'maxResults', 'pageToken'], ttl: 3600 },
  playlists: { path: 'playlists', params: ['part', 'id', 'channelId', 'maxResults', 'pageToken'], ttl: 6 * 3600 },
  channels: { path: 'channels', params: ['part', 'id', 'forHandle', 'maxResults'], ttl: 24 * 3600 },
}

const IMG_HOSTS = new Set(['i.ytimg.com', 'i1.ytimg.com', 'i2.ytimg.com', 'i3.ytimg.com', 'i4.ytimg.com', 'i9.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com', 'lh3.googleusercontent.com'])
const USER_AGENT = 'ArnavMusicWeb/1.0 (+https://github.com/Arnav-Dugad/Arnav-Music-Website)'

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra },
  })

export async function handleApi(request: Request, env: ApiEnv, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type, x-yt-key',
        'access-control-max-age': '86400',
      },
    })
  }
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)

  const route = url.pathname.replace(/\/+$/, '')
  try {
    switch (route) {
      case '/api/health':
        return json({ ok: true, youtube: Boolean(env.YOUTUBE_API_KEY), androidRestricted: Boolean(env.YOUTUBE_ANDROID_PACKAGE && env.YOUTUBE_ANDROID_CERT), time: Date.now() }, 200, { 'cache-control': 'no-store' })
      case '/api/yt':
        return await youtube(url, request, env, waitUntil)
      case '/api/img':
        return await image(url)
      case '/api/lyrics':
        return await lyrics(url, env, waitUntil)
      default:
        return json({ error: 'not_found' }, 404)
    }
  } catch (e) {
    return json({ error: 'upstream_failed', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }, 502)
  }
}

async function cached(env: ApiEnv, key: string, ttl: number, load: () => Promise<{ status: number; body: string }>, waitUntil?: (p: Promise<unknown>) => void) {
  const kv = env.YT_CACHE
  if (kv) {
    const hit = await kv.get(key)
    if (hit !== null) return { status: 200, body: hit, hit: true }
  }
  const fresh = await load()
  if (kv && fresh.status === 200 && fresh.body.length < 2_000_000) {
    const put = kv.put(key, fresh.body, { expirationTtl: Math.max(60, ttl) })
    if (waitUntil) waitUntil(put)
    else await put
  }
  return { ...fresh, hit: false }
}

async function youtube(url: URL, request: Request, env: ApiEnv, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const ep = YT_ENDPOINTS[url.searchParams.get('ep') ?? '']
  if (!ep) return json({ error: 'bad_endpoint' }, 400)
  const userKey = request.headers.get('x-yt-key')?.trim()
  const key = (userKey && /^[A-Za-z0-9_-]{20,60}$/.test(userKey) ? userKey : '') || env.YOUTUBE_API_KEY?.trim() || ''
  if (!key) return json({ error: { code: 503, errors: [{ reason: 'missingKey' }], message: 'No YouTube API key is configured on the server.' } }, 503)

  const upstream = new URL(`https://www.googleapis.com/youtube/v3/${ep.path}`)
  const sorted = [...url.searchParams.entries()].filter(([k]) => ep.params.includes(k)).sort(([a], [b]) => a.localeCompare(b))
  for (const [k, v] of sorted) upstream.searchParams.set(k, v.slice(0, 300))
  const cacheKey = `yt:v1:${ep.path}?${upstream.searchParams.toString()}`
  upstream.searchParams.set('key', key)

  const headers: Record<string, string> = { accept: 'application/json' }
  if (env.YOUTUBE_ANDROID_PACKAGE && env.YOUTUBE_ANDROID_CERT) {
    headers['X-Android-Package'] = env.YOUTUBE_ANDROID_PACKAGE
    headers['X-Android-Cert'] = env.YOUTUBE_ANDROID_CERT
  }
  const result = await cached(env, cacheKey, ep.ttl, async () => {
    const r = await fetch(upstream.toString(), { headers })
    return { status: r.status, body: await r.text() }
  }, waitUntil)
  return new Response(result.body, {
    status: result.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      // Shared CDN caching for public data (Vercel honours s-maxage); never cache errors.
      'cache-control': result.status === 200 ? `public, max-age=300, s-maxage=${ep.ttl}` : 'no-store',
      'x-arnav-cache': result.hit ? 'hit' : 'miss',
    },
  })
}

async function image(url: URL): Promise<Response> {
  const raw = url.searchParams.get('u') ?? ''
  let target: URL
  try { target = new URL(raw) } catch { return json({ error: 'bad_url' }, 400) }
  if (target.protocol !== 'https:' || !IMG_HOSTS.has(target.hostname)) return json({ error: 'host_not_allowed' }, 400)
  const r = await fetch(target.toString(), { headers: { accept: 'image/*' } })
  const type = r.headers.get('content-type') ?? ''
  if (!r.ok || !type.startsWith('image/')) return json({ error: 'image_failed', status: r.status }, r.ok ? 415 : r.status)
  return new Response(r.body, {
    status: 200,
    headers: {
      'content-type': type,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=604800, s-maxage=2592000, immutable',
    },
  })
}

async function lyrics(url: URL, env: ApiEnv, waitUntil?: (p: Promise<unknown>) => void): Promise<Response> {
  const ep = url.searchParams.get('ep')
  if (ep !== 'get' && ep !== 'search') return json({ error: 'bad_endpoint' }, 400)
  const upstream = new URL(`https://lrclib.net/api/${ep}`)
  for (const k of ['track_name', 'artist_name', 'album_name', 'duration', 'q']) {
    const v = url.searchParams.get(k)
    if (v) upstream.searchParams.set(k, v.slice(0, 200))
  }
  const cacheKey = `lrc:v1:${upstream.pathname}?${upstream.searchParams.toString()}`
  const result = await cached(env, cacheKey, 7 * 86400, async () => {
    const r = await fetch(upstream.toString(), { headers: { 'User-Agent': USER_AGENT, 'Lrclib-Client': USER_AGENT, accept: 'application/json' } })
    // 404 from /api/get simply means "no exact match" — pass it through so the client can search.
    return { status: r.status, body: await r.text() }
  }, waitUntil)
  return new Response(result.body, {
    status: result.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': result.status === 200 ? 'public, max-age=3600, s-maxage=604800' : 'public, max-age=600, s-maxage=3600',
    },
  })
}
