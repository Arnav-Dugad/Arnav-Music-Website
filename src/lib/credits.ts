/**
 * Song credits — a port of the app's `CreditRoles` / `CreditsBuilder` / `DescriptionCredits`, plus a
 * "Film" group (director, cast, producer, choreographer…) that the web edition shows for soundtrack
 * songs. Pure functions: used by the edge API (/api/credits) and the client.
 */

export type CreditGroup = 'PERFORMED' | 'WRITTEN' | 'PRODUCED' | 'ENGINEERING' | 'FILM' | 'RIGHTS' | 'IDENTIFIERS'

export const CREDIT_GROUP_TITLES: Record<CreditGroup, string> = {
  PERFORMED: 'Performed by',
  WRITTEN: 'Written by',
  PRODUCED: 'Produced by',
  ENGINEERING: 'Engineering',
  FILM: 'From the film',
  RIGHTS: 'Label & rights',
  IDENTIFIERS: 'Identifiers',
}
export const CREDIT_GROUP_ORDER: CreditGroup[] = ['PERFORMED', 'WRITTEN', 'PRODUCED', 'FILM', 'ENGINEERING', 'RIGHTS', 'IDENTIFIERS']

/** One line: "Producer — Max Martin". [person] entries name people or acts and link to an artist page. */
export interface CreditEntry { group: CreditGroup; role: string; name: string; person: boolean; source?: string; link?: string }

interface Classified { group: CreditGroup; role: string }

const WS = /\s+/g
const GENERIC = new Set(['associated performer', 'studio personnel', 'personnel', 'main artist', 'primary artist'])
/** Never music credits, checked before anything else ("Lyric Video: …", "Instagram: …"). */
const HARD_SKIP = ['instagram', 'facebook', 'twitter', 'tiktok', 'youtube', 'spotify', 'apple music', 'itunes', 'deezer',
  'soundcloud', 'subscribe', 'follow', 'website', 'email', 'e-mail', 'booking', 'management', 'chapters', 'tracklist',
  'timestamps', 'http', 'www', 'lyric video', 'lyrical video', 'video song', 'video edit', 'thumbnail', 'poster']
const SKIP_WORDS = ['listen', 'stream', 'download', 'contact', 'merch', 'makeup', 'costume', 'dancer', 'promotion',
  'digital partner', 'watch', 'click', 'link', 'hashtag', 'playlist', 'join', 'support', 'patreon', 'donate', 'special thanks',
  'thanks', 'colorist', 'colourist', 'vfx', 'online', 'publicity', 'social media', 'release', 'song', 'title',
  'movie', 'film', 'album', 'language', 'genre', 'label']
const INSTRUMENTS = ['vocal', 'singer', 'sung', 'voice', 'rap', 'guitar', 'bass', 'drum', 'piano', 'keyboard', 'keys', 'synth', 'violin',
  'viola', 'cello', 'string', 'percussion', 'sax', 'trumpet', 'trombone', 'horn', 'flute', 'clarinet', 'oboe', 'harmonica',
  'organ', 'harp', 'banjo', 'mandolin', 'ukulele', 'tabla', 'sitar', 'veena', 'sarangi', 'shehnai', 'dhol', 'mridangam',
  'nadaswaram', 'santoor', 'choir', 'chorus', 'orchestra', 'ensemble', 'band', 'performer', 'artist', 'feat',
  'conductor', 'rhythm', 'accordion', 'bansuri', 'whistle', 'beatbox', 'soloist', 'turntable', 'dj']

/** "BACKGROUND   Vocal" → "Background vocal". */
export const sentence = (s: string) => { const t = s.replace(WS, ' ').trim().toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1) }

/** Film credits in a free-form label description ("Director: …", "Starring: …"). */
function film(r: string, filmContext: boolean): Classified | null {
  if (/^(video\s+)?direct(or|ed)|^film\s+direct|^dop$|^director of photography/.test(r)) {
    if (/photograph|^dop/.test(r)) return { group: 'FILM', role: 'Cinematographer' }
    return { group: 'FILM', role: r.startsWith('video') ? 'Video director' : 'Director' }
  }
  if (/^(starring|star cast|cast|featuring artists?|artists?\s+on\s+screen|actors?|actress)$/.test(r)) return { group: 'FILM', role: 'Cast' }
  if (/^choreograph/.test(r)) return { group: 'FILM', role: 'Choreographer' }
  if (/^cinematograph|camera/.test(r)) return { group: 'FILM', role: 'Cinematographer' }
  if (/^(story|screenplay|dialogues?|writer \(film\))/.test(r)) return { group: 'FILM', role: sentence(r) }
  if (/^(banner|production house|presented by|presents|studio)$/.test(r)) return { group: 'FILM', role: 'Banner' }
  if (/^(film\s+)?produc(er|ed)s?( by)?$/.test(r) && filmContext) return { group: 'FILM', role: 'Producer' }
  if (/^editor|^edited/.test(r) && filmContext) return { group: 'FILM', role: 'Editor' }
  return null
}

function one(part: string, lenient: boolean, filmContext: boolean): Classified | null {
  const r = part.toLowerCase().replace(WS, ' ').replace(/\s+by:?$/, '').trim()
  if (!r || r.length > 40 || r.split(' ').length > 5 || /^\d/.test(r)) return null
  if (HARD_SKIP.some((w) => r.includes(w))) return null
  const words = r.split(/[ -]/)
  if (['associated performer', 'performer', 'main artist', 'primary artist', 'artist'].includes(r)) return { group: 'PERFORMED', role: 'Performer' }
  if (r === 'studio personnel' || r === 'personnel') return { group: 'ENGINEERING', role: 'Studio personnel' }
  // Music roles first so "Music Director" or "Lyrics" aren't caught by the film list.
  if (r.includes('music director') || r === 'music composer') return { group: 'WRITTEN', role: 'Music director' }
  if (r.includes('compos') || r === 'music' || r === 'tune' || r === 'tunes' || r === 'original music') return { group: 'WRITTEN', role: 'Composer' }
  if (r.includes('lyric') || r === 'words' || r === 'lyrics writer') return { group: 'WRITTEN', role: 'Lyricist' }
  if (r.includes('songwriter') || (r.includes('writer') && !r.includes('film')) || r === 'written' || r === 'author' || r === 'penned') return { group: 'WRITTEN', role: 'Writer' }
  if (r.includes('arrang') || r.includes('orchestrat')) return { group: 'WRITTEN', role: 'Arranger' }
  if (r.includes('executive producer')) return filmContext && !lenient ? { group: 'FILM', role: 'Executive producer' } : { group: 'PRODUCED', role: 'Executive producer' }
  if (/co-?\s?producer/.test(r)) return { group: 'PRODUCED', role: 'Co-producer' }
  if (r.includes('additional producer')) return { group: 'PRODUCED', role: 'Additional producer' }
  if (r.includes('music producer') || r.includes('record producer') || r === 'music production' || ((r === 'producer' || r === 'producers' || r === 'produced' || r === 'production') && (lenient || !filmContext))) return { group: 'PRODUCED', role: 'Producer' }
  if (r.includes('remix')) return { group: 'PRODUCED', role: 'Remixer' }
  if (r.includes('programm')) return { group: 'PRODUCED', role: 'Programming' }
  if (r.includes('master')) return { group: 'ENGINEERING', role: 'Mastering engineer' }
  if (r.includes('mix')) return { group: 'ENGINEERING', role: r.includes('assist') ? 'Assistant mixing engineer' : 'Mixing engineer' }
  if (r.includes('record') && !r.includes('label')) return { group: 'ENGINEERING', role: 'Recording engineer' }
  if (r.includes('engineer')) return { group: 'ENGINEERING', role: r.includes('assist') ? 'Assistant engineer' : 'Engineer' }
  if (r.includes('sound design') || r.includes('audio editor') || r === 'vocal editor') return { group: 'ENGINEERING', role: sentence(part) }
  if (r.includes('conduct')) return { group: 'PERFORMED', role: r.includes('vocal') ? 'Vocal conductor' : 'Conductor' }
  if (/backing vocals? (design|arrang)/.test(r)) return { group: 'WRITTEN', role: 'Backing vocals arranger' }
  if (r.includes('label')) return { group: 'RIGHTS', role: 'Label' }
  if (r.includes('publish')) return { group: 'RIGHTS', role: 'Publisher' }
  if (r.includes('distribut')) return { group: 'RIGHTS', role: 'Distributor' }
  if (r.includes('copyright') || r === '©') return { group: 'RIGHTS', role: 'Copyright' }
  const f = film(r, filmContext)
  if (f) return f
  if (r.includes('producer')) return lenient || r.includes('vocal') ? { group: 'PRODUCED', role: sentence(part) } : null
  if (SKIP_WORDS.some((w) => r.includes(w))) return null
  if (words.some((w) => INSTRUMENTS.some((i) => w.startsWith(i)))) {
    if (['featuring', 'feat', 'feat.', 'featured artist', 'featured'].includes(r)) return { group: 'PERFORMED', role: 'Featured artist' }
    if (['singer', 'singers', 'sung', 'vocals', 'vocal', 'vocalist', 'lead vocal', 'lead vocals', 'voice', 'singer(s)'].includes(r)) return { group: 'PERFORMED', role: 'Vocals' }
    return { group: 'PERFORMED', role: sentence(part) }
  }
  return lenient ? { group: 'PERFORMED', role: sentence(part) } : null
}

/** Splits "Composer, Lyricist" and classifies each part (unknown roles count only when [lenient]). */
export function classifyRole(rawRole: string, lenient: boolean, filmContext = false): Classified[] {
  const parts = rawRole.split(/\s*(?:,|;|\/|&|\band\b)\s*/i).map((p) => p.replace(WS, ' ').trim().replace(/^[:\-–.]+|[:\-–.]+$/g, '').trim()).filter(Boolean)
  if (!parts.length) return []
  const meaningful = parts.filter((p) => !GENERIC.has(p.toLowerCase()))
  const out: Classified[] = []
  for (const p of meaningful.length ? meaningful : parts) {
    const c = one(p, lenient, filmContext)
    if (!c) continue
    const same = out.findIndex((o) => o.group === c.group)
    if (same < 0) out.push(c)
    else if (!out[same].role.split(', ').includes(c.role)) out[same] = { ...out[same], role: `${out[same].role}, ${c.role}` }
  }
  return out
}

const PLACEHOLDERS = new Set(['<unknown>', 'unknown', 'unknown artist', 'n/a', 'na', 'none', '-', 'various', 'null', 'tba'])
export function cleanName(raw: string): string | null {
  const n = raw.replace(/\u0000/g, ' ').replace(WS, ' ').trim().replace(/^[,;.·|]+|[,;.·|]+$/g, '').trim()
  if (!n || n.length > 120 || PLACEHOLDERS.has(n.toLowerCase())) return null
  if (/https?:\/\/|^www\.|^@|#/.test(n)) return null
  return n
}

/** Collects credits, merging people credited with several roles in one group. */
export class CreditsBuilder {
  entries: CreditEntry[] = []
  person(group: CreditGroup, role: string, name: string, source?: string) {
    const n = cleanName(name)
    if (n) this.add({ group, role, name: n, person: true, source })
  }
  fact(group: CreditGroup, role: string, value: string | null | undefined, source?: string, link?: string) {
    const v = value?.replace(WS, ' ').trim().replace(/[,;]+$/, '')
    if (v && v.length <= 200) this.add({ group, role, name: v, person: false, source, link })
  }
  add(e: CreditEntry) {
    const i = this.entries.findIndex((x) => x.group === e.group && x.person === e.person && x.name.toLowerCase() === e.name.toLowerCase() && (x.person || x.role === e.role))
    if (i < 0) { this.entries.push(e); return }
    const old = this.entries[i]
    const roles = old.role.split(', ')
    const added = e.role.split(', ').filter((r) => !roles.some((x) => x.toLowerCase() === r.toLowerCase()))
    this.entries[i] = { ...old, role: added.length ? [...roles, ...added].join(', ') : old.role, link: old.link ?? e.link, source: old.source ?? e.source }
  }
}

const PROVIDED_BY = /^provided to youtube by\s+(.+)$/i
const AUTO_GENERATED = /^auto-generated by youtube\.?$/i
const RELEASED_ON = /^released\s+on\s*[:：]\s*(\d{4}(?:-\d{2}(?:-\d{2})?)?)/i
const PHONOGRAPHIC = /^(?:℗|\(p\))\s*(.+)$/i
const COPYRIGHT = /^(?:©|\(c\))\s*(.+)$/i
const ROLE_LINE = /^([^:：]{1,48}?)\s*[:：]\s*(.+)$/
/** "Lyrics - Irshad Kamil" (spaced dash, free-form only). */
const DASH_LINE = /^([^:：\-–]{1,40}?)\s+[-–]\s+(.+)$/
const BY_LINE = /^((?:music|lyrics|words|composed|written|produced|mixed|mastered|arranged|programmed|sung|directed|choreographed)(?:\s*(?:&|and|,)\s*\w+)*)\s+by\s+(.+)$/i
/** "Starring A, B and C" (no colon). */
const STARRING = /^(starring|star cast|featuring)\s+(.+)$/i
const NAME_SPLIT = /\s*(?:,|&|;|\s+and\s+|\s+x\s+|\s\/\s)\s*/i
const ISRC = /^isrc\s*[:：]?\s*([A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5})$/i
const FILM_HINT = /\b(movie|film|starring|star cast|cast|director|directed|banner|presents|soundtrack|ost)\b/i
/** Bullets and decorations labels put before roles ("♪ Singer: …", "🎤 Lyrics - …", "► Music :"). */
const BULLETS = /^[\s•►▶★☆♪♫✔❖➜➤*>\-–—~|♦◆●○◉✦✧❖➤➔→⇒»]+/u

export const isTopicDescription = (d: string) => d.split('\n').some((l) => PROVIDED_BY.test(l.trim()) || AUTO_GENERATED.test(l.trim()))

/** Credits from a YouTube video description (Topic pages have a fixed shape; label pages are "Role: Name"). */
export function parseDescriptionCredits(description: string): CreditEntry[] {
  if (!description.trim()) return []
  const lines = description.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(WS, ' ').trim())
  const topic = isTopicDescription(description)
  const filmContext = !topic && lines.some((l) => FILM_HINT.test(l.split(/[:：]/)[0] ?? ''))
  const b = new CreditsBuilder()
  let label: string | null = null
  let album: string | null = null
  let released: string | null = null
  const structural = new Set<string>()

  if (topic) {
    const paras: string[][] = []
    let cur: string[] = []
    for (const l of lines) { if (!l) { if (cur.length) { paras.push(cur); cur = [] } } else cur.push(l) }
    if (cur.length) paras.push(cur)
    const pi = paras.findIndex((p) => p.some((l) => PROVIDED_BY.test(l)))
    const pm = pi >= 0 ? paras[pi].map((l) => PROVIDED_BY.exec(l)).find(Boolean) : null
    if (pm) label = pm[1]
    const ti = paras.findIndex((p) => p.length === 1 && p[0].includes(' · '))
    if (ti >= 0) {
      structural.add(paras[ti][0])
      paras[ti][0].split(' · ').map((x) => x.trim()).filter(Boolean).slice(1).forEach((a, i) => b.person('PERFORMED', i === 0 ? 'Artist' : 'Featured artist', a, 'YouTube'))
      const next = paras[ti + 1]
      if (next && next.length === 1 && next[0] && !/[:：]|:\/\//.test(next[0]) && !PHONOGRAPHIC.test(next[0]) && !COPYRIGHT.test(next[0])) {
        album = next[0]
        structural.add(next[0])
      }
    }
  }

  for (const raw of lines) {
    const line = raw.replace(BULLETS, '').trim()
    if (!line || AUTO_GENERATED.test(line) || structural.has(raw)) continue
    const provided = PROVIDED_BY.exec(line)
    if (provided) { label ??= provided[1]; continue }
    const rel = RELEASED_ON.exec(line)
    if (rel) { released = rel[1]; continue }
    const ph = PHONOGRAPHIC.exec(line)
    if (ph) { b.fact('RIGHTS', 'Recording copyright', `℗ ${ph[1].trim()}`, 'YouTube'); continue }
    const co = COPYRIGHT.exec(line)
    if (co) { b.fact('RIGHTS', 'Copyright', `© ${co[1].trim()}`, 'YouTube'); continue }
    const is = ISRC.exec(line)
    if (is) { b.fact('IDENTIFIERS', 'ISRC', is[1].toUpperCase().replace(/-/g, ''), 'YouTube'); continue }
    // Topic lines are "Role: Name"; free-form lines may also use " - " ("Lyrics - Irshad Kamil").
    const m = ROLE_LINE.exec(line) ?? BY_LINE.exec(line) ?? (topic ? null : DASH_LINE.exec(line) ?? (filmContext ? STARRING.exec(line) : null))
    if (!m) continue
    const role = m[1].trim()
    const value = m[2].trim()
    if (!value || value.includes('://') || /^www\./i.test(value)) continue
    if (/\d/.test(role) && !/3d/i.test(role)) continue
    const lower = role.toLowerCase()
    if (lower === 'album' || lower === 'movie album' || lower === 'movie' || lower === 'film' || lower === 'movie name' || lower === 'film name') { album ??= value; continue }
    if (lower === 'genre') { b.fact('IDENTIFIERS', 'Genre', value, 'YouTube'); continue }
    if (lower === 'isrc') { b.fact('IDENTIFIERS', 'ISRC', value.toUpperCase(), 'YouTube'); continue }
    if (lower === 'upc') { b.fact('IDENTIFIERS', 'UPC', value, 'YouTube'); continue }
    for (const c of classifyRole(role, topic, filmContext)) {
      if (c.group === 'RIGHTS') {
        if (c.role === 'Label' && !label) label = value
        else b.fact('RIGHTS', c.role, value, 'YouTube')
        continue
      }
      const names = topic ? [value] : value.split(NAME_SPLIT)
      const maxWords = topic ? 8 : 6
      for (const n of names) if (n.split(' ').filter(Boolean).length <= maxWords) b.person(c.group, c.role, n.replace(/\s*\(.*?\)\s*$/, ''), 'YouTube')
    }
  }
  if (label) b.fact('RIGHTS', 'Label', label, 'YouTube')
  if (album) b.fact('IDENTIFIERS', 'Album', album, 'YouTube')
  if (released) b.fact('IDENTIFIERS', 'Released', released, 'YouTube')
  return order(b.entries)
}

/** Label first within rights; album and release first within identifiers. */
export function order(entries: CreditEntry[]): CreditEntry[] {
  const rights: Record<string, number> = { Label: 0, Publisher: 1, Distributor: 2, 'Recording copyright': 3, Copyright: 4 }
  const ids: Record<string, number> = { Album: 0, Released: 1, Genre: 2, ISRC: 3, UPC: 4 }
  const film: Record<string, number> = { Director: 0, Cast: 1, Producer: 2, Banner: 3 }
  const rank = (e: CreditEntry) => e.group === 'RIGHTS' ? rights[e.role] ?? 5 : e.group === 'IDENTIFIERS' ? ids[e.role] ?? 5 : e.group === 'FILM' ? film[e.role] ?? 4 : 0
  return CREDIT_GROUP_ORDER.flatMap((g) => entries.filter((e) => e.group === g).map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e))
}

const LYRICS_HEAD = /^(?:song\s+)?lyrics?(?:\s+in\s+\p{L}+)?\s*[:：\-–]?\s*$/iu
const LYRICS_STOP = /^(label|music label|©|\(c\)|℗|\(p\)|copyright|credits|follow|subscribe|connect|download|listen|stream|#|https?:)/i
const SECTION = /^\s*[[(]?\s*(mukhda|antara|chorus|verse|bridge|intro|outro|hook|pre-?chorus|refrain|interlude|male|female|all|\d+)\s*[\])]?\s*:?\s*$/i

/**
 * Lyrics an uploader typed into the description ("Lyrics:\n…"), section labels and "x2" repeats removed.
 * Official text for many label uploads; used as a plain-text fallback and to check synced lyrics.
 */
export function descriptionLyrics(description: string): string | null {
  const lines = description.replace(/\r\n?/g, '\n').split('\n')
  const head = lines.findIndex((l) => LYRICS_HEAD.test(l.trim()))
  if (head < 0) return null
  const out: string[] = []
  for (const raw of lines.slice(head + 1)) {
    const l = raw.trim()
    if (LYRICS_STOP.test(l)) break
    if (SECTION.test(l)) { if (out.length && out[out.length - 1] !== '') out.push(''); continue }
    out.push(l.replace(/^\[\s*/, '').replace(/\s*\]\s*(x\s*\d+)?\s*$/i, '').replace(/\s+x\s*\d+\s*$/i, '').trim())
  }
  while (out.length && !out[out.length - 1]) out.pop()
  while (out.length && !out[0]) out.shift()
  const sung = out.filter(Boolean)
  return sung.length >= 4 && sung.every((l) => l.length <= 140) ? out.join('\n').replace(/\n{3,}/g, '\n\n') : null
}

export function mergeCredits(...lists: CreditEntry[][]): CreditEntry[] {
  const b = new CreditsBuilder()
  for (const l of lists) for (const e of l) b.add(e)
  return order(b.entries)
}

export function groupCredits(entries: CreditEntry[]): { group: CreditGroup; title: string; entries: CreditEntry[] }[] {
  return CREDIT_GROUP_ORDER.map((g) => ({ group: g, title: CREDIT_GROUP_TITLES[g], entries: entries.filter((e) => e.group === g) })).filter((x) => x.entries.length)
}
