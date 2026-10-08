/**
 * Free music-data sources on the client:
 *  - iTunes Search API (albums, tracklists, the audio release's exact length) — called from the
 *    browser with JSONP because Apple rate-limits shared cloud IPs and sends no CORS headers;
 *  - the edge API for credits (/api/credits), community lyric timing (/api/community) and the
 *    artist/film names every visitor's Topic results taught the server (/api/known).
 */
import { idbGet, idbSet } from './idb'
import { regionCode } from '../state/settings'
import type { CreditEntry } from './credits'
import type { Track } from './types'

// ── iTunes ──────────────────────────────────────────────────────────────────
export interface ItunesItem {
  type: 'album' | 'song' | 'artist'
  id: number | null
  collectionId: number | null
  title: string | null
  album: string | null
  artist: string | null
  artistId: number | null
  durationMs: number | null
  trackNumber: number | null
  discNumber: number | null
  trackCount: number | null
  releaseDate: string | null
  genre: string | null
  explicit: boolean
  artwork: string | null
  url: string | null
}

function compact(r: Record<string, unknown>): ItunesItem {
  const art = typeof r.artworkUrl100 === 'string' ? r.artworkUrl100 : null
  return {
    type: r.wrapperType === 'collection' ? 'album' : r.wrapperType === 'artist' ? 'artist' : 'song',
    id: (r.trackId ?? r.collectionId ?? r.artistId ?? null) as number | null,
    collectionId: (r.collectionId ?? null) as number | null,
    title: (r.trackName ?? r.collectionName ?? r.artistName ?? null) as string | null,
    album: (r.collectionName ?? null) as string | null,
    artist: (r.artistName ?? null) as string | null,
    artistId: (r.artistId ?? null) as number | null,
    durationMs: (r.trackTimeMillis ?? null) as number | null,
    trackNumber: (r.trackNumber ?? null) as number | null,
    discNumber: (r.discNumber ?? null) as number | null,
    trackCount: (r.trackCount ?? null) as number | null,
    releaseDate: typeof r.releaseDate === 'string' ? r.releaseDate.slice(0, 10) : null,
    genre: (r.primaryGenreName ?? null) as string | null,
    explicit: r.trackExplicitness === 'explicit' || r.collectionExplicitness === 'explicit',
    artwork: art ? art.replace(/\/\d+x\d+bb\./, '/1200x1200bb.') : null,
    url: (r.trackViewUrl ?? r.collectionViewUrl ?? r.artistLinkUrl ?? null) as string | null,
  }
}

let jsonpSeq = 0
let lastItunes = 0
function jsonp<T>(url: string, timeoutMs = 9000): Promise<T> {
  return new Promise((resolve, reject) => {
    const cb = `__arnavItunes${Date.now().toString(36)}${++jsonpSeq}`
    const s = document.createElement('script')
    const w = window as unknown as Record<string, unknown>
    const done = () => { clearTimeout(timer); delete w[cb]; s.remove() }
    const timer = setTimeout(() => { done(); reject(new Error('iTunes timed out')) }, timeoutMs)
    w[cb] = (data: T) => { done(); resolve(data) }
    s.src = `${url}&callback=${cb}`
    s.async = true
    s.onerror = () => { done(); reject(new Error('iTunes failed')) }
    document.head.appendChild(s)
  })
}

async function itunes(path: 'search' | 'lookup', params: Record<string, string | number>): Promise<ItunesItem[]> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
  const key = `it|v1|${path}?${qs}`
  const hit = await idbGet<{ items: ItunesItem[]; at: number }>(key, 'cache')
  if (hit && Date.now() - hit.at < 14 * 86_400_000) return hit.items
  // Apple allows ~20 requests a minute: space them out.
  const wait = lastItunes + 400 - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastItunes = Date.now()
  const data = await jsonp<{ results?: Record<string, unknown>[] }>(`https://itunes.apple.com/${path}?${qs}`)
  const items = (data.results ?? []).map(compact)
  void idbSet(key, { items, at: Date.now() }, 'cache')
  return items
}

const country = () => regionCode()

export const itunesAlbums = (artist: string, limit = 25) =>
  itunes('search', { term: artist, media: 'music', entity: 'album', attribute: 'artistTerm', limit, country: country() })
export const itunesAlbumSearch = (term: string, limit = 10) =>
  itunes('search', { term, media: 'music', entity: 'album', limit, country: country() })
export async function itunesAlbum(collectionId: number): Promise<{ album: ItunesItem | null; tracks: ItunesItem[] }> {
  const items = await itunes('lookup', { id: collectionId, entity: 'song', country: country(), limit: 200 })
  return { album: items.find((i) => i.type === 'album') ?? null, tracks: items.filter((i) => i.type === 'song').sort((a, b) => (a.discNumber ?? 1) - (b.discNumber ?? 1) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0)) }
}

const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const artistsOf = (s: string) => s.split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?|\band\b)\s*/i).map(words).filter(Boolean)

/** Remixes, reprises, covers… — another recording than the original song. */
export const VARIANT = /\b(remix|reprise|live|acoustic|instrumental|karaoke|lo-?fi|slowed|reverb|sped|version|unplugged|cover|mashup|female|male|duet|sad|8d|recreated|revisited|extended|edit|mix)\b/i
/** Same song title both ways ("Bekhayali" ≠ "Bekhayali Reprise"). */
function sameTitle(a: string, b: string): boolean {
  const x = new Set(words(a.replace(/\s*[([](?:from|feat|ft|with)\b[^)\]]*[)\]]/gi, '')).split(' ').filter((w) => w.length > 1))
  const y = new Set(words(b).split(' ').filter((w) => w.length > 1))
  if (!x.size || !y.size) return false
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.max(x.size, y.size) >= 0.75
}

/** Do two artist credits share a name? ("Tanishk Bagchi, Asees Kaur" ~ "Asees Kaur & Tanishk Bagchi") */
export function artistOverlap(a: string, b: string): boolean {
  const x = artistsOf(a)
  const y = artistsOf(b)
  // Same name, one inside the other, or the same distinctive first name ("Sachet Tandon" / "Sachet-Parampara").
  const first = (s: string) => s.split(' ')[0]
  return x.some((n) => y.some((m) => n === m || (n.length >= 5 && (m.includes(n) || n.includes(m))) || (first(n).length >= 5 && first(n) === first(m))))
}

/** The audio release of a YouTube song (exact title, length, album) — null when unsure. */
export async function itunesMatch(t: Track): Promise<ItunesItem | null> {
  const key = `itm|v3|${t.id}`
  const hit = await idbGet<{ item: ItunesItem | null; at: number }>(key, 'cache')
  if (hit && (hit.item || Date.now() - hit.at < 7 * 86_400_000)) return hit.item
  const title = t.title.replace(/\s*[([].*?[)\]]\s*/g, ' ').trim()
  let item: ItunesItem | null = null
  try {
    const results = await itunes('search', { term: `${title} ${t.artist.split(',')[0]}`, media: 'music', entity: 'song', limit: 15, country: country() })
    item = results
      .filter((r) => r.title && sameTitle(r.title, title) && !!r.artist && artistOverlap(r.artist, `${t.artist}, ${t.credits ?? ''}`))
      .filter((r) => !VARIANT.test(r.title ?? '') || VARIANT.test(t.rawTitle ?? t.title))
      .sort((a, b) => {
        const d = t.durationMs ?? 0
        return d ? Math.abs((a.durationMs ?? 1e9) - d) - Math.abs((b.durationMs ?? 1e9) - d) : 0
      })[0] ?? null
    // A music video can run longer than the song (intro scenes), never much shorter.
    if (item && t.durationMs && item.durationMs && (item.durationMs - t.durationMs > 15_000 || t.durationMs - item.durationMs > 75_000)) item = null
  } catch {
    return null // offline / blocked: try again next time
  }
  void idbSet(key, { item, at: Date.now() }, 'cache')
  return item
}

// ── Edge API ────────────────────────────────────────────────────────────────
export interface FilmInfo { id: string; title: string; year: number | null; description: string | null; wiki: string | null; imdb: string | null; image: string | null; director: { name: string; wiki: string | null }[]; cast: { name: string; wiki: string | null }[]; composer: { name: string; wiki: string | null }[]; producer: { name: string; wiki: string | null }[] }
export interface CreditsResult {
  v: number
  video: { title: string; channel: string; published: string | null } | null
  parsed: { title: string; artist: string; album: string | null } | null
  entries: CreditEntry[]
  film: FilmInfo | null
  audio: { bpm: number | null; gainDb: number | null; link: string | null } | null
  mbid: string | null
  lyrics: string | null
  sources: string[]
}

export async function fetchCredits(t: Track): Promise<CreditsResult | null> {
  const key = `cr|v4|${t.playbackRef}`
  const hit = await idbGet<{ r: CreditsResult; at: number }>(key, 'cache')
  if (hit && Date.now() - hit.at < 14 * 86_400_000) return hit.r
  const qs = new URLSearchParams({ v: t.playbackRef, t: t.title, a: t.artist, ...(t.album ? { al: t.album } : {}), ...(t.durationMs ? { d: String(Math.round(t.durationMs)) } : {}) })
  const res = await fetch(`/api/credits?${qs.toString()}`).catch(() => null)
  if (!res?.ok) return hit?.r ?? null
  const r = (await res.json()) as CreditsResult
  void idbSet(key, { r, at: Date.now() }, 'cache')
  return r
}

export interface CommunityTiming { choice: string | null; votes: number; offsetMs: number | null; scale: number | null; samples: number }

export async function fetchCommunity(videoId: string): Promise<CommunityTiming | null> {
  try {
    const r = await fetch(`/api/community?v=${encodeURIComponent(videoId)}`)
    return r.ok ? ((await r.json()) as CommunityTiming) : null
  } catch { return null }
}

/** Shares your lyrics fix (version / timing) so the next listener gets it right away. */
export async function shareCommunity(videoId: string, choice: string, offsetMs?: number, scale?: number): Promise<void> {
  try {
    await fetch('/api/community', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: videoId, choice, offsetMs, scale }) })
  } catch { /* best effort */ }
}

/** Names learned from every visitor's YouTube Topic results (artists, films). */
export async function fetchKnownNames(): Promise<{ artists: string[]; films: string[] } | null> {
  const key = 'known|v1'
  const hit = await idbGet<{ r: { artists: string[]; films: string[] }; at: number }>(key, 'cache')
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.r
  try {
    const res = await fetch('/api/known')
    if (!res.ok) return hit?.r ?? null
    const r = (await res.json()) as { artists: string[]; films: string[] }
    void idbSet(key, { r, at: Date.now() }, 'cache')
    return r
  } catch { return hit?.r ?? null }
}
