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
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff', ...extra },
  })

export interface CacheResult { status: number; body: string; hit: boolean; stale?: boolean }

/** Identical requests already in flight in this isolate share one upstream call. */
const inflight = new Map<string, Promise<{ status: number; body: string }>>()

/**
 * KV-backed shared cache. Only 200s are stored.
 *
 * An entry is fresh for `ttl`, but kept for several times longer: once stale it's refreshed on the
 * next request, and if the upstream fails then (quota used up, an outage, a timeout) the stale copy
 * is served instead of an error — so listeners keep working through upstream trouble.
 */
export async function cached(env: ApiEnv, key: string, ttl: number, load: () => Promise<{ status: number; body: string }>, waitUntil?: WaitUntil): Promise<CacheResult> {
  const kv = env.YT_CACHE
  let stale: string | null = null
  if (kv) {
    const hit = await kv.getWithMetadata<{ at?: number }>(key).catch(() => null)
    if (hit && hit.value !== null) {
      const at = hit.metadata?.at
      // Entries written before metadata existed expire on their own; treat them as fresh.
      if (!at || Date.now() - at < ttl * 1000) return { status: 200, body: hit.value, hit: true }
      stale = hit.value
    }
  }
  let fresh: { status: number; body: string }
  try {
    let job = inflight.get(key)
    if (!job) {
      job = load()
      inflight.set(key, job)
      void job.finally(() => inflight.delete(key)).catch(() => undefined)
    }
    fresh = await job
  } catch (e) {
    if (stale !== null) return { status: 200, body: stale, hit: true, stale: true }
    throw e
  }
  if (fresh.status !== 200) {
    if (stale !== null) return { status: 200, body: stale, hit: true, stale: true }
    return { ...fresh, hit: false }
  }
  if (kv && fresh.body.length < 2_000_000) {
    const keep = Math.max(ttl * 4, 3 * 86_400)
    const put = kv.put(key, fresh.body, { expirationTtl: Math.max(60, keep), metadata: { at: Date.now() } }).catch(() => undefined)
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

/**
 * A small per-isolate rate limit (sliding window). Not global — it only stops one visitor from
 * hammering a single edge location, which is what burns the shared YouTube quota.
 */
const windows = new Map<string, number[]>()
export function overLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= max) { windows.set(key, hits); return true }
  hits.push(now)
  windows.set(key, hits)
  if (windows.size > 5000) for (const [k, v] of windows) if (!v.length || now - v[v.length - 1] > windowMs) windows.delete(k)
  return false
}

/** Cloudflare's per-location HTTP cache, when running on Workers (undefined elsewhere). */
export const edgeCache = (): Cache | undefined => (globalThis as { caches?: { default?: Cache } }).caches?.default

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
