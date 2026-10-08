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
const segmentSeparators = /\s*(?:\|\|?|‖)\s*|\s+•\s+/
const capitalISeparator = /\s+I\s+/
const trailingNoise = /\s*[-–:]?\s*\b(official\s+)?(full\s+)?(lyric(al)?\s+video|lyrics?\s+video|video\s+song|audio\s+song|full\s+song|music\s+video|official\s+video|official\s+audio|lyrical|lyrics)\s*$/i
const segmentNoise = /(#|\b(songs?|music|video|lyric(al|s)?|latest|new|hits|telugu|hindi|tamil|kannada|malayalam|punjabi|marathi|bengali|bollywood|tollywood|kollywood|full|hd|4k|official|trending|audio|jukebox|(19|20)\d\d)\b)/i
const movieWords = /\s*\b(movie|film|songs?|ost)\b\s*/gi
const movieWordsTest = /\s*\b(movie|film|songs?|ost)\b\s*/i

const leadingNoise = /^\s*(full\s+(video\s+)?song|full\s+(video|audio)|lyrical(\s+video)?|lyric\s+video|(video|audio)\s+song|video|audio|official\s+(video|audio))\s*[:\-–|]\s*/i
const fullHd = /\s+(full\s+)?(hd|uhd|[248]k|1080p|720p|2160p)(\s+video)?(\s+song)?\s*$/i
const labelChannel = /^(t-series|yrf|sony music (india|south)|zee music|tips (official|music)|saregama|aditya music|lahari|speed records|times music|venus|eros now|shemaroo|think music|sun music|mango music|junglee music|desi music factory|white hill|saga music|universal music india|t-series [a-z]+|sony music)\b/i
export const isLabelChannel = (channel: string) => labelChannel.test(channel.trim())

export interface ParsedTitle {
  artist: string
  title: string
  album: string | null
  credits: string | null
  /** True when the title named no artist, so the channel name stood in for one. */
  fromChannel: boolean
}

/**
 * "Daft Punk - Get Lucky (Official Video) [4K]" → artist Daft Punk, title Get Lucky.
 * Label uploads chain context: "Narayanamma Lyric Video I Aadarsha Kutumbam I Venkatesh, Shriya"
 * → title Narayanamma, album Aadarsha Kutumbam, credits Venkatesh, Shriya (artist = channel).
 */
/** Bumped whenever parsing changes, so cached tracks are read again (shared with the edge API). */
export const PARSE_V = 10

export interface ParseContext {
  /** Film / album names learned from Topic descriptions and iTunes soundtracks. */
  isKnownFilm?: (name: string) => boolean
  /** Names known to be artists (Topic channels, artist channels, your library). */
  isKnownArtist?: (name: string) => boolean
  /** The search that found the upload: a name you searched for is probably the artist. */
  query?: string
}

const PURE_NOISE = /^(video|audio|lyrics?|lyrical|full\s+song|full\s+video|video\s+song|official(\s+(music\s+)?(video|audio))?|music\s+video|hd|4k|new\s+song|latest)$/i
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s*/i
const FILM_YEAR = /\s+\(?(?:19|20)\d\d\)?$/
/** "Wedding Song 2021", "Sad Songs": describes the song, not a film. */
const SONG_KIND = /\b(wedding|party|romantic|sad|love|dance|bhangra|punjabi|hindi|tamil|telugu|new|latest|hit|super\s*hit|festival|holi|diwali|navratri|garba|devotional|bhajan|rap|lofi|workout|birthday)\s+(songs?|track|anthem)\b/i
/** Looks like a person's name ("Stebin Ben", "Asees Kaur", "Sachet-Parampara"). */
const nameLike = (s: string) => /^[\p{L}][\p{L}.'-]*(\s+[\p{L}][\p{L}.'-]*){0,3}$/u.test(s.trim().replace(/\s*[-–]\s*/g, '-')) && !/\d/.test(s)
const splitNames = (s: string) => s.split(/\s*,\s*|\s+&\s+|\s+(?:feat\.?|ft\.?|featuring)\s*/i).map((x) => x.trim()).filter(Boolean)
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())

/**
 * Who sang a soundtrack song, from the segments after the film:
 * "Cast A, Cast B | Director | Singer | Lyricist", "Composer Feat. Singer | Cast", "Singer | Cast A, Cast B",
 * "Cast A | Cast B | Singer" (no cast list). Returns null when nothing looks like a singer.
 */
function filmCredits(segs: string[], known: (s: string) => boolean): { singers: string[]; cast: string | null } | null {
  if (!segs.length) return null
  const castIdx = segs.findIndex((s) => s.includes(',') && !FEAT.test(s))
  const cast = castIdx >= 0 ? segs[castIdx] : null
  const featSeg = segs.find((s) => FEAT.test(s))
  if (featSeg) return { singers: splitNames(featSeg).slice(0, 3), cast }
  // A name between the film and the cast list is the singer ("Bekhayali | Kabir Singh | Arijit Singh | Shahid K, Kiara A").
  const before = castIdx > 0 ? segs.slice(0, castIdx).filter(nameLike) : []
  if (before.length) return { singers: before.slice(0, 2), cast }
  const after = castIdx >= 0 ? segs.slice(castIdx + 1) : segs
  const lists = after.filter((s) => s.includes(','))
  if (lists.length) return { singers: splitNames(lists[lists.length - 1]).slice(0, 2), cast }
  const names = after.filter(nameLike).map((s) => s.replace(/\s+[-–]\s+/g, '-'))
  const knownNames = names.filter(known)
  if (knownNames.length) return { singers: knownNames.slice(0, 2), cast: cast ?? (names.filter((n) => !knownNames.includes(n)).join(', ') || null) }
  if (!names.length) return null
  if (castIdx < 0) {
    // "Song - Film | Actor | Actress | Singer": the singer comes last.
    return names.length >= 3 ? { singers: [names[names.length - 1]], cast: names.slice(0, -1).join(', ') } : { singers: [names[0]], cast: names.slice(1).join(', ') || null }
  }
  // After the cast: "Director | Singer | Lyricist" or "Singer | Composer".
  return { singers: [names.length >= 3 ? names[1] : names[0]], cast }
}

export function parseYouTubeTitle(raw: string, channel: string, ctx: ParseContext = {}): ParsedTitle {
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
  // The song is the first segment that is more than a noise word ("Video | Babul Da Vehda | …").
  let titleIndex = segments.findIndex((s) => clean(s) !== '' && !PURE_NOISE.test(s.replace(/[:\s]+$/, '')))
  if (titleIndex < 0) titleIndex = segments.findIndex((s) => clean(s) !== '')
  if (titleIndex < 0) titleIndex = 0
  const cleaned = clean(segments[titleIndex]) || segments[titleIndex]
  // "Bhoomi 2023" / "Kabir Singh Movie Songs": a film named with its year or as a film.
  const filmMarked = (s: string) => (movieWordsTest.test(s) || FILM_YEAR.test(s)) && !SONG_KIND.test(s) && s.split(' ').length <= 5
  const extraSegs = segments
    .slice(titleIndex + 1)
    .filter((s) => !segmentNoise.test(s) || filmMarked(s))
    .map((s) => ({ text: s.replace(movieWords, ' ').replace(FILM_YEAR, '').replace(/\s+/g, ' ').trim(), film: filmMarked(s) }))
    .filter((s) => s.text.length >= 2 && s.text.length <= 60 && !segmentNoise.test(s.text))
  const extras = extraSegs.map((s) => s.text)

  const label = isLabelChannel(channel)
  // An artist's channel stands in for the artist ("Salim Sulaiman Music" → Salim Sulaiman); a label keeps its name.
  const artistFromChannel = (label ? channel : channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/, '').replace(/\s+(official|music|tv)$/i, '')).trim() || channel.trim()
  const q = ctx.query ? squash(ctx.query) : ''
  // Named in a credits list ("A, B" / "A & B") elsewhere in the title.
  const mentioned = (s: string) => extras.some((e) => /,|\s&\s/.test(e) && e.split(/\s*,\s*|\s+&\s+/).some((n) => squash(n) === squash(s)))
  const knownArtist = (s: string) => {
    const k = squash(s)
    return k.length >= 3 && !ctx.isKnownFilm?.(s) && (!!ctx.isKnownArtist?.(s) || (q.length > 0 && q.includes(k)) || mentioned(s))
  }
  // "Song | Singer | Singer | Actor | Composer": a credits list, not an album.
  const singleNames = extraSegs.filter((s) => !s.film && !/,|\s&\s/.test(s.text) && nameLike(s.text)).map((s) => s.text)
  const ownName = (n: string) => squash(n) === squash(artistFromChannel)
  const creditsStyle = singleNames.length >= 3 || (singleNames.length >= 2 && (singleNames.every(knownArtist) || singleNames.some(ownName)))

  let tidy = cleaned.replace(leadingNoise, '').replace(fullHd, '').replace(/\s+[-–—:]\s*(official\s+)?(video|audio|lyrics?|lyric\s+video)\s*$/i, '').replace(/^["“”']+|["“”']+$/g, '').trim() || cleaned
  // "ARIJIT SINGH VERSION: Bekhayali" → "Bekhayali (Arijit Singh Version)" by Arijit Singh.
  let versionArtist: string | null = null
  const version = /^(.{2,40}?)\s+version\s*:\s*(.{2,})$/i.exec(tidy)
  if (version && nameLike(version[1])) {
    versionArtist = titleCase(version[1].trim())
    tidy = `${version[2].trim()} (${versionArtist} Version)`
  }
  // "Remix: Bekhayali" → "Bekhayali (Remix)".
  const variant = /^(remix|unplugged|reprise|lo-?fi|acoustic|female\s+version|male\s+version)\s*:\s*(.{2,})$/i.exec(tidy)
  if (variant) tidy = `${variant[2].trim()} (${titleCase(variant[1].trim())})`
  // Label "Film : Song" ("Kabir Singh : Kaise Hua Song").
  let colonFilm: string | null = null
  const filmColon = label ? /^([^:]{2,40}?)\s*:\s*(.{2,60}?)\s+song$/i.exec(tidy) : null
  if (filmColon) { colonFilm = filmColon[1].trim(); tidy = filmColon[2].trim() }
  // "Song: Artist feat. X" — the colon separates the song from its artists.
  let colonArtist: string | null = null
  const colon = /^([^:]{2,50}):\s+(.{2,80})$/.exec(tidy)
  if (colon && (/\b(feat\.?|ft\.?)\s/i.test(colon[2]) || knownArtist(colon[2]))) { tidy = colon[1].trim(); colonArtist = colon[2].trim() }
  const sep = /( - | – | — | ‒ | ― | ‐ )/.exec(tidy)
  const parts = sep ? [tidy.slice(0, sep.index), tidy.slice(sep.index + sep[0].length)] : [tidy]
  let artist: string
  let title: string
  let labelAlbum: string | null = null
  let fromChannel = false
  // "Madhanya - Rahul Vaidya & Disha Parmar": the right side is two full names, not a film.
  const bothNames = (s: string) => { const n = s.split(/\s*&\s*|\s*,\s*/); return n.length >= 2 && n.every((x) => x.trim().split(/\s+/).length >= 2 && nameLike(x)) }
  if (colonArtist) {
    artist = colonArtist
    title = tidy
  } else if (parts.length === 2 && label && parts[0].trim() && parts[1].trim() && bothNames(parts[1])) {
    artist = parts[1].trim()
    title = parts[0].trim()
  } else if (parts.length === 2 && label && parts[0].trim() && parts[1].trim() && knownArtist(parts[0]) && !knownArtist(parts[1])) {
    // Label upload written "Artist - Song" (e.g. "Asees Kaur - Baarish").
    artist = parts[0].trim()
    title = parts[1].trim()
  } else if (parts.length === 2 && label && parts[0].trim() && parts[1].trim()) {
    // Label uploads write "Song - Movie": the channel is the label, not the singer.
    title = parts[0].trim()
    labelAlbum = parts[1].trim().slice(0, 60)
    artist = artistFromChannel || 'Unknown artist'
    fromChannel = true
  } else if (parts.length === 2 && parts[0].length >= 1 && parts[0].length <= 60 && parts[1].trim() !== '') {
    artist = parts[0].trim()
    title = parts[1].trim()
  } else {
    artist = artistFromChannel || 'Unknown artist'
    title = tidy || raw
    fromChannel = true
  }
  // A segment that names a known artist (or the singer) is a credit, not an album. In a
  // credits-style title only a segment marked as a film ("… Movie Songs") is an album.
  // T-Series style "Song | Film | Cast A, Cast B | Singers": the segment right after the song is the film.
  const strictKnown = (s: string) => !ctx.isKnownFilm?.(s) && (!!ctx.isKnownArtist?.(s) || mentioned(s))
  const filmFirst = label && !labelAlbum && !colonFilm && extraSegs.length >= 2 && !extraSegs[0].film && !extraSegs[0].text.includes(',') &&
    !FEAT.test(extraSegs[0].text) && !strictKnown(extraSegs[0].text) && extraSegs.slice(1).some((s) => s.text.includes(',') || FEAT.test(s.text))
  if (colonFilm) labelAlbum = colonFilm
  if (filmFirst) labelAlbum = extraSegs[0].text
  const album = labelAlbum ?? (creditsStyle
    // A film-marked segment, or the first segment when a cast list follows it ("Shershaah | Sidharth, Kiara").
    ? extraSegs.find((s) => s.film)?.text ?? (extraSegs.length >= 2 && !extraSegs[0].text.includes(',') && extraSegs[1].text.includes(',') && !knownArtist(extraSegs[0].text) ? extraSegs[0].text : null)
    : extras.find((e) => !e.includes(',') && !knownArtist(e) && squash(e) !== squash(artist) && squash(e) !== squash(artistFromChannel)) ?? null)
  const lists = extras.filter((e) => e !== album && e.includes(','))
  let credits = extras.find((e) => e !== album && e.includes(',')) ?? extras.find((e) => e !== album && e.split(' ').length <= 4) ?? null
  const film = label && labelAlbum ? filmCredits(filmFirst ? extras.slice(1) : extras.filter((e) => e !== album), knownArtist) : null
  if (versionArtist) {
    artist = versionArtist
    credits = lists[0] ?? credits
    fromChannel = false
  } else if (film) {
    artist = film.singers.join(', ')
    credits = film.cast
    fromChannel = false
  } else if (label && lists.length >= 2) {
    // "… | Cast A, Cast B | Singer A, Singer B": the last name list is the singers.
    artist = lists[lists.length - 1].split(',').map((x) => x.trim()).filter(Boolean).slice(0, 2).join(', ')
    credits = lists[0]
    fromChannel = false
  } else if (fromChannel && creditsStyle && !singleNames.some((n) => squash(n) === squash(artistFromChannel))) {
    // Uploaded by a label (not the singer's own channel): the first credited names are the singers.
    const known = singleNames.filter(knownArtist)
    artist = lists.length && !known.length
      ? lists[lists.length - 1].split(',').map((x) => x.trim()).filter(Boolean).slice(0, 2).join(', ')
      : (known.length ? known : singleNames).slice(0, 2).join(', ')
    credits = singleNames.filter((n) => !artist.includes(n)).slice(0, 4).join(', ') || null
    fromChannel = false
  }
  return { artist: decodeEntities(artist), title: decodeEntities(title), album: album ? decodeEntities(album) : null, credits: credits ? decodeEntities(credits) : null, fromChannel }
}

/** search.list snippets are HTML-escaped ("Guns N&#39; Roses"). */
/**
 * Strips upload noise from a title that was already parsed ("Makhna 8K Video" → "Makhna").
 * For tracks saved without their original YouTube title, e.g. ones synced from the app.
 */
export function tidyTitle(title: string): string {
  let t = title
  for (let i = 0; i < 2; i++) t = t.replace(trailingNoise, '').replace(fullHd, '').trim()
  return t.replace(leadingNoise, '').trim() || title
}

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
