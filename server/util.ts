/** Shared helpers for the edge API (Web-standard APIs only). */

export interface ApiEnv {
  /** YouTube Data API v3 key. Set as a secret: `wrangler secret put YOUTUBE_API_KEY` / Vercel env. */
  YOUTUBE_API_KEY?: string
  /** Optional: only for keys restricted to the Android app (same headers the Android app sends). */
  YOUTUBE_ANDROID_PACKAGE?: string
  YOUTUBE_ANDROID_CERT?: string
  /** Optional KV namespace (Cloudflare): shared response cache, community lyric timing, learned names. */
  YT_CACHE?: KVNamespace
}

export type WaitUntil = (p: Promise<unknown>) => void

export const USER_AGENT = 'ArnavMusicWeb/1.0 (+https://github.com/Arnav-Dugad/Arnav-Music-Website)'

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra },
  })

/** KV-backed shared cache. Only 200s are stored. */
export async function cached(env: ApiEnv, key: string, ttl: number, load: () => Promise<{ status: number; body: string }>, waitUntil?: WaitUntil) {
  const kv = env.YT_CACHE
  if (kv) {
    const hit = await kv.get(key).catch(() => null)
    if (hit !== null) return { status: 200, body: hit, hit: true }
  }
  const fresh = await load()
  if (kv && fresh.status === 200 && fresh.body.length < 2_000_000) {
    const put = kv.put(key, fresh.body, { expirationTtl: Math.max(60, ttl) }).catch(() => undefined)
    if (waitUntil) waitUntil(put)
    else await put
  }
  return { ...fresh, hit: false }
}

/** fetch with a timeout (upstreams are nice-to-have; never hang a request on them). */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

/** Cached JSON GET from a third-party API. Returns null on any failure. */
export async function cachedJson<T>(env: ApiEnv, key: string, ttl: number, url: string, headers: Record<string, string> = {}, waitUntil?: WaitUntil): Promise<T | null> {
  try {
    const r = await cached(env, key, ttl, async () => {
      const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT, accept: 'application/json', ...headers } })
      return { status: res.status, body: await res.text() }
    }, waitUntil)
    if (r.status !== 200) { console.warn('[meta] upstream', r.status, url.slice(0, 120), r.body.slice(0, 160)); return null }
    return JSON.parse(r.body) as T
  } catch (e) {
    console.warn('[meta] failed', url.slice(0, 120), e instanceof Error ? e.message : e)
    return null
  }
}

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
