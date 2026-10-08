import { idbGet, idbSet } from './idb'
import { cacheKey, isRemoteWorthy } from './query'
import { cachePolicy, COSTS, quotaState, useUsage, type QuotaState } from './usage'
import { bestThumb, videoToTrack, type YtSnippet, type YtVideo } from './classify'
import { decodeEntities } from './format'
import { MusicError, artistKey, type Artist, type Track } from './types'
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
const CACHE_VERSION = 'v3|'
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
  let r: Response
  try {
    r = await fetch(`/api/yt?${qs.toString()}`, { headers })
  } catch {
    throw new MusicError('offline', 'You appear to be offline.')
  }
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

/** videos.list for up to 50 ids — 1 unit. Filters to embeddable, non-live uploads. */
export async function videoDetails(ids: string[]): Promise<Track[]> {
  if (ids.length === 0) return []
  const out: Track[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const r = await withRetry(() => api<VideosResponse>('videos', { part: 'snippet,contentDetails,status', id: chunk.join(',') }))
    charge(COSTS.VIDEOS_LIST)
    out.push(
      ...(r.items ?? [])
        .filter((v) => v.status?.embeddable !== false && v.snippet?.liveBroadcastContent !== 'live')
        .map(videoToTrack),
    )
  }
  const order = new Map(ids.map((id, i) => [id, i]))
  out.sort((a, b) => (order.get(a.playbackRef) ?? 0) - (order.get(b.playbackRef) ?? 0))
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
  const tracks = await videoDetails(videoIds)
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
  return cachedList(`chart|${region}`, async () => {
    const r = await withRetry(() => api<VideosResponse>('videos', {
      part: 'snippet,contentDetails,status', chart: 'mostPopular', videoCategoryId: '10', maxResults: 50, regionCode: region,
    }))
    charge(COSTS.VIDEOS_LIST)
    const tracks = (r.items ?? []).filter((v) => v.status?.embeddable !== false).map(videoToTrack)
    remember(tracks)
    return tracks
  })
}

interface PlaylistItemsResponse { items?: { snippet?: YtSnippet; contentDetails?: { videoId?: string } }[]; nextPageToken?: string }
interface PlaylistsResponse { items?: { id: string; snippet?: YtSnippet; contentDetails?: { itemCount?: number } }[] }

/** A public YouTube playlist's songs (up to 200), cached for the day. */
export function playlistTracks(playlistId: string): Promise<Track[]> {
  return cachedList(`pl|${playlistId}`, async () => {
    const ids: string[] = []
    let token: string | undefined
    for (let page = 0; page < 4; page++) {
      const r = await withRetry(() => api<PlaylistItemsResponse>('playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: 50, pageToken: token }))
      charge(COSTS.PLAYLIST_ITEMS)
      ids.push(...(r.items ?? []).map((i) => i.contentDetails?.videoId).filter((v): v is string => !!v))
      token = r.nextPageToken
      if (!token) break
    }
    return videoDetails([...new Set(ids)])
  })
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
