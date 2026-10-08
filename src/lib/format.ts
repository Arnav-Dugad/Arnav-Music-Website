/** Formatting + YouTube title parsing — a faithful port of the app's `Formatters`. */

export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0 || !Number.isFinite(ms)) return '–:––'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

export function longDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0 && m > 0) return `${h} hr ${m} min`
  if (h > 0) return `${h} hr`
  return `${m} min`
}

export function compactCount(n: number): string {
  const f = (v: number, s: string) => `${v.toFixed(1).replace(/\.0$/, '')}${s}`
  if (n >= 1e9) return f(n / 1e9, 'B')
  if (n >= 1e6) return f(n / 1e6, 'M')
  if (n >= 1e3) return f(n / 1e3, 'K')
  return String(n)
}

export function relative(then: number, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - then) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 24 * 60) return `${Math.floor(min / 60)} hr ago`
  if (min < 2 * 24 * 60) return 'yesterday'
  if (min < 30 * 24 * 60) return `${Math.floor(min / (24 * 60))} days ago`
  if (min < 365 * 24 * 60) return `${Math.floor(min / (30 * 24 * 60))} mo ago`
  return `${Math.floor(min / (365 * 24 * 60))} yr ago`
}

/** ISO-8601 duration from YouTube ("PT4M13S") → ms. */
export function parseIsoDuration(iso: string | null | undefined): number | null {
  if (!iso) return null
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso.trim())
  if (!m) return null
  const total = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)
  return total === 0 ? null : total * 1000
}

export function greeting(hour: number): string {
  if (hour >= 5 && hour <= 11) return 'Good morning'
  if (hour >= 12 && hour <= 16) return 'Good afternoon'
  if (hour >= 17 && hour <= 21) return 'Good evening'
  return 'Late night'
}

const bracketNoise = /\s*[([](official|lyric|lyrics|lyrical|audio|video|music video|visualizer|hd|4k|mv|official audio|official music video|official video|full video|full song|video song|audio song)[^)\]]*[)\]]/gi
const segmentSeparators = /\s+(?:\|\|?|‖|•)\s+/
const capitalISeparator = /\s+I\s+/
const trailingNoise = /\s*[-–:]?\s*\b(official\s+)?(full\s+)?(lyric(al)?\s+video|lyrics?\s+video|video\s+song|audio\s+song|full\s+song|music\s+video|official\s+video|official\s+audio|lyrical|lyrics)\s*$/i
const segmentNoise = /(#|\b(songs?|music|video|lyric(al|s)?|latest|new|hits|telugu|hindi|tamil|kannada|malayalam|punjabi|marathi|bengali|bollywood|tollywood|kollywood|full|hd|4k|official|trending|audio|jukebox|(19|20)\d\d)\b)/i
const movieWords = /\s*\b(movie|film|songs?|ost)\b\s*/gi
const movieWordsTest = /\s*\b(movie|film|songs?|ost)\b\s*/i

const leadingNoise = /^\s*(full\s+(video\s+)?song|full\s+video|lyrical(\s+video)?|lyric\s+video|video\s+song|video|audio|official\s+(video|audio))\s*[:\-–|]\s*/i
const fullHd = /\s+(full\s+)?(hd|4k|1080p|720p)(\s+video)?(\s+song)?\s*$/i
const labelChannel = /^(t-series|yrf|sony music (india|south)|zee music|tips (official|music)|saregama|aditya music|lahari|speed records|times music|venus|eros now|shemaroo|think music|sun music|mango music|junglee music|desi music factory|white hill|saga music|universal music india|t-series [a-z]+|sony music)\b/i
export const isLabelChannel = (channel: string) => labelChannel.test(channel.trim())

export interface ParsedTitle {
  artist: string
  title: string
  album: string | null
  credits: string | null
}

/**
 * "Daft Punk - Get Lucky (Official Video) [4K]" → artist Daft Punk, title Get Lucky.
 * Label uploads chain context: "Narayanamma Lyric Video I Aadarsha Kutumbam I Venkatesh, Shriya"
 * → title Narayanamma, album Aadarsha Kutumbam, credits Venkatesh, Shriya (artist = channel).
 */
export function parseYouTubeTitle(raw: string, channel: string): ParsedTitle {
  const noBrackets = raw.replace(bracketNoise, '').replace(/\s+/g, ' ').trim()
  let segments = noBrackets.split(segmentSeparators).map((s) => s.trim()).filter(Boolean)
  if (segments.length === 1 && (segments[0].match(/\s+I\s+/g)?.length ?? 0) >= 2) {
    segments = segments[0].split(capitalISeparator).map((s) => s.trim()).filter(Boolean)
  }
  if (segments.length === 0) segments = [noBrackets || raw]

  const clean = (s: string) => {
    let c = s
    for (let i = 0; i < 2; i++) c = c.replace(trailingNoise, '').trim()
    return c
  }
  let titleIndex = segments.findIndex((s) => clean(s) !== '')
  if (titleIndex < 0) titleIndex = 0
  const cleaned = clean(segments[titleIndex]) || segments[titleIndex]
  const extras = segments
    .slice(titleIndex + 1)
    .filter((s) => !segmentNoise.test(s) || (movieWordsTest.test(s) && s.split(' ').length <= 5))
    .map((s) => s.replace(movieWords, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 2 && s.length <= 60 && !segmentNoise.test(s))

  const tidy = cleaned.replace(leadingNoise, '').replace(fullHd, '').replace(/^["“”']+|["“”']+$/g, '').trim() || cleaned
  const sep = /( - | – | — )/.exec(tidy)
  const parts = sep ? [tidy.slice(0, sep.index), tidy.slice(sep.index + sep[0].length)] : [tidy]
  const artistFromChannel = channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/, '').trim()
  const label = isLabelChannel(channel)
  let artist: string
  let title: string
  let labelAlbum: string | null = null
  if (parts.length === 2 && label && parts[0].trim() && parts[1].trim()) {
    // Label uploads write "Song - Movie": the channel is the label, not the singer.
    title = parts[0].trim()
    labelAlbum = parts[1].trim().slice(0, 60)
    artist = artistFromChannel || 'Unknown artist'
  } else if (parts.length === 2 && parts[0].length >= 1 && parts[0].length <= 60 && parts[1].trim() !== '') {
    artist = parts[0].trim()
    title = parts[1].trim()
  } else {
    artist = artistFromChannel || 'Unknown artist'
    title = tidy || raw
  }
  const album = labelAlbum ?? extras.find((e) => !e.includes(',')) ?? null
  const lists = extras.filter((e) => e !== album && e.includes(','))
  let credits = extras.find((e) => e !== album && (e.includes(',') || e.split(' ').length <= 4)) ?? null
  if (label && lists.length >= 2) {
    // "… | Cast A, Cast B | Singer A, Singer B": the last name list is the singers.
    artist = lists[lists.length - 1].split(',').map((x) => x.trim()).filter(Boolean).slice(0, 2).join(', ')
    credits = lists[0]
  }
  return { artist: decodeEntities(artist), title: decodeEntities(title), album: album ? decodeEntities(album) : null, credits: credits ? decodeEntities(credits) : null }
}

/** search.list snippets are HTML-escaped ("Guns N&#39; Roses"). */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
