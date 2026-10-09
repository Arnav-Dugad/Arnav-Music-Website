/**
 * Pure matching helpers shared by the app and the edge API (no storage, no settings): artist
 * credits that overlap, remix / live / cover variants, and choosing the same song as another kind
 * of upload (the official music video for an audio track, or the reverse).
 */
import type { MediaVariant, Track } from './types'
import { isSingle, titleSimilarity } from './classify'
import { cleanTitle } from './lyrics'

export const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const artistsOf = (s: string) => s.split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?|\band\b)\s*/i).map(words).filter(Boolean)

/** Remixes, reprises, covers… — another recording than the original song. */
export const VARIANT = /\b(remix|reprise|live|acoustic|instrumental|karaoke|lo-?fi|slowed|reverb|sped|version|unplugged|cover|mashup|female|male|duet|sad|8d|recreated|revisited|extended|edit|mix)\b/i

/** Do two artist credits share a name? ("Tanishk Bagchi, Asees Kaur" ~ "Asees Kaur & Tanishk Bagchi") */
export function artistOverlap(a: string, b: string): boolean {
  const x = artistsOf(a)
  const y = artistsOf(b)
  // Same name, one inside the other, or the same distinctive first name ("Sachet Tandon" / "Sachet-Parampara").
  const first = (s: string) => s.split(' ')[0]
  return x.some((n) => y.some((m) => n === m || (n.length >= 5 && (m.includes(n) || n.includes(m))) || (first(n).length >= 5 && first(n) === first(m))))
}

/** The search that finds a song's other upload: fixed per song and mode, so caches answer it for everyone. */
export function counterpartQuery(track: Pick<Track, 'title' | 'artist' | 'artistFromChannel'>, want: MediaVariant | null): string {
  const title = cleanTitle(track.title)
  const base = `${track.artistFromChannel ? '' : track.artist.split(',')[0]} ${title}`.trim().slice(0, 90)
  return want === 'VIDEO' ? `${base} official video` : want === 'SONG' ? `${base} audio` : base
}

/** Ranks other uploads of a song for Song / Video mode (pure, so it can be tested). */
export function pickCounterpart(track: Track, want: MediaVariant | null, pool: Track[], exclude: Set<string> = new Set()): Track | null {
  const title = cleanTitle(track.title)
  const variantAsked = VARIANT.test(track.rawTitle ?? track.title)
  const score = (c: Track) => {
    const raw = c.rawTitle ?? c.title
    let s = 40 * titleSimilarity(cleanTitle(c.title), title)
    if (want) s += c.variant === want ? 40 : c.variant == null ? 8 : -60
    if (want === 'VIDEO') {
      // A real music video beats a lyric video or a static "visualizer".
      if (/official\s+(music\s+)?video|\bm\/?v\b|music video|video song|full video/i.test(raw)) s += 18
      if (/lyric|lyrical|visuali[sz]er|audio/i.test(raw)) s -= 30
      if (/VEVO$/i.test(c.channelTitle ?? '')) s += 10
    }
    if (artistOverlap(c.artist, `${track.artist}, ${track.credits ?? ''}`) || (track.artistFromChannel && c.channelTitle === track.channelTitle)) s += 16
    s += 6 * (c.trust ?? 1)
    if (track.durationMs && c.durationMs) {
      // A music video can run longer (intro scenes) but not much shorter than the song.
      const extra = (c.durationMs - track.durationMs) / 1000
      s -= want === 'VIDEO' ? (extra < -30 ? 25 : extra > 150 ? 20 : 0) : Math.min(30, Math.abs(extra) / 3)
    }
    return s
  }
  const candidates = pool.filter((c) =>
    c.id !== track.id && c.playbackRef !== track.playbackRef && !exclude.has(c.playbackRef) && isSingle(c) &&
    titleSimilarity(cleanTitle(c.title), title) >= 0.6 && (variantAsked || !VARIANT.test(c.rawTitle ?? c.title)) &&
    (!c.durationMs || c.durationMs >= 60_000))
  const best = candidates.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s)[0]
  if (!best || best.s < 40) return null
  return want == null || best.c.variant === want || best.c.variant == null ? best.c : null
}
