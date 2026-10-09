/**
 * Arnav Music edge API — one implementation shared by Cloudflare Workers, Cloudflare Pages
 * Functions and Vercel Edge Functions. Uses only Web-standard Request/Response/fetch.
 *
 *   GET  /api/health                 → { ok, youtube }
 *   GET  /api/yt?ep=search&…         → YouTube Data API v3 (key stays on the server); `videos`
 *                                      responses carry `arnav`, the shared clean parse of each title
 *   GET  /api/img?u=<ytimg url>      → artwork with CORS headers (for on-device colour extraction)
 *   GET  /api/lyrics?ep=get|search&… → LRCLIB (open lyrics database), identified with a User-Agent
 *   GET  /api/meta?src=…&ep=…        → iTunes / MusicBrainz / Wikidata / Deezer / NetEase (see meta.ts)
 *   GET  /api/credits?v=<id>         → song credits from every free source, cached for everyone
 *   GET|POST /api/community          → lyrics version + timing fixes listeners agreed on
 *   GET  /api/known                  → artist + film names learned from YouTube Topic data
 */
import { cached, fetchWithTimeout, json, USER_AGENT, type ApiEnv, type WaitUntil } from './util'
import { creditsApi, communityApi, knownApi, metaApi } from './meta'
import { flushKnown, knownSets, learnFromYouTube, nameKey } from './known'
import { parseYouTubeTitle, PARSE_V } from '../src/lib/format'

export type { ApiEnv } from './util'

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

const IMG_HOSTS = new Set(['i.ytimg.com', 'i1.ytimg.com', 'i2.ytimg.com', 'i3.ytimg.com', 'i4.ytimg.com', 'i9.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com', 'lh3.googleusercontent.com', 'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com', 'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com'])

export async function handleApi(request: Request, env: ApiEnv, waitUntil?: WaitUntil): Promise<Response> {
  const url = new URL(request.url)
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-yt-key',
        'access-control-max-age': '86400',
      },
    })
  }
  const route = url.pathname.replace(/\/+$/, '')
  // Friends and rooms need Durable Objects (the Cloudflare Workers host); other hosts say so clearly.
  if (route.startsWith('/api/social') || route.startsWith('/api/room')) return json({ error: 'social_unavailable', message: 'Friends and listening rooms need the Cloudflare Workers host.' }, 501)
  if (request.method !== 'GET' && !(request.method === 'POST' && route === '/api/community')) return json({ error: 'method_not_allowed' }, 405)

  try {
    switch (route) {
      case '/api/health':
        return json({ ok: true, youtube: Boolean(env.YOUTUBE_API_KEY), androidRestricted: Boolean(env.YOUTUBE_ANDROID_PACKAGE && env.YOUTUBE_ANDROID_CERT), parseV: PARSE_V, time: Date.now() }, 200, { 'cache-control': 'no-store' })
      case '/api/yt':
        return await youtube(url, request, env, waitUntil)
      case '/api/img':
        return await image(url)
      case '/api/lyrics':
        return await lyrics(url, env, waitUntil)
      case '/api/meta':
        return await metaApi(url, env, waitUntil)
      case '/api/credits':
        return await creditsApi(url, env, waitUntil)
      case '/api/community':
        return await communityApi(request, url, env)
      case '/api/known':
        return await knownApi(env)
      default:
        return json({ error: 'not_found' }, 404)
    }
  } catch (e) {
    return json({ error: 'upstream_failed', message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }, 502)
  } finally {
    flushKnown(env, waitUntil)
  }
}

interface YtItem { id?: string | { videoId?: string }; snippet?: { title?: string; channelTitle?: string; description?: string; localized?: unknown; tags?: string[] }; contentDetails?: { regionRestriction?: unknown }; arnav?: unknown }

/** Adds the shared parse of every title, so all visitors see the same clean metadata. */
async function withParse(body: string, env: ApiEnv): Promise<string> {
  let data: { items?: YtItem[] }
  try { data = JSON.parse(body) } catch { return body }
  if (!data.items?.length) return body
  const known = await knownSets(env)
  const ctx = { isKnownArtist: (n: string) => known.artists.has(nameKey(n)), isKnownFilm: (n: string) => known.films.has(nameKey(n)) }
  for (const it of data.items) {
    // Clients read only the start of a description (genre hints); full ones made a page of 50 videos ~150 KB.
    // Same for fields no client reads (a localized copy of the title and description, per-country lists).
    if (it.snippet?.description && it.snippet.description.length > 300) it.snippet.description = it.snippet.description.slice(0, 300)
    if (it.snippet) { delete it.snippet.localized; if (it.snippet.tags && it.snippet.tags.length > 24) it.snippet.tags = it.snippet.tags.slice(0, 24) }
    if (it.contentDetails) delete it.contentDetails.regionRestriction
    const t = it.snippet?.title
    if (!t) continue
    const raw = decode(t)
    const p = parseYouTubeTitle(raw, decode(it.snippet?.channelTitle ?? ''), ctx)
    it.arnav = { v: PARSE_V, title: p.title, artist: p.artist, album: p.album, credits: p.credits, fromChannel: p.fromChannel }
  }
  return JSON.stringify(data)
}
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')

async function youtube(url: URL, request: Request, env: ApiEnv, waitUntil?: WaitUntil): Promise<Response> {
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
  // Edge cache first (Cloudflare's per-colo cache, ~20 ms): public data, already parsed. KV + parse
  // behind it took ~0.6 s a call, and opening a playlist makes several.
  const edge = (globalThis as { caches?: { default?: Cache } }).caches?.default
  const edgeKey = new Request(`https://yt-edge.arnav/e3-${PARSE_V}/${cacheKey}`)
  if (edge) {
    const hit = await edge.match(edgeKey).catch(() => undefined)
    if (hit) { const h = new Headers(hit.headers); h.set('x-arnav-cache', 'edge'); return new Response(hit.body, { status: 200, headers: h }) }
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  if (env.YOUTUBE_ANDROID_PACKAGE && env.YOUTUBE_ANDROID_CERT) {
    headers['X-Android-Package'] = env.YOUTUBE_ANDROID_PACKAGE
    headers['X-Android-Cert'] = env.YOUTUBE_ANDROID_CERT
  }
  const result = await cached(env, cacheKey, ep.ttl, async () => {
    const r = await fetch(upstream.toString(), { headers })
    return { status: r.status, body: await r.text() }
  }, waitUntil)
  let body = result.body
  if (result.status === 200) {
    if (!result.hit) learnFromYouTube(body)
    if (ep.path === 'videos' || ep.path === 'search' || ep.path === 'playlistItems') body = await withParse(body, env)
  }
  const res = new Response(body, {
    status: result.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      // Shared CDN caching for public data (Vercel honours s-maxage); never cache errors.
      'cache-control': result.status === 200 ? `public, max-age=300, s-maxage=${Math.min(ep.ttl, 3600)}` : 'no-store',
      'x-arnav-cache': result.hit ? 'hit' : 'miss',
    },
  })
  if (edge && result.status === 200) {
    const copy = new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': `public, max-age=300, s-maxage=${Math.min(ep.ttl, 3600)}` } })
    const put = edge.put(edgeKey, copy).catch(() => undefined)
    if (waitUntil) waitUntil(put)
  }
  return res
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

async function lyrics(url: URL, env: ApiEnv, waitUntil?: WaitUntil): Promise<Response> {
  const ep = url.searchParams.get('ep')
  if (ep !== 'get' && ep !== 'search' && ep !== 'id') return json({ error: 'bad_endpoint' }, 400)
  const id = url.searchParams.get('id') ?? ''
  if (ep === 'id' && !/^\d{1,12}$/.test(id)) return json({ error: 'bad_id' }, 400)
  const upstream = new URL(ep === 'id' ? `https://lrclib.net/api/get/${id}` : `https://lrclib.net/api/${ep}`)
  if (ep !== 'id') {
    for (const k of ['track_name', 'artist_name', 'album_name', 'duration', 'q']) {
      const v = url.searchParams.get(k)
      if (v) upstream.searchParams.set(k, v.slice(0, 200))
    }
  }
  const cacheKey = `lrc:v1:${upstream.pathname}?${upstream.searchParams.toString()}`
  const result = await cached(env, cacheKey, 7 * 86400, async () => {
    // LRCLIB has brief overloads (503 / 429 / timeouts): one quick retry before giving up.
    for (let attempt = 0; ; attempt++) {
      const r = await fetchWithTimeout(upstream.toString(), { headers: { 'User-Agent': USER_AGENT, 'Lrclib-Client': USER_AGENT, accept: 'application/json' } }, 9000).catch(() => null)
      // 404 from /api/get simply means "no exact match" — pass it through so the client can search.
      if (r && (r.status < 500 && r.status !== 429)) return { status: r.status, body: await r.text() }
      if (attempt >= 1) return { status: r?.status ?? 504, body: r ? await r.text() : '{"error":"timeout"}' }
      await new Promise((res) => setTimeout(res, 700))
    }
  }, waitUntil)
  return new Response(result.body, {
    status: result.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      // A missing exact match is worth caching briefly; an upstream failure never is.
      'cache-control': result.status === 200 ? 'public, max-age=3600, s-maxage=604800' : result.status === 404 ? 'public, max-age=600, s-maxage=3600' : 'no-store',
    },
  })
}
