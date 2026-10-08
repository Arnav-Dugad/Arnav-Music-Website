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
/** "(Exclusive Music Video)", "[Official Lyric Video 4K]" — but not "(Remix Video)" or "(Live Audio)". */
const anyNoiseBracket = /\s*[([][^)\]]*\b(official|oficial|officiel|lyrics?|letra|lyrical|audio|video|visuali[sz]er|mv|clip|hd|4k|8k|teaser|promo|transliteration|translation)\b[^)\]]*[)\]]/gi
const KEEP_BRACKET = /\b(remix|version|live|acoustic|unplugged|reprise|cover|lo-?fi|slowed|sped|mix|from|feat|ft)\b/i
const segmentSeparators = /\s*(?:\|\|?|‖)\s*|\s+•\s+/
const capitalISeparator = /\s+I\s+/
const trailingNoise = /\s*[-–:]?\s*\b(official\s+)?(full\s+)?(lyric(al)?\s+video|lyrics?\s+video|video\s+song|audio\s+song|full\s+song|music\s+video|official\s+video|official\s+audio|lyrical|lyrics)\s*$/i
const segmentNoise = /(#|\b(songs?|music|video|lyric(al|s)?|letra|oficial|officiel|clip|latest|new|hits|telugu|hindi|tamil|kannada|malayalam|punjabi|marathi|bengali|bollywood|tollywood|kollywood|full|hd|4k|official|trending|audio|jukebox|(19|20)\d\d)\b)/i
const movieWords = /\s*\b(movie|film|songs?|ost)\b\s*/gi
const movieWordsTest = /\s*\b(movie|film|songs?|ost)\b\s*/i

const leadingNoise = /^\s*(full\s+(video\s+)?song|full\s+(video|audio)|lyrical(\s+video)?|lyric\s+video|(video|audio)\s+song|video|audio|official\s+(video|audio))\s*[:\-–|]\s*/i
const fullHd = /\s+(full\s+)?(hd|uhd|[248]k(?:\s*\/\s*[248]k)?|1080p|720p|2160p)(\s+(music\s+)?video)?(\s+song)?\s*$/i
const labelChannel = /^(t-series|tseries|yrf|sony\s*music\s*(india|south)\w*|zee\s*music\s*company|zee music|tips (official|music)|saregama|aditya music|lahari|speed records|times music|venus|eros now|shemaroo|think music|sun music|mango music|junglee music|desi music factory|white hill|saga music|universal music india|t-series [a-z]+|sony music)\b/i
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
export const PARSE_V = 13

export interface ParseContext {
  /** Film / album names learned from Topic descriptions and iTunes soundtracks. */
  isKnownFilm?: (name: string) => boolean
  /** Names known to be artists (Topic channels, artist channels, your library). */
  isKnownArtist?: (name: string) => boolean
  /** The search that found the upload: a name you searched for is probably the artist. */
  query?: string
}

const PURE_NOISE = /^(video|audio|lyrics?|lyrical|full\s+song|full\s+video|video\s+song|official(\s+(music\s+)?(video|audio))?|music\s+video|hd|4k|new\s+song|latest|video\s+oficial|oficial|letra|clip\s+officiel|video\s+clip|hd\s+version)$/i
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const FEAT = /\s+(?:feat\.?|ft\.?|featuring)\s*/i
const FILM_YEAR = /\s+\(?(?:19|20)\d\d\)?$/
/** "Wedding Song 2021", "Sad Songs": describes the song, not a film. */
const SONG_KIND = /\b(wedding|party|romantic|sad|love|dance|bhangra|punjabi|hindi|tamil|telugu|new|latest|hit|super\s*hit|festival|holi|diwali|navratri|garba|devotional|bhajan|rap|lofi|workout|birthday)\s+(songs?|track|anthem)\b/i
/** Looks like a person's name ("Stebin Ben", "Asees Kaur", "Sachet-Parampara"). */
const nameLike = (s: string) => /^[\p{L}][\p{L}.'-]*(\s+[\p{L}][\p{L}.'-]*){0,3}$/u.test(s.trim().replace(/\s*[-–]\s*/g, '-')) && !/\d/.test(s)
const splitNames = (s: string) => s.split(/\s*,\s*|\s+&\s+|\s+(?:feat\.?|ft\.?|featuring)\s*/i).map((x) => x.trim()).filter(Boolean)
/** TV / live-session series that lead the title ("Coke Studio | Season 14 | Pasoori | Ali Sethi x Shae Gill"). */
const SHOW = /^(coke\s+studio(\s+(bharat|pakistan|india|explorer|africa|tamil))?|mtv\s+unplugged|the\s+dewarists|tiny\s+desk(\s+concert)?|a\s+colors\s+show|sofar\s+sounds|nescafe\s+basement|velvet\s+sessions)(\s*(season|s)?\s*\d+)?$/i
const SEASON = /^(season|series|s|episode|ep\.?)\s*\d+$/i
/** "Film Version", "Video Version": a variant of the song, not an album. */
const VERSION_SIDE = /^(film|movie|video|album|radio|original|extended|club|duet|female|male|unplugged|acoustic|lo-?fi)\s+(version|mix)$|^(remix|reprise|unplugged|lo-?fi|acoustic|sped up|slowed(\s*\+\s*reverb)?)$/i
/** "Ali Sethi x Shae Gill", "Sidharth – Kiara": a list of names written with x or a dash. */
function nameList(s: string): string {
  const parts = s.split(/\s+(?:x|X|×)\s+|\s+[–—]\s+/)
  return parts.length >= 2 && parts.every((p) => nameLike(p.trim())) ? parts.map((p) => p.trim()).join(', ') : s
}
/** "AP DHILLON" → "AP Dhillon"; "@AmrDiab" → "Amr Diab". */
function tidyArtist(s: string): string {
  let a = s.trim().replace(/^@/, '')
  if (/^\p{Lu}[\p{Ll}]+(?:\p{Lu}[\p{Ll}]+)+$/u.test(a)) a = a.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
  if (/\p{L}{3}/u.test(a) && a === a.toUpperCase() && /[A-Z]/.test(a)) a = a.split(/(\s+)/).map((w) => (w.length <= 2 ? w : w.charAt(0) + w.slice(1).toLowerCase())).join('')
  return a
}
/**
 * A noise bracket in the middle of a title ("LOVER (Official Music Video) Intense | Raj Ranjodh")
 * ends the song name: the names after it are credits, so it becomes a separator.
 */
function dropBracket(m: string, offset: number, all: string): string {
  const after = all.slice(offset + m.length)
  const next = after.split(/\|\|?|‖|•|\s[-–—]\s/)[0].trim()
  if (next && !segmentNoise.test(next) && !/^[|‖•\-–—([/]/.test(after.trimStart()) && !/^(feat|ft|featuring|by|x)\b/i.test(next) && nameLike(next)) return ' | '
  return ''
}
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())

/**
 * Who sang a soundtrack song, from the segments after the film:
 * "Cast A, Cast B | Director | Singer | Lyricist", "Composer Feat. Singer | Cast", "Singer | Cast A, Cast B",
 * "Cast A | Cast B | Singer" (no cast list). Returns null when nothing looks like a singer.
 */
function filmCredits(segs: string[], known: (s: string) => boolean, strict: (s: string) => boolean = () => false): { singers: string[]; cast: string | null } | null {
  if (!segs.length) return null
  const castIdx = segs.findIndex((s) => s.includes(',') && !FEAT.test(s))
  const cast = castIdx >= 0 ? segs[castIdx] : null
  const featSeg = segs.find((s) => FEAT.test(s))
  if (featSeg) return { singers: splitNames(featSeg).slice(0, 3), cast }
  // Singers we know by their full name, wherever they sit ("… | Atlee, Anirudh | Arijit Singh | Shilpa Rao").
  const knownSingers = segs.flatMap(splitNames).filter((n) => n.includes(' ') && strict(n))
  if (knownSingers.length) {
    const others = segs.filter((s) => !splitNames(s).some((n) => knownSingers.includes(n)))
    return { singers: knownSingers.slice(0, 3), cast: others.find((s) => s.includes(',')) ?? (others.filter(nameLike).slice(0, 2).join(', ') || null) }
  }
  // "Film: Song | Cast A | Cast B | Director | Composer | Singer A, Singer B": a list after two or more names is the singers.
  const lead = castIdx >= 2 ? segs.slice(0, castIdx).filter(nameLike) : []
  if (lead.length >= 2) return { singers: splitNames(segs[castIdx]).slice(0, 3), cast: lead.slice(0, 2).join(', ') }
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

export function parseYouTubeTitle(rawTitle: string, channel: string, ctx: ParseContext = {}): ParsedTitle {
  const raw = decodeEntities(rawTitle)
  const noBrackets = raw
    .replace(bracketNoise, (m, _g, offset: number, all: string) => dropBracket(m, offset, all))
    .replace(anyNoiseBracket, (m, _g, offset: number, all: string) => (KEEP_BRACKET.test(m) ? m : dropBracket(m, offset, all)))
    .replace(/\s+/g, ' ').trim()
  let segments = noBrackets.split(segmentSeparators).map((s) => s.trim()).filter(Boolean)
  if (segments.length === 1 && (segments[0].match(/\s+I\s+/g)?.length ?? 0) >= 2) {
    segments = segments[0].split(capitalISeparator).map((s) => s.trim()).filter(Boolean)
  }
  if (segments.length === 0) segments = [noBrackets || raw]
  // Bizarrap's sessions are named by number: "SHAKIRA || BZRP Music Sessions #53" → "Bzrp Music Sessions, Vol. 53" by Bizarrap, Shakira.
  const bzrp = /\bbzrp\s+music\s+sessions?\b[^|]*?(?:vol\.?\s*|#\s*)(\d{1,3})\b/i.exec(noBrackets)
  if (bzrp) {
    const guests = noBrackets.split(/\|\|?|‖|\s[-–—]\s/).map((x) => x.trim()).filter((x) => x && !/bzrp/i.test(x) && !segmentNoise.test(x) && !PURE_NOISE.test(x))
      .flatMap(splitNames).filter((n) => nameLike(n) && !/^bizarrap$/i.test(n)).map(tidyArtist)
    return { artist: ['Bizarrap', ...guests.slice(0, 2)].join(', '), title: `Bzrp Music Sessions, Vol. ${bzrp[1]}`, album: null, credits: null, fromChannel: false }
  }
  // A show leads the title: the song and its singers follow ("Coke Studio | Season 14 | Pasoori | Ali Sethi x Shae Gill").
  if (segments.length >= 2 && SHOW.test(segments[0])) {
    let show = segments[0]
    let rest = segments.slice(1)
    if (rest.length >= 2 && SEASON.test(rest[0])) { show = `${show} ${titleCase(rest[0])}`; rest = rest.slice(1) }
    const song = rest[0].replace(trailingNoise, '').replace(fullHd, '').trim()
    const who = rest[1] ? nameList(rest[1].replace(FEAT, ', ')) : ''
    const singers = who && !segmentNoise.test(who) && !/^the\s/i.test(who) && (who.includes(',') || /\s&\s/.test(who) || nameLike(who)) ? splitNames(who) : []
    const host = channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/, '').replace(/\s+(official|music|tv)$/i, '').trim() || channel
    return {
      artist: singers.length ? singers.slice(0, 3).join(', ') : host,
      title: song || rest[0],
      album: show,
      credits: rest.slice(singers.length ? 2 : 1).filter((x) => !segmentNoise.test(x) && nameLike(x)).join(', ') || null,
      fromChannel: !singers.length,
    }
  }

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
    // "عمرو دياب - تملي معاك" after a Latin title: the same artist and song in the original script.
    .filter((s) => !(/[؀-ۿऀ-෿]/.test(s) && /[A-Za-z]{2}/.test(segments[titleIndex]) && /\s[-–]\s|[()]/.test(s)))
    .map((s) => ({ text: nameList(s.replace(movieWords, ' ').replace(FILM_YEAR, '').replace(/\s+/g, ' ').trim()), film: filmMarked(s) }))
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

  let tidy = cleaned.replace(leadingNoise, '').replace(fullHd, '').replace(/\s+[-–—:]\s*(official\s+|full\s+)?(video|audio|lyrics?|lyric\s+video)\s*$/i, '')
    .replace(/\s+(full\s+(video\s+)?song|full\s+video|video\s+song|lyrical(\s+video)?|lyrics?\s+video|[248]k(\s*\/\s*[248]k)?)(?=\s+[-–—]\s)/i, '')
    // "Enta Eih / نانسي عجرم - انت ايه": the same title again in the original script.
    .replace(/\s+\/\s+[^A-Za-z]*[؀-ۿऀ-෿][^A-Za-z]*$/, '')
    .replace(/\s+by\s+(.{2,40})$/i, (m: string, who: string) => (squash(who) === squash(channel) ? '' : m))
    .replace(/\s*[-–—:|]+\s*$/, '').trim() || cleaned
  // '"Tum Hi Ho" Aashiqui 2 Full Song With Lyrics': the quoted part is the song, the rest its film.
  let quotedFilm: string | null = null
  const quoted = /^["“]([^"”]{2,70})["”]\s*(.*)$/.exec(tidy)
  if (quoted) {
    let song = quoted[1].trim()
    const rest = quoted[2].replace(/\s+with(\s+lyrics?)?\s*$/i, '').replace(fullHd, '').replace(trailingNoise, '').replace(/\s*\b(full\s+)?(video\s+)?(song|video|audio)\s*$/i, '').replace(fullHd, '').trim()
    if (rest && !PURE_NOISE.test(rest) && !segmentNoise.test(rest) && rest.split(/\s+/).length <= 5) quotedFilm = rest
    else if (ctx.isKnownFilm) {
      // '"Tum Hi Ho Aashiqui 2" Full Video Song HD': a known film at the end of the quote.
      const w = song.split(/\s+/)
      for (let n = Math.min(3, w.length - 1); n >= 1; n--) {
        const tail = w.slice(-n).join(' ')
        if (ctx.isKnownFilm(tail)) { quotedFilm = tail; song = w.slice(0, -n).join(' '); break }
      }
    }
    tidy = song
  }
  tidy = tidy.replace(/^["“”']+|["“”']+$/g, '').trim() || tidy
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
  // Label "Film : Song" ("Kabir Singh : Kaise Hua Song", "JAWAN: Chaleya (Hindi)", "Aashiqui 2: Tum Hi Ho").
  let colonFilm: string | null = quotedFilm
  const filmColon = label && !colonFilm ? /^([^:]{2,40}?)\s*:\s*(.{2,60}?)(?:\s+song)?$/i.exec(tidy) : null
  if (filmColon && filmColon[1].trim().split(/\s+/).length <= 4 && !FEAT.test(filmColon[2]) && !knownArtist(filmColon[2]) && !/[-–—]\s/.test(filmColon[2])) {
    colonFilm = /^[\p{Lu}\d\s]+$/u.test(filmColon[1].trim()) ? titleCase(filmColon[1].trim()) : filmColon[1].trim()
    tidy = filmColon[2].trim()
  }
  // Label "Song Song Film" ("Tum Hi Ho Song Aashiqui 2").
  const songFilm = label && !colonFilm ? /^(.{2,40}?)\s+song\s+(.{2,40})$/i.exec(tidy) : null
  if (songFilm && !SONG_KIND.test(tidy) && songFilm[2].split(/\s+/).length <= 4 && !segmentNoise.test(songFilm[2])) { colonFilm = songFilm[2].trim(); tidy = songFilm[1].trim() }
  // "Kesariya - Film Version": a version of the song, not an album.
  const versionSide = /^(.{2,60}?)\s+[-–—]\s+(.{2,30})$/.exec(tidy)
  if (versionSide && VERSION_SIDE.test(versionSide[2].trim())) tidy = `${versionSide[1].trim()} (${titleCase(versionSide[2].trim())})`
  // "Song: Artist feat. X" — the colon separates the song from its artists.
  let colonArtist: string | null = null
  const colon = /^([^:]{2,50}):\s+(.{2,80})$/.exec(tidy)
  const ownSide = (x: string) => { const a = squash(x); const c = squash(artistFromChannel); return !!a && (a === c || (c.length >= 6 && a.includes(c))) }
  const strictArtist = (x: string) => !ctx.isKnownFilm?.(x) && !!ctx.isKnownArtist?.(x)
  if (colon && !label && (ownSide(colon[1]) || strictArtist(colon[1])) && !ownSide(colon[2]) && !strictArtist(colon[2])) { colonArtist = colon[1].trim(); tidy = colon[2].trim() }
  else if (colon && (/\b(feat\.?|ft\.?)\s/i.test(colon[2]) || knownArtist(colon[2]) || ownSide(colon[2]))) { tidy = colon[1].trim(); colonArtist = colon[2].trim() }
  const sep = /( - | – | — | ‒ | ― | ‐ | ~ )/.exec(tidy)
  const parts = sep ? [tidy.slice(0, sep.index), tidy.slice(sep.index + sep[0].length)] : [tidy]
  let artist: string
  let title: string
  let labelAlbum: string | null = null
  let fromChannel = false
  let filmRight = false
  // "Madhanya - Rahul Vaidya & Disha Parmar": the right side is two full names, not a film.
  const bothNames = (s: string) => { const n = s.split(/\s*&\s*|\s*,\s*/); return n.length >= 2 && n.every((x) => x.trim().split(/\s+/).length >= 2 && nameLike(x)) }
  if (colonArtist) {
    artist = colonArtist
    title = tidy
  } else if (parts.length === 2 && label && parts[0].trim() && parts[1].trim() && bothNames(parts[1])) {
    artist = parts[1].trim()
    title = parts[0].trim()
  } else if (parts.length === 2 && !label && parts[0].trim() && parts[1].trim() && (
    (ownSide(parts[1]) && !ownSide(parts[0])) ||
    (strictArtist(parts[1].trim()) && !strictArtist(parts[0].trim())) ||
    (bothNames(parts[1]) && !bothNames(parts[0]) && !strictArtist(parts[0].trim())))) {
    // "BROWN MUNDE - AP DHILLON" on AP Dhillon's channel, "Enta Eih - Nancy Ajram", "Brown Munde - Ap Dhillon, Gurinder Gill".
    title = parts[0].trim()
    artist = ownSide(parts[1]) && squash(parts[1]) !== squash(artistFromChannel) && !/^[^\s]+$/.test(artistFromChannel) ? artistFromChannel : parts[1].trim()
  } else if (parts.length === 2 && !label && parts[0].trim() && ctx.isKnownFilm?.(parts[1].trim()) && !ctx.isKnownFilm(parts[0].trim()) && !ctx.isKnownArtist?.(parts[0].trim())) {
    // "Chaleya - Jawan" on a lyrics or fan channel: song, then its film.
    title = parts[0].trim()
    labelAlbum = parts[1].trim().slice(0, 60)
    artist = artistFromChannel || 'Unknown artist'
    fromChannel = true
    filmRight = true
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
  const film = (label || filmRight) && labelAlbum ? filmCredits(filmFirst ? extras.slice(1) : extras.filter((e) => e !== album), knownArtist, strictArtist) : null
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
  } else if (fromChannel && creditsStyle && singleNames.length >= 3 && singleNames.findIndex(ownName) > 0) {
    // On a producer's channel the singers come first: "Excuses | AP Dhillon | Gurinder Gill | Intense".
    const own = singleNames.findIndex(ownName)
    artist = singleNames.slice(0, Math.min(own, 2)).join(', ')
    credits = singleNames.filter((n) => !artist.includes(n)).slice(0, 4).join(', ') || null
    fromChannel = false
  } else if (fromChannel && label) {
    // "Apna Bana Le 8K Video | Arijit Singh | Bhediya | …": a known singer among the segments.
    const singers = extras.flatMap(splitNames).filter((n) => n.includes(' ') && strictArtist(n))
    if (singers.length) { artist = singers.slice(0, 2).join(', '); fromChannel = false }
  } else if (fromChannel && !label && extras[0] && extras[0] === credits && extras[0].includes(',') && splitNames(extras[0]).every(nameLike)) {
    // A lyrics / fan channel: "Pasoori | Ali Sethi, Shae Gill | Coke Studio" — the names after the song sang it.
    artist = splitNames(extras[0]).slice(0, 3).join(', ')
    credits = null
    fromChannel = false
  }
  if (!fromChannel) artist = tidyArtist(artist)
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
