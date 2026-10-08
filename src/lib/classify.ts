import { parseIsoDuration, parseYouTubeTitle, decodeEntities } from './format'
import type { MediaVariant, Track } from './types'
import { ytId } from './types'

/** Port of the app's TrackClassifier: keeps recommendations to real singles. */
const compilationPatterns = [
  String.raw`\bmix\b`, String.raw`\bmixes\b`, String.raw`mash\s?-?ups?`, String.raw`\bmegamix\b`, String.raw`non\s?-?stop`, String.raw`\bjukebox\b`,
  String.raw`\bcompilation\b`, String.raw`\bmedley\b`, String.raw`\bplaylist\b`, String.raw`back\s?to\s?back`, String.raw`\bb2b\b`, String.raw`full\s+album`,
  String.raw`album\s+collection`, String.raw`\bdj\s+set\b`, String.raw`\blive\s+set\b`, String.raw`\b\d+\s*(hours?|hrs?)\b`, String.raw`\b(one|two|three)\s+hours?\b`,
  String.raw`\btop\s+\d+\b`, String.raw`\btop\s+(hits|songs|tracks)\b`, String.raw`\bbest\s+of\b`, String.raw`\bhits\s+(of\s+)?(19|20)\d\d\b`,
  String.raw`\b(19|20)\d\d\s+(hits|mix|songs)\b`, String.raw`\bsongs\s+collection\b`, String.raw`\ball\s+songs\b`, String.raw`\bvideo\s+songs\s+jukebox\b`,
  String.raw`\b(workout|gym|motivation(al)?|study(ing)?|relaxing|sleep(ing)?|focus|meditation|background|lofi|lo-fi|chill|party|club|driving|coding)\s+(music|songs|beats|playlist)\b`,
  String.raw`\bmusic\s+for\s+(studying|sleep|work|focus|relaxation|coding)\b`, String.raw`\bradio\s*(24/7|live)\b`, String.raw`\b24/7\b`,
  String.raw`\bthrowback\s+(songs|hits)\b`, String.raw`\bsuper\s*hit\s+songs\b`, String.raw`\bplaylist\s+\d+\b`,
].map((p) => new RegExp(p, 'i'))

export const MAX_SINGLE_MS = 13 * 60_000
export const MIN_SINGLE_MS = 45_000

export function isCompilation(title: string, durationMs: number | null | undefined): boolean {
  if (durationMs != null && durationMs > MAX_SINGLE_MS) return true
  return compilationPatterns.some((r) => r.test(title))
}

export function isSingleTitle(title: string, durationMs: number | null | undefined): boolean {
  return !isCompilation(title, durationMs) && (durationMs == null || durationMs >= MIN_SINGLE_MS)
}

export function isSingle(t: Track): boolean {
  return !t.compilation && isSingleTitle([t.title, t.album].filter(Boolean).join(' '), t.durationMs)
}

const songHints = /\b(official\s+audio|audio\s+song|full\s+audio|\(audio\)|\[audio\]|art\s+track)\b/i
const videoHints = /\b(official\s+(music\s+)?video|music\s+video|lyric(al)?\s+video|full\s+video(\s+song)?|video\s+song|m\/v|\bmv\b)\b/i

/** SONG = audio/art-track upload ("Artist - Topic"), VIDEO = music/lyric video, null = unknown. */
export function variantOf(channelTitle: string, rawTitle: string): MediaVariant | null {
  const ch = channelTitle.trim()
  if (/- Topic$/i.test(ch)) return 'SONG'
  if (songHints.test(rawTitle)) return 'SONG'
  if (videoHints.test(rawTitle) || /VEVO$/i.test(ch)) return 'VIDEO'
  return null
}

/** Similarity of two song titles (0..1) for matching the same song across uploads. */
export function titleSimilarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((t) => t.length > 1))
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  ta.forEach((t) => { if (tb.has(t)) inter++ })
  return inter / Math.min(ta.size, tb.size)
}

/** Orders search results like YouTube Music: singles first, then the preferred upload type. */
export function rankForListening(tracks: Track[], prefer: MediaVariant): Track[] {
  return tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const s = (isSingle(a.t) ? 0 : 1) - (isSingle(b.t) ? 0 : 1)
      if (s) return s
      const v = (x: Track) => (x.variant === prefer ? 0 : x.variant == null ? 1 : 2)
      return v(a.t) - v(b.t) || a.i - b.i
    })
    .map((x) => x.t)
}

// ── MetadataEnricher ──────────────────────────────────────────────────────────
const genreLexicon: Record<string, string[]> = {
  lofi: ['lofi', 'lo-fi', 'lo fi'],
  edm: ['edm', 'house', 'techno', 'trance', 'dubstep', 'electronic', 'drum and bass', 'dnb'],
  'hip hop': ['hip hop', 'hip-hop', 'rap', 'trap', 'drill'],
  rock: ['rock', 'punk', 'grunge', 'alt rock'],
  metal: ['metal', 'metalcore', 'hardcore'],
  pop: ['pop', 'k-pop', 'kpop', 'dance pop'],
  'r&b': ['r&b', 'rnb', 'soul', 'neo soul'],
  jazz: ['jazz', 'bossa', 'swing'],
  classical: ['classical', 'symphony', 'orchestra', 'sonata', 'concerto'],
  ambient: ['ambient', 'drone', 'meditation', 'sleep music'],
  acoustic: ['acoustic', 'unplugged', 'piano cover', 'guitar cover'],
  indie: ['indie', 'bedroom pop', 'dream pop', 'shoegaze'],
  bollywood: ['bollywood', 'hindi', 'filmi', 'punjabi'],
  latin: ['reggaeton', 'latin', 'bachata', 'salsa'],
  synthwave: ['synthwave', 'retrowave', 'outrun', 'vaporwave'],
  soundtrack: ['soundtrack', 'ost', 'score', 'theme'],
  country: ['country', 'bluegrass'],
  folk: ['folk'],
}
const genreEnergy: Record<string, number> = {
  lofi: 0.3, edm: 0.85, 'hip hop': 0.7, rock: 0.75, metal: 0.92, pop: 0.65, 'r&b': 0.5, jazz: 0.4, classical: 0.3,
  ambient: 0.15, acoustic: 0.3, indie: 0.5, bollywood: 0.6, latin: 0.75, synthwave: 0.6, soundtrack: 0.45, country: 0.55, folk: 0.35,
}
const energyUp = ['remix', 'workout', 'gym', 'hype', 'party', 'bass boosted', 'festival', 'anthem', 'sped up', 'nightcore']
const energyDown = ['slowed', 'reverb', 'sleep', 'calm', 'relax', 'chill', 'piano', 'acoustic', 'lullaby', 'study']
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const genreRegexes = Object.entries(genreLexicon).map(([g, ws]) => [g, ws.map((w) => new RegExp(`\\b${escape(w)}\\b`))] as const)

export function genresFor(title: string, tags: string[], description = ''): string[] {
  const text = `${title} ${tags.join(' ')} ${description.slice(0, 300)}`.toLowerCase()
  return genreRegexes.filter(([, rs]) => rs.some((r) => r.test(text))).map(([g]) => g).slice(0, 3)
}

export function energyFor(title: string, tags: string[], genres: string[]): number | null {
  const text = `${title} ${tags.join(' ')}`.toLowerCase()
  const bases = genres.map((g) => genreEnergy[g]).filter((v): v is number => v != null)
  const base = bases.length ? bases.reduce((a, b) => a + b, 0) / bases.length : null
  const up = energyUp.filter((w) => text.includes(w)).length
  const down = energyDown.filter((w) => text.includes(w)).length
  if (base == null && up === 0 && down === 0) return null
  return Math.min(0.98, Math.max(0.05, (base ?? 0.55) + 0.12 * up - 0.12 * down))
}

// ── YouTube API → Track ───────────────────────────────────────────────────────
export interface YtThumbs {
  default?: { url?: string }
  medium?: { url?: string }
  high?: { url?: string }
  standard?: { url?: string }
  maxres?: { url?: string }
}
export interface YtSnippet {
  title?: string
  channelTitle?: string
  channelId?: string
  description?: string
  publishedAt?: string
  thumbnails?: YtThumbs
  tags?: string[]
  liveBroadcastContent?: string
  videoOwnerChannelTitle?: string
  resourceId?: { videoId?: string }
}
export interface YtVideo {
  id: string
  snippet?: YtSnippet
  contentDetails?: { duration?: string }
  status?: { embeddable?: boolean; privacyStatus?: string }
  statistics?: { viewCount?: string }
}

export const bestThumb = (t?: YtThumbs) => (t?.maxres ?? t?.standard ?? t?.high ?? t?.medium ?? t?.default)?.url
export const smallThumb = (t?: YtThumbs) => (t?.medium ?? t?.high ?? t?.default)?.url

/** Maps a videos.list item to an Arnav track (label-title parsing, Song/Video variant, compilation flag). */
export function videoToTrack(v: YtVideo): Track {
  const sn = v.snippet ?? {}
  const rawTitle = decodeEntities(sn.title ?? '')
  const channel = decodeEntities(sn.channelTitle ?? '')
  const parsed = parseYouTubeTitle(rawTitle, channel)
  const tags = sn.tags ?? []
  const genres = genresFor(rawTitle, tags, sn.description ?? '')
  const dur = parseIsoDuration(v.contentDetails?.duration)
  return {
    id: ytId(v.id),
    title: parsed.title,
    artist: parsed.artist,
    album: parsed.album,
    credits: parsed.credits,
    variant: variantOf(channel, rawTitle),
    compilation: isCompilation(rawTitle, dur),
    durationMs: dur,
    artworkUrl: bestThumb(sn.thumbnails) ?? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    playbackRef: v.id,
    channelId: sn.channelId ?? null,
    genres,
    energy: energyFor(rawTitle, tags, genres),
    year: sn.publishedAt ? Number(sn.publishedAt.slice(0, 4)) || null : null,
  }
}

/** Square-ish, high quality artwork for a YouTube video id. */
export function artworkFor(t: Pick<Track, 'artworkUrl' | 'playbackRef'>, size: 'sm' | 'lg' = 'lg'): string {
  const url = t.artworkUrl
  if (url && !url.includes('ytimg.com')) return url
  if (size === 'sm') return `https://i.ytimg.com/vi/${t.playbackRef}/mqdefault.jpg`
  return url ?? `https://i.ytimg.com/vi/${t.playbackRef}/hqdefault.jpg`
}
