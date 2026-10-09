import { idbDel, idbGet, idbKeys, idbSet } from './idb'
import { cacheKey, isRemoteWorthy } from './query'
import { cachePolicy, COSTS, quotaState, useUsage, type QuotaState } from './usage'
import { bestThumb, videoToTrack, type YtSnippet, type YtVideo } from './classify'
import { decodeEntities } from './format'
import { MusicError, artistKey, type Artist, type Track } from './types'
import { trustOf, type ChannelStat } from './trust'
import { remember } from '../state/tracks'
import { regionCode, settings } from '../state/settings'

export type SearchFilter = 'ALL' | 'SONGS' | 'VIDEOS' | 'ARTISTS' | 'PLAYLISTS'

export interface RemotePlaylist {
  id: string // "ytpl:<playlistId>"
  name: string
  owner: string
  artworkUrl?: string | null
  itemCount?: number
}

export interface SearchResults {
  query: string
  tracks: Track[]
  artists: Artist[]
  playlists: RemotePlaylist[]
  nextPageToken?: string | null
  fromCache: boolean
  fetchedAt: number
}

interface CachedPage {
  tracks: Track[]
  artists: Artist[]
  playlists: RemotePlaylist[]
  nextPageToken?: string | null
  fetchedAt: number
}

/** Bumped when the track mapping changes so stale cached pages are refetched once. */
const CACHE_VERSION = 'v15|'
const LIST_VERSION = 'v11|'

/** Removes cached pages saved under older versions (each bump would otherwise leave a copy behind). */
export async function pruneStaleCache() {
  const keys = await idbKeys('cache').catch(() => [] as string[])
  const stale = keys.filter((k) => (/^v\d+\|/.test(k) && !k.startsWith(CACHE_VERSION)) || (/^(chart|pl)\|v\d+\|/.test(k) && !k.startsWith(`chart|${LIST_VERSION}`) && !k.startsWith(`pl|${LIST_VERSION}`)))
  for (const k of stale) await idbDel(k, 'cache').catch(() => {})
  return stale.length
}
const inflight = new Map<string, Promise<SearchResults>>()

const budget = () => settings().youtubeDailyBudget || 10000
export const ytQuotaState = (): QuotaState => quotaState(budget())

interface YtErrorBody { error?: { code?: number; message?: string; errors?: { reason?: string }[] } }

const QUOTA_MSG = 'Today’s YouTube quota is used up. Saved results still work; it resets at midnight Pacific.'

/** Set by the API status check: the server has no key (so only a listener key can work). */
let serverWithoutKey = false
export function setServerWithoutKey(v: boolean) { serverWithoutKey = v }

async function api<T>(ep: string, params: Record<string, string | number | undefined | null>): Promise<T> {
  if (serverWithoutKey && !settings().youtubeKey.trim()) {
    throw new MusicError('missingKey', 'YouTube isn’t connected yet. Add a YouTube Data API key in Settings → Sources.')
  }
  const qs = new URLSearchParams({ ep })
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v))
  const headers: Record<string, string> = {}
  const key = settings().youtubeKey.trim()
  if (key) headers['x-yt-key'] = key
  let r: Response | null = null
  // A dropped connection or a brief "slow down" gets one quiet retry before the listener sees an error.
  for (let attempt = 0; attempt < 2; attempt++) {
    r = await fetch(`/api/yt?${qs.toString()}`, { headers }).catch(() => null)
    if (r && r.status !== 429) break
    if (r && r.status === 429) {
      const body = await r.clone().json().catch(() => null) as YtErrorBody | null
      if (body?.error?.errors?.[0]?.reason !== 'slowDown') break
    }
    if (attempt === 0 && navigator.onLine !== false) await new Promise((res) => setTimeout(res, r ? 1500 : 700))
  }
  if (!r) throw new MusicError('offline', 'You appear to be offline.')
  const text = await r.text()
  let body: unknown = null
  try { body = JSON.parse(text) } catch { /* non-JSON */ }
  if (!r.ok) {
    const err = (body as YtErrorBody | null)?.error
    const reason = err?.errors?.[0]?.reason
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded') {
      useUsage.getState().bump({ serverExhausted: true })
      throw new MusicError('quota', QUOTA_MSG)
    }
    if (reason === 'missingKey' || reason === 'keyInvalid' || (r.status === 400 && /api key/i.test(err?.message ?? ''))) {
      throw new MusicError('missingKey', 'YouTube isn’t connected yet. Add a YouTube Data API key in Settings → Sources.')
    }
    if (reason === 'accessNotConfigured' || reason === 'youtubeSignupRequired') throw new MusicError('notConfigured', 'YouTube Data API v3 isn’t enabled for this key.')
    if (reason === 'slowDown') throw new MusicError('http', 'Lots of requests right now — try again in a moment.', 429)
    if (reason === 'timeout') throw new MusicError('http', 'YouTube is slow to answer right now — try again.', 504)
    if (r.status === 403) throw new MusicError('http', err?.message ?? 'YouTube refused the request.', 403)
    if (r.status === 404 && !body) throw new MusicError('notConfigured', 'The music API isn’t reachable on this host.', 404)
    throw new MusicError('http', err?.message ?? `YouTube error ${r.status}`, r.status)
  }
  return body as T
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof MusicError) || e.kind !== 'http' || (e.status ?? 0) < 500 || attempt >= 2) throw e
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt + Math.random() * 200))
    }
  }
}

const charge = (units: number, search = false) => useUsage.getState().bump({ units, calls: 1, ...(search ? { remoteSearches: 1 } : {}) })

interface SearchResponse { items?: { id?: { kind?: string; videoId?: string; channelId?: string; playlistId?: string }; snippet?: YtSnippet }[]; nextPageToken?: string }
interface VideosResponse { items?: YtVideo[]; nextPageToken?: string }

interface ChannelStatsResponse { items?: { id: string; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } }[] }

/** Subscriber counts for trust scoring — channels.list, 1 unit per 50 channels, cached for a week. */
async function channelStats(ids: string[]): Promise<Map<string, ChannelStat>> {
  const out = new Map<string, ChannelStat>()
  const missing: string[] = []
  for (const id of [...new Set(ids)]) {
    const hit = await idbGet<{ s: ChannelStat; at: number }>(`chs|${id}`, 'cache')
    if (hit && Date.now() - hit.at < 7 * 86_400_000) out.set(id, hit.s)
    else missing.push(id)
  }
  if (missing.length && ytQuotaState() !== 'EXHAUSTED') {
    for (let i = 0; i < missing.length; i += 50) {
      try {
        const r = await api<ChannelStatsResponse>('channels', { part: 'statistics', id: missing.slice(i, i + 50).join(','), maxResults: 50 })
        charge(COSTS.CHANNELS_LIST)
        for (const c of r.items ?? []) {
          const s: ChannelStat = { subs: c.statistics?.hiddenSubscriberCount ? null : c.statistics?.subscriberCount ? Number(c.statistics.subscriberCount) : null, hidden: !!c.statistics?.hiddenSubscriberCount }
          out.set(c.id, s)
          void idbSet(`chs|${c.id}`, { s, at: Date.now() }, 'cache')
        }
      } catch { /* trust falls back to name signals */ }
    }
  }
  return out
}

/** Adds trust scores (Topic/VEVO/label/artist channel/established) to fresh tracks. */
async function scoreTrust(tracks: Track[], query = ''): Promise<Track[]> {
  const first = tracks.map((t) => ({ ...t, trust: trustOf(t, null, query) }))
  // Only uploads that names alone can't place need subscriber counts (one batched call).
  const needStats = first.filter((t) => t.trust === 0 && t.channelId).map((t) => t.channelId!)
  if (!needStats.length) return first
  const stats = await channelStats(needStats)
  return first.map((t) => (t.trust === 0 && t.channelId ? { ...t, trust: trustOf(t, stats.get(t.channelId), query) } : t))
}

/** videos.list for up to 50 ids — 1 unit. Filters to embeddable, non-live uploads. */
export async function videoDetails(ids: string[], query = ''): Promise<Track[]> {
  if (ids.length === 0) return []
  // Batches of 50 in parallel (each is its own round trip).
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50))
  const pages = await Promise.all(chunks.map(async (chunk) => {
    const r = await withRetry(() => api<VideosResponse>('videos', { part: 'snippet,contentDetails,status,statistics', id: chunk.join(',') }))
    charge(COSTS.VIDEOS_LIST)
    return (r.items ?? [])
      .filter((v) => v.status?.embeddable !== false && v.snippet?.liveBroadcastContent !== 'live')
      .map((v) => videoToTrack(v, query))
  }))
  let out: Track[] = pages.flat()
  const order = new Map(ids.map((id, i) => [id, i]))
  out.sort((a, b) => (order.get(a.playbackRef) ?? 0) - (order.get(b.playbackRef) ?? 0))
  out = await scoreTrust(out, query)
  remember(out)
  return out
}

function keyFor(query: string, filter: SearchFilter, pageToken?: string | null) {
  return CACHE_VERSION + cacheKey(query, filter) + (pageToken ? `#${pageToken}` : '')
}

/** Cache only — never touches the network. Used for instant results while typing. */
export async function cachedSearch(query: string, filter: SearchFilter, pageToken?: string | null): Promise<SearchResults | null> {
  const hit = await idbGet<CachedPage>(keyFor(query, filter, pageToken), 'cache')
  if (!hit) return null
  remember(hit.tracks)
  return { query, ...hit, fromCache: true }
}

export async function search(query: string, filter: SearchFilter = 'ALL', pageToken?: string | null, opts: { force?: boolean } = {}): Promise<SearchResults> {
  const key = keyFor(query, filter, pageToken)
  const state = ytQuotaState()
  const cached = await cachedSearch(query, filter, pageToken)
  if (cached && !opts.force && cachePolicy.isFresh(cached.fetchedAt, state)) {
    useUsage.getState().bump({ cacheHits: 1 })
    return cached
  }
  if (state === 'EXHAUSTED') {
    if (cached) return cached
    throw new MusicError('quota', QUOTA_MSG)
  }
  if (!isRemoteWorthy(query)) return { query, tracks: [], artists: [], playlists: [], fromCache: false, fetchedAt: Date.now() }
  const existing = inflight.get(key)
  if (existing) return existing
  const p = remoteSearch(query, filter, pageToken, key)
    .catch((e) => {
      if (cached) return cached // serve stale rather than an error
      throw e
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function remoteSearch(query: string, filter: SearchFilter, pageToken: string | null | undefined, key: string): Promise<SearchResults> {
  const type = filter === 'ALL' ? 'video,channel,playlist' : filter === 'ARTISTS' ? 'channel' : filter === 'PLAYLISTS' ? 'playlist' : 'video'
  const r = await withRetry(() => api<SearchResponse>('search', {
    part: 'snippet', q: query.trim(), type, maxResults: 25, pageToken, safeSearch: 'moderate',
    videoCategoryId: type === 'video' ? '10' : undefined,
    videoEmbeddable: type === 'video' ? 'true' : undefined,
    regionCode: regionCode(),
  }))
  charge(COSTS.SEARCH, true)
  const items = r.items ?? []
  const videoIds = items.map((i) => i.id?.videoId).filter((v): v is string => !!v)
  const tracks = await videoDetails(videoIds, query)
  const artists: Artist[] = []
  const seenA = new Set<string>()
  for (const it of items) {
    if (!it.id?.channelId || !(it.id.kind ?? '').endsWith('channel')) continue
    const name = decodeEntities(it.snippet?.channelTitle || it.snippet?.title || '').replace(/\s*-\s*Topic$/, '')
    const k = artistKey(name)
    if (!name || seenA.has(k)) continue
    seenA.add(k)
    artists.push({ key: k, name, artworkUrl: bestThumb(it.snippet?.thumbnails), channelId: it.id.channelId })
  }
  const playlists: RemotePlaylist[] = items
    .filter((it) => it.id?.playlistId)
    .map((it) => ({
      id: `ytpl:${it.id!.playlistId}`,
      name: decodeEntities(it.snippet?.title ?? 'Playlist'),
      owner: decodeEntities(it.snippet?.channelTitle ?? ''),
      artworkUrl: bestThumb(it.snippet?.thumbnails),
    }))
  const page: CachedPage = { tracks, artists, playlists, nextPageToken: r.nextPageToken ?? null, fetchedAt: Date.now() }
  void idbSet(key, page, 'cache')
  return { query, ...page, fromCache: false }
}

export const shouldRevalidate = (r: SearchResults) => cachePolicy.shouldRevalidate(r.fetchedAt, ytQuotaState())

async function cachedList(key: string, load: () => Promise<Track[]>): Promise<Track[]> {
  const hit = await idbGet<{ tracks: Track[]; fetchedAt: number }>(key, 'cache')
  const state = ytQuotaState()
  if (hit && cachePolicy.isFresh(hit.fetchedAt, state)) {
    useUsage.getState().bump({ cacheHits: 1 })
    remember(hit.tracks)
    return hit.tracks
  }
  if (state === 'EXHAUSTED') {
    if (hit) { remember(hit.tracks); return hit.tracks }
    throw new MusicError('quota', QUOTA_MSG)
  }
  try {
    const tracks = await load()
    void idbSet(key, { tracks, fetchedAt: Date.now() }, 'cache')
    return tracks
  } catch (e) {
    if (hit) { remember(hit.tracks); return hit.tracks }
    throw e
  }
}

/** Trending music chart (1 unit), cached for the day. */
export function trending(region = regionCode()): Promise<Track[]> {
  return cachedList(`chart|${LIST_VERSION}${region}`, async () => {
    const r = await withRetry(() => api<VideosResponse>('videos', {
      part: 'snippet,contentDetails,status,statistics', chart: 'mostPopular', videoCategoryId: '10', maxResults: 50, regionCode: region,
    }))
    charge(COSTS.VIDEOS_LIST)
    const tracks = await scoreTrust((r.items ?? []).filter((v) => v.status?.embeddable !== false).map((v) => videoToTrack(v)))
    remember(tracks)
    return tracks
  })
}

interface PlaylistItemsResponse { items?: { snippet?: YtSnippet; contentDetails?: { videoId?: string } }[]; nextPageToken?: string }
interface PlaylistsResponse { items?: { id: string; snippet?: YtSnippet; contentDetails?: { itemCount?: number } }[] }

const plInflight = new Map<string, Promise<Track[]>>()

/**
 * A public YouTube playlist's songs (up to 200), cached for the day.
 *
 * Fast to open: a saved copy shows at once (refreshed in the background when it's old), and a new
 * playlist shows its first 50 songs after two round trips — `onPart` gets each longer prefix while
 * the rest of the pages load, with every page's song details fetched in parallel.
 */
export async function playlistTracks(playlistId: string, onPart?: (tracks: Track[]) => void): Promise<Track[]> {
  const key = `pl|${LIST_VERSION}${playlistId}`
  const hit = await idbGet<{ tracks: Track[]; fetchedAt: number }>(key, 'cache')
  const state = ytQuotaState()
  if (hit) {
    remember(hit.tracks)
    useUsage.getState().bump({ cacheHits: 1 })
    if (!cachePolicy.isFresh(hit.fetchedAt, state) && state !== 'EXHAUSTED' && !plInflight.has(playlistId)) void loadPlaylist(playlistId, key).catch(() => {})
    return hit.tracks
  }
  if (state === 'EXHAUSTED') throw new MusicError('quota', QUOTA_MSG)
  return loadPlaylist(playlistId, key, onPart)
}

function loadPlaylist(playlistId: string, key: string, onPart?: (tracks: Track[]) => void): Promise<Track[]> {
  const running = plInflight.get(playlistId)
  if (running) return running
  const job = (async () => {
    const seen = new Set<string>()
    const parts: Promise<Track[]>[] = []
    const done: (Track[] | null)[] = []
    let shown = 0
    // Emit the longest run of finished pages, in order.
    const emit = () => {
      let n = 0
      while (n < done.length && done[n]) n++
      if (n > shown && onPart) { shown = n; onPart(done.slice(0, n).flat() as Track[]) }
    }
    let token: string | undefined
    for (let page = 0; page < 4; page++) {
      // Only the video ids: the snippet (with full descriptions) made each page ~100 KB, for nothing.
      const r = await withRetry(() => api<PlaylistItemsResponse>('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, pageToken: token }))
      charge(COSTS.PLAYLIST_ITEMS)
      const ids = (r.items ?? []).map((i) => i.contentDetails?.videoId).filter((v): v is string => !!v && !seen.has(v))
      ids.forEach((v) => seen.add(v))
      const i = parts.length
      done.push(null)
      parts.push(videoDetails(ids).then((t) => { done[i] = t; emit(); return t }))
      token = r.nextPageToken
      if (!token) break
    }
    const tracks = (await Promise.all(parts)).flat()
    void idbSet(key, { tracks, fetchedAt: Date.now() }, 'cache')
    return tracks
  })()
  plInflight.set(playlistId, job)
  void job.finally(() => plInflight.delete(playlistId)).catch(() => {})
  return job
}

export async function playlistInfo(playlistId: string): Promise<RemotePlaylist | null> {
  const key = `plinfo|${playlistId}`
  const hit = await idbGet<RemotePlaylist>(key, 'cache')
  if (hit) return hit
  if (ytQuotaState() === 'EXHAUSTED') return null
  const r = await api<PlaylistsResponse>('playlists', { part: 'snippet,contentDetails', id: playlistId })
  charge(COSTS.CHANNELS_LIST)
  const p = r.items?.[0]
  if (!p) return null
  const info: RemotePlaylist = {
    id: `ytpl:${p.id}`,
    name: decodeEntities(p.snippet?.title ?? 'Playlist'),
    owner: decodeEntities(p.snippet?.channelTitle ?? ''),
    artworkUrl: bestThumb(p.snippet?.thumbnails),
    itemCount: p.contentDetails?.itemCount,
  }
  void idbSet(key, info, 'cache')
  return info
}

interface ChannelsResponse {
  items?: { id: string; snippet?: YtSnippet & { customUrl?: string }; brandingSettings?: { image?: { bannerExternalUrl?: string } }; statistics?: { subscriberCount?: string } }[]
}
export interface ChannelInfo { id: string; name: string; avatar?: string; banner?: string; subscribers?: number; description?: string }

export async function channelInfo(channelId: string): Promise<ChannelInfo | null> {
  const key = `ch|${channelId}`
  const hit = await idbGet<ChannelInfo>(key, 'cache')
  if (hit) return hit
  if (ytQuotaState() === 'EXHAUSTED') return null
  const r = await api<ChannelsResponse>('channels', { part: 'snippet,brandingSettings,statistics', id: channelId })
  charge(COSTS.CHANNELS_LIST)
  const c = r.items?.[0]
  if (!c) return null
  const banner = c.brandingSettings?.image?.bannerExternalUrl
  const info: ChannelInfo = {
    id: c.id,
    name: decodeEntities(c.snippet?.title ?? '').replace(/\s*-\s*Topic$/, ''),
    avatar: bestThumb(c.snippet?.thumbnails),
    banner: banner ? `${banner}=w2120-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj` : undefined,
    subscribers: c.statistics?.subscriberCount ? Number(c.statistics.subscriberCount) : undefined,
    description: c.snippet?.description?.slice(0, 600),
  }
  void idbSet(key, info, 'cache')
  return info
}

/** Resolves one video id (deep links, shared links) via videos.list (1 unit). */
export async function video(videoId: string): Promise<Track> {
  const [t] = await videoDetails([videoId])
  if (!t) throw new MusicError('unavailable', 'This video can’t be played here.')
  return t
}

export async function health(): Promise<{ ok: boolean; youtube: boolean } | null> {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' })
    if (!r.ok) return null
    return (await r.json()) as { ok: boolean; youtube: boolean }
  } catch {
    return null
  }
}
