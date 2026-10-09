/**
 * Official music videos for songs, found once for everyone.
 *
 *   GET /api/mv?ids=<videoId>,<videoId>,…   (up to 50)
 *     → { items: { <id>: { alt: Track | null } }, pending: [<id>…] }
 *
 * `alt` is the song's official music video (null = it has none). Answers are kept in KV for months,
 * so a song is looked up once across every listener. Finding a new one costs a YouTube search
 * (100 quota units), so each request resolves at most a couple of new songs, within a daily budget
 * shared by all visitors; the rest come back as `pending` and the app asks again later.
 */
import { cached, fetchWithTimeout, json, overLimit, VIDEO_ID, type ApiEnv, type WaitUntil } from './util'
import { videoToTrack, type YtVideo } from '../src/lib/classify'
import { counterpartQuery, pickCounterpart } from '../src/lib/match'
import { trustOf } from '../src/lib/trust'
import type { Track } from '../src/lib/types'

const DAY = 86_400
const FOUND_TTL = 180 * DAY
const NONE_TTL = 14 * DAY
/** New songs looked up per request, and per day for the whole site (each costs ~101 units). */
const PER_REQUEST = 2
const DAILY = 40
const key = (id: string) => `mv:v1:${id}`

/** Search quota ran out (or YouTube refused): don't spend more from this isolate for a while. */
let pausedUntil = 0

type Slim = Pick<Track, 'id' | 'title' | 'artist' | 'album' | 'playbackRef' | 'durationMs' | 'artworkUrl' | 'variant' | 'channelTitle' | 'rawTitle' | 'trust' | 'credits' | 'year' | 'views' | 'parseV' | 'artistFromChannel'>
const slim = (t: Track): Slim => ({ id: t.id, title: t.title, artist: t.artist, album: t.album ?? null, playbackRef: t.playbackRef, durationMs: t.durationMs ?? null, artworkUrl: t.artworkUrl ?? null, variant: t.variant ?? null, channelTitle: t.channelTitle ?? null, rawTitle: t.rawTitle ?? null, trust: t.trust, credits: t.credits ?? null, year: t.year ?? null, views: t.views ?? null, parseV: t.parseV, artistFromChannel: t.artistFromChannel })

interface Stored { alt: Slim | null; self?: boolean; at: number }

async function yt<T>(env: ApiEnv, path: string, params: Record<string, string>, ttl: number, waitUntil?: WaitUntil): Promise<{ status: number; data: T | null }> {
  const apiKey = env.YOUTUBE_API_KEY?.trim()
  if (!apiKey) return { status: 503, data: null }
  const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  const qs = new URLSearchParams(sorted)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (env.YOUTUBE_ANDROID_PACKAGE && env.YOUTUBE_ANDROID_CERT) { headers['X-Android-Package'] = env.YOUTUBE_ANDROID_PACKAGE; headers['X-Android-Cert'] = env.YOUTUBE_ANDROID_CERT }
  // Same cache key as the /api/yt proxy, so lookups and the app share what's already been fetched.
  const r = await cached(env, `yt:v1:${path}?${qs.toString()}`, ttl, async () => {
    const res = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/${path}?${qs.toString()}&key=${apiKey}`, { headers }, 10_000).catch(() => null)
    return res ? { status: res.status, body: await res.text() } : { status: 504, body: '' }
  }, waitUntil)
  if (r.status !== 200) return { status: r.status, data: null }
  try { return { status: 200, data: JSON.parse(r.body) as T } } catch { return { status: 502, data: null } }
}

const VIDEO_PARTS = 'snippet,contentDetails,status,statistics'
const playable = (v: YtVideo) => v.status?.embeddable !== false && v.snippet?.liveBroadcastContent !== 'live'

/** Finds one song's official music video. undefined = couldn't look (quota / error), so nothing is stored. */
async function resolve(env: ApiEnv, id: string, waitUntil?: WaitUntil): Promise<Stored | undefined> {
  const base = await yt<{ items?: YtVideo[] }>(env, 'videos', { id, part: VIDEO_PARTS }, 12 * 3600, waitUntil)
  if (base.status !== 200) return undefined
  const item = base.data?.items?.[0]
  if (!item) return { alt: null, at: Date.now() }
  const song = videoToTrack(item)
  // Already a music video: it is its own video.
  if (song.variant === 'VIDEO') return { alt: slim(song), self: true, at: Date.now() }
  const q = counterpartQuery(song, 'VIDEO')
  const found = await yt<{ items?: { id?: { videoId?: string } }[] }>(env, 'search', { part: 'snippet', q, type: 'video', maxResults: '15', safeSearch: 'moderate', videoCategoryId: '10', videoEmbeddable: 'true' }, 30 * DAY, waitUntil)
  if (found.status !== 200) {
    if (found.status === 403 || found.status === 429) pausedUntil = Date.now() + 30 * 60_000
    return undefined
  }
  const ids = (found.data?.items ?? []).map((i) => i.id?.videoId).filter((v): v is string => !!v && v !== id).slice(0, 15)
  if (!ids.length) return { alt: null, at: Date.now() }
  const details = await yt<{ items?: YtVideo[] }>(env, 'videos', { id: ids.join(','), part: VIDEO_PARTS }, 12 * 3600, waitUntil)
  if (details.status !== 200) return undefined
  const pool = (details.data?.items ?? []).filter(playable).map((v) => { const t = videoToTrack(v, q); return { ...t, trust: trustOf(t, null, q) } })
  const pick = pickCounterpart({ ...song, trust: trustOf(song, null, q) }, 'VIDEO', pool)
  // An upload that isn't marked either way (no "Topic", no "audio") counts as the video.
  const video = pick && (pick.variant === 'VIDEO' || (pick.variant == null && !/- Topic$/i.test(pick.channelTitle ?? ''))) ? { ...pick, variant: 'VIDEO' as const } : null
  return { alt: video ? slim(video) : null, at: Date.now() }
}

async function spendBudget(env: ApiEnv): Promise<boolean> {
  const kv = env.YT_CACHE
  if (!kv) return true
  const k = `mv:budget:${new Date().toISOString().slice(0, 10)}`
  const used = Number(await kv.get(k).catch(() => null)) || 0
  if (used >= DAILY) return false
  await kv.put(k, String(used + 1), { expirationTtl: 2 * DAY }).catch(() => undefined)
  return true
}

export async function musicVideosApi(request: Request, url: URL, env: ApiEnv, waitUntil?: WaitUntil): Promise<Response> {
  const ids = [...new Set((url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter((s) => VIDEO_ID.test(s)))].slice(0, 50)
  if (!ids.length) return json({ error: 'bad_request' }, 400)
  const kv = env.YT_CACHE
  const items: Record<string, { alt: Slim | null }> = {}
  const unknown: string[] = []
  const stored = await Promise.all(ids.map((id) => (kv ? kv.get(key(id)).catch(() => null) : Promise.resolve(null))))
  stored.forEach((raw, i) => {
    if (!raw) { unknown.push(ids[i]); return }
    try { const s = JSON.parse(raw) as Stored; items[ids[i]] = { alt: s.alt } } catch { unknown.push(ids[i]) }
  })
  const ip = request.headers.get('cf-connecting-ip') ?? 'x'
  let resolved = 0
  for (const id of unknown) {
    if (resolved >= PER_REQUEST || Date.now() < pausedUntil || overLimit(`mv:${ip}`, 20, 3600_000)) break
    if (!(await spendBudget(env))) break
    resolved++
    const r = await resolve(env, id, waitUntil).catch(() => undefined)
    if (!r) continue
    items[id] = { alt: r.alt }
    if (kv) {
      const put = kv.put(key(id), JSON.stringify(r), { expirationTtl: r.alt ? FOUND_TTL : NONE_TTL }).catch(() => undefined)
      if (waitUntil) waitUntil(put)
    }
  }
  const pending = ids.filter((id) => !(id in items))
  return json({ items, pending }, 200, { 'cache-control': 'no-store' })
}
