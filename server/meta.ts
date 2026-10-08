/**
 * Free music-data sources behind one cached, allow-listed proxy, plus two aggregates built from them:
 *
 *   GET  /api/meta?src=itunes|mb|wd|deezer|netease&ep=…  → compact JSON from that source
 *   GET  /api/credits?v=<videoId>&t=&a=&al=&d=           → song credits (YouTube description, title,
 *                                                          MusicBrainz, Wikidata film, Deezer tempo)
 *   GET  /api/community?v=<videoId>                       → lyrics version + timing listeners agreed on
 *   POST /api/community {v, choice, offsetMs, scale}      → adds one listener's choice / timing fix
 *   GET  /api/known                                       → artist + film names learned from Topic data
 *
 * Sources: iTunes Search API, MusicBrainz, Wikidata, Deezer and NetEase Cloud Music (public endpoints,
 * no keys). Everything is cached in KV so each lookup happens once for all visitors.
 */
import { cached, cachedJson, json, USER_AGENT, VIDEO_ID, type ApiEnv, type WaitUntil } from './util'
import { knownSets, learn, filmName, nameKey } from './known'
import { parseYouTubeTitle, isLabelChannel } from '../src/lib/format'
import { CreditsBuilder, descriptionLyrics, mergeCredits, parseDescriptionCredits, type CreditEntry } from '../src/lib/credits'

const DAY = 86_400
const clip = (v: string | null, n = 200) => (v ?? '').slice(0, n)
const COUNTRY = /^[A-Z]{2}$/

// ── Proxy ────────────────────────────────────────────────────────────────────
export async function metaApi(url: URL, env: ApiEnv, waitUntil?: WaitUntil): Promise<Response> {
  const src = url.searchParams.get('src')
  const ep = url.searchParams.get('ep')
  const q = url.searchParams
  const cacheHeaders = { 'cache-control': 'public, max-age=3600, s-maxage=604800' }
  switch (`${src}:${ep}`) {
    case 'itunes:search': {
      const entity = ['album', 'song', 'musicArtist'].includes(q.get('entity') ?? '') ? q.get('entity')! : 'song'
      const country = COUNTRY.test((q.get('country') ?? '').toUpperCase()) ? q.get('country')!.toUpperCase() : 'US'
      const limit = Math.min(50, Math.max(1, Number(q.get('limit')) || 10))
      const attr = q.get('attribute') === 'artistTerm' ? '&attribute=artistTerm' : ''
      const u = `https://itunes.apple.com/search?term=${encodeURIComponent(clip(q.get('term'), 120))}&media=music&entity=${entity}&limit=${limit}&country=${country}${attr}`
      const data = await cachedJson<{ results?: Record<string, unknown>[] }>(env, `it:v1:${u}`, 7 * DAY, u, {}, waitUntil)
      if (!data) return json({ error: 'upstream_failed' }, 502)
      for (const r of data.results ?? []) if (r.wrapperType === 'collection' && /soundtrack/i.test(String(r.collectionName))) learn('films', String(r.collectionName))
      return json({ results: (data.results ?? []).map(compactItunes) }, 200, cacheHeaders)
    }
    case 'itunes:lookup': {
      const id = /^\d{1,12}$/.test(q.get('id') ?? '') ? q.get('id')! : null
      if (!id) return json({ error: 'bad_id' }, 400)
      const country = COUNTRY.test((q.get('country') ?? '').toUpperCase()) ? q.get('country')!.toUpperCase() : 'US'
      const entity = q.get('entity') === 'album' ? 'album' : 'song'
      const u = `https://itunes.apple.com/lookup?id=${id}&entity=${entity}&country=${country}&limit=200`
      const data = await cachedJson<{ results?: Record<string, unknown>[] }>(env, `it:v1:${u}`, 7 * DAY, u, {}, waitUntil)
      if (!data) return json({ error: 'upstream_failed' }, 502)
      return json({ results: (data.results ?? []).map(compactItunes) }, 200, cacheHeaders)
    }
    case 'deezer:isrc': {
      const isrc = (q.get('id') ?? '').toUpperCase().replace(/-/g, '')
      if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc)) return json({ error: 'bad_isrc' }, 400)
      const d = await deezerIsrc(env, isrc, waitUntil)
      return d ? json(d, 200, cacheHeaders) : json({ error: 'not_found' }, 404)
    }
    case 'deezer:search': {
      const u = `https://api.deezer.com/search?q=${encodeURIComponent(clip(q.get('q'), 120))}&limit=10`
      const data = await cachedJson<{ data?: { id: number; title: string; duration: number; artist?: { name: string }; album?: { title: string } }[] }>(env, `dz:v1:${u}`, 7 * DAY, u, {}, waitUntil)
      return json({ results: (data?.data ?? []).map((t) => ({ id: t.id, title: t.title, durationMs: t.duration * 1000, artist: t.artist?.name, album: t.album?.title })) }, 200, cacheHeaders)
    }
    case 'netease:search': {
      const u = `https://music.163.com/api/search/get?s=${encodeURIComponent(clip(q.get('q'), 120))}&type=1&limit=12`
      const data = await cachedJson<{ result?: { songs?: { id: number; name: string; duration: number; artists?: { name: string }[]; album?: { name: string } }[] } }>(env, `ne:v1:${u}`, 7 * DAY, u, { Referer: 'https://music.163.com/' }, waitUntil)
      return json({ results: (data?.result?.songs ?? []).map((s) => ({ id: String(s.id), title: s.name, durationMs: s.duration, artists: (s.artists ?? []).map((a) => a.name), album: s.album?.name ?? null })) }, 200, cacheHeaders)
    }
    case 'netease:lyric': {
      const id = /^\d{1,14}$/.test(q.get('id') ?? '') ? q.get('id')! : null
      if (!id) return json({ error: 'bad_id' }, 400)
      const u = `https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=-1`
      const data = await cachedJson<{ lrc?: { lyric?: string }; nolyric?: boolean; uncollected?: boolean }>(env, `ne:v1:${u}`, 14 * DAY, u, { Referer: 'https://music.163.com/' }, waitUntil)
      return json({ lrc: data?.lrc?.lyric ?? null, instrumental: !!data?.nolyric }, 200, cacheHeaders)
    }
    case 'mb:recording-search': {
      const title = clip(q.get('t'), 120).replace(/"/g, '')
      const artist = clip(q.get('a'), 120).replace(/"/g, '')
      const r = await mbSearch(env, title, artist, waitUntil)
      return json({ results: r }, 200, cacheHeaders)
    }
    case 'wd:film': {
      const f = await wikidataFilm(env, clip(q.get('q'), 100), Number(q.get('year')) || null, waitUntil)
      return f ? json(f, 200, cacheHeaders) : json({ error: 'not_found' }, 404)
    }
    default:
      return json({ error: 'bad_endpoint' }, 400)
  }
}

function compactItunes(r: Record<string, unknown>) {
  const art = typeof r.artworkUrl100 === 'string' ? r.artworkUrl100 : null
  return {
    type: r.wrapperType === 'collection' ? 'album' : r.wrapperType === 'artist' ? 'artist' : 'song',
    id: r.trackId ?? r.collectionId ?? r.artistId ?? null,
    collectionId: r.collectionId ?? null,
    title: r.trackName ?? r.collectionName ?? r.artistName ?? null,
    album: r.collectionName ?? null,
    artist: r.artistName ?? null,
    artistId: r.artistId ?? null,
    durationMs: r.trackTimeMillis ?? null,
    trackNumber: r.trackNumber ?? null,
    discNumber: r.discNumber ?? null,
    trackCount: r.trackCount ?? null,
    releaseDate: typeof r.releaseDate === 'string' ? r.releaseDate.slice(0, 10) : null,
    genre: r.primaryGenreName ?? null,
    explicit: r.trackExplicitness === 'explicit' || r.collectionExplicitness === 'explicit',
    artwork: art ? art.replace(/\/\d+x\d+bb\./, '/1200x1200bb.') : null,
    url: r.trackViewUrl ?? r.collectionViewUrl ?? r.artistLinkUrl ?? null,
  }
}

// ── Deezer (tempo + loudness) ────────────────────────────────────────────────
async function deezerIsrc(env: ApiEnv, isrc: string, waitUntil?: WaitUntil) {
  const u = `https://api.deezer.com/track/isrc:${isrc}`
  const t = await cachedJson<{ id?: number; title?: string; bpm?: number; gain?: number; duration?: number; release_date?: string; link?: string; error?: unknown }>(env, `dz:v1:${u}`, 30 * DAY, u, {}, waitUntil)
  if (!t || t.error || !t.id) return null
  return { id: t.id, title: t.title, bpm: t.bpm && t.bpm > 0 ? t.bpm : null, gainDb: t.gain ?? null, durationMs: t.duration ? t.duration * 1000 : null, released: t.release_date ?? null, link: t.link ?? null }
}

/** A recording on Deezer by title + artist (+ length): its id and ISRC. */
async function deezerFind(env: ApiEnv, title: string, artist: string, durationMs: number | null, waitUntil?: WaitUntil): Promise<{ id: number; isrc: string | null } | null> {
  const q = `${artist.replace(/"/g, '')} ${title.replace(/"/g, '')}`
  const u = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`
  const data = await cachedJson<{ data?: { id: number; title: string; duration: number; artist?: { name: string } }[] }>(env, `dz:v1:${u}`, 30 * DAY, u, {}, waitUntil)
  const best = (data?.data ?? [])
    .filter((t) => similarity(t.title, title) >= 0.75 && similarity(t.artist?.name ?? '', artist) >= 0.4)
    .filter((t) => !durationMs || Math.abs(t.duration * 1000 - durationMs) <= 40_000)
    .sort((a, b) => (durationMs ? Math.abs(a.duration * 1000 - durationMs) - Math.abs(b.duration * 1000 - durationMs) : 0))[0]
  if (!best) return null
  const tu = `https://api.deezer.com/track/${best.id}`
  const t = await cachedJson<{ id?: number; isrc?: string }>(env, `dz:v1:${tu}`, 30 * DAY, tu, {}, waitUntil)
  return { id: best.id, isrc: t?.isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(t.isrc) ? t.isrc : null }
}

/** The same recording on MusicBrainz, looked up by ISRC. */
async function mbIsrc(env: ApiEnv, isrc: string, waitUntil?: WaitUntil): Promise<string | null> {
  const u = `https://musicbrainz.org/ws/2/isrc/${isrc}?fmt=json`
  const d = await cachedJson<{ recordings?: { id: string }[] }>(env, `mb:v1:${u}`, 30 * DAY, u, MB_HEADERS, waitUntil)
  return d?.recordings?.[0]?.id ?? null
}

// ── MusicBrainz (writers, producers, ISRC) ───────────────────────────────────
const MB_HEADERS = { 'User-Agent': `${USER_AGENT} ( arnav music web )` }
const tokens = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
/** Every word of [short] appears in [long], starting with the same word ("Brahmastra" ⊂ "Brahmāstra: Part One – Shiva"). */
function containsTitle(long: string, short: string): boolean {
  const l = tokens(long); const s = tokens(short)
  return s.length > 0 && l[0] === s[0] && s.every((t) => l.includes(t))
}
function similarity(a: string, b: string): number {
  const x = new Set(tokens(a)); const y = new Set(tokens(b))
  if (!x.size || !y.size) return 0
  let common = 0
  for (const t of x) if (y.has(t)) common++
  return (2 * common) / (x.size + y.size)
}

interface MbRecording { id: string; title: string; length?: number; score?: number; 'artist-credit'?: { name: string }[]; isrcs?: string[] }
async function mbSearch(env: ApiEnv, title: string, artist: string, waitUntil?: WaitUntil) {
  if (!title) return []
  const query = artist ? `recording:"${title}" AND artist:"${artist}"` : `recording:"${title}"`
  const u = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&limit=8&fmt=json`
  const data = await cachedJson<{ recordings?: MbRecording[] }>(env, `mb:v1:${u}`, 30 * DAY, u, MB_HEADERS, waitUntil)
  return (data?.recordings ?? []).map((r) => ({ id: r.id, title: r.title, lengthMs: r.length ?? null, score: r.score ?? 0, artist: (r['artist-credit'] ?? []).map((a) => a.name).join(', ') }))
}

interface MbRel { type: string; artist?: { name: string; id: string }; attributes?: string[]; work?: { title: string; relations?: MbRel[] } }
async function mbCredits(env: ApiEnv, title: string, artist: string, durationMs: number | null, waitUntil?: WaitUntil): Promise<{ entries: CreditEntry[]; isrc: string | null; isrcs: string[]; mbid: string | null }> {
  const empty = { entries: [], isrc: null, isrcs: [] as string[], mbid: null }
  const results = await mbSearch(env, title, artist, waitUntil)
  const best = results
    .filter((r) => r.score >= 80 && similarity(r.title, title) >= 0.6 && (!artist || similarity(r.artist, artist) >= 0.3))
    .sort((a, b) => (durationMs && a.lengthMs && b.lengthMs ? Math.abs(a.lengthMs - durationMs) - Math.abs(b.lengthMs - durationMs) : 0) || b.score - a.score)[0]
  if (!best) return empty
  if (durationMs && best.lengthMs && Math.abs(best.lengthMs - durationMs) > 45_000) return empty
  // MusicBrainz asks for about one request a second.
  await new Promise((r) => setTimeout(r, 1000))
  const u = `https://musicbrainz.org/ws/2/recording/${best.id}?inc=artist-rels+work-rels+work-level-rels+isrcs&fmt=json`
  const rec = await cachedJson<{ relations?: MbRel[]; isrcs?: string[] }>(env, `mb:v1:${u}`, 30 * DAY, u, MB_HEADERS, waitUntil)
  if (!rec) return { ...empty, mbid: best.id }
  const b = new CreditsBuilder()
  const link = (id?: string) => (id ? `https://musicbrainz.org/artist/${id}` : undefined)
  for (const r of rec.relations ?? []) {
    if (r.work) {
      for (const w of r.work.relations ?? []) {
        if (!w.artist) continue
        const role = w.type === 'composer' ? 'Composer' : w.type === 'lyricist' ? 'Lyricist' : w.type === 'writer' ? 'Writer' : w.type === 'arranger' ? 'Arranger' : null
        if (role) b.add({ group: 'WRITTEN', role, name: w.artist.name, person: true, source: 'MusicBrainz', link: link(w.artist.id) })
      }
      continue
    }
    if (!r.artist) continue
    const t = r.type
    const entry = t === 'producer' ? ['PRODUCED', 'Producer'] : t === 'mix' ? ['ENGINEERING', 'Mixing engineer'] : t === 'mastering' ? ['ENGINEERING', 'Mastering engineer']
      : t === 'recording' || t === 'engineer' ? ['ENGINEERING', 'Engineer'] : t === 'vocal' ? ['PERFORMED', r.attributes?.length ? r.attributes.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'Vocals']
        : t === 'instrument' ? ['PERFORMED', (r.attributes?.[0] ?? 'Instruments').replace(/^./, (c) => c.toUpperCase())] : null
    if (entry) b.add({ group: entry[0] as CreditEntry['group'], role: entry[1], name: r.artist.name, person: true, source: 'MusicBrainz', link: link(r.artist.id) })
  }
  return { entries: b.entries, isrc: rec.isrcs?.[0] ?? null, isrcs: rec.isrcs ?? [], mbid: best.id }
}

// ── Wikidata (films) ─────────────────────────────────────────────────────────
interface WdPerson { name: string; wiki: string | null }
export interface WdFilm { id: string; title: string; year: number | null; description: string | null; wiki: string | null; imdb: string | null; image: string | null; director: WdPerson[]; cast: WdPerson[]; composer: WdPerson[]; producer: WdPerson[]; lyricist: WdPerson[] }
type Claims = Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>
interface WdEntity { id: string; labels?: Record<string, { value: string }>; descriptions?: Record<string, { value: string }>; sitelinks?: Record<string, { title: string }>; claims?: Claims }

async function wikidataFilm(env: ApiEnv, name: string, year: number | null, waitUntil?: WaitUntil): Promise<WdFilm | null> {
  const title = filmName(name)
  if (title.length < 2) return null
  const su = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(title)}&language=en&type=item&limit=10&format=json`
  const s = await cachedJson<{ search?: { id: string; label?: string; description?: string }[] }>(env, `wd:v1:${su}`, 30 * DAY, su, {}, waitUntil)
  const films = (s?.search ?? []).filter((x) => /\b(film|movie)\b/i.test(x.description ?? '') && !/soundtrack|song|album|series|actor|actress/i.test(x.description ?? '') && (similarity(x.label ?? '', title) >= 0.8 || containsTitle(x.label ?? '', title)))
  const pick = films.sort((a, b) => yearScore(b.description, year) - yearScore(a.description, year))[0]
  if (!pick) return null
  const eu = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${pick.id}&props=labels|descriptions|claims|sitelinks&languages=en&sitefilter=enwiki&format=json`
  const e = (await cachedJson<{ entities?: Record<string, WdEntity> }>(env, `wd:v1:${eu}`, 30 * DAY, eu, {}, waitUntil))?.entities?.[pick.id]
  if (!e?.claims) return null
  const ids = (p: string, n = 8) => (e.claims?.[p] ?? []).map((c) => (c.mainsnak?.datavalue?.value as { id?: string } | undefined)?.id).filter((x): x is string => !!x).slice(0, n)
  const people = [...new Set([...ids('P57', 4), ...ids('P161', 8), ...ids('P86', 4), ...ids('P162', 4), ...ids('P676', 4)])]
  const lu = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${people.join('|')}&props=labels|sitelinks&languages=en&sitefilter=enwiki&format=json`
  const labels = people.length ? (await cachedJson<{ entities?: Record<string, WdEntity> }>(env, `wd:v1:${lu}`, 30 * DAY, lu, {}, waitUntil))?.entities ?? {} : {}
  const person = (id: string): WdPerson | null => {
    const l = labels[id]?.labels?.en?.value
    if (!l) return null
    const w = labels[id]?.sitelinks?.enwiki?.title
    return { name: l, wiki: w ? `https://en.wikipedia.org/wiki/${encodeURIComponent(w.replace(/ /g, '_'))}` : null }
  }
  const list = (p: string, n = 8) => ids(p, n).map(person).filter((x): x is WdPerson => !!x)
  const time = (e.claims.P577?.[0]?.mainsnak?.datavalue?.value as { time?: string } | undefined)?.time
  const image = e.claims.P18?.[0]?.mainsnak?.datavalue?.value as string | undefined
  const imdb = e.claims.P345?.[0]?.mainsnak?.datavalue?.value as string | undefined
  const wiki = e.sitelinks?.enwiki?.title
  learn('films', e.labels?.en?.value ?? title)
  return {
    id: e.id,
    title: e.labels?.en?.value ?? title,
    year: time ? Number(time.slice(1, 5)) || null : null,
    description: e.descriptions?.en?.value ?? null,
    wiki: wiki ? `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.replace(/ /g, '_'))}` : null,
    imdb: imdb ? `https://www.imdb.com/title/${imdb}/` : null,
    image: image ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(image)}?width=640` : null,
    director: list('P57', 4), cast: list('P161', 8), composer: list('P86', 4), producer: list('P162', 4), lyricist: list('P676', 4),
  }
}
function yearScore(desc: string | undefined, year: number | null): number {
  if (!year || !desc) return 0
  const m = /\b(19|20)\d\d\b/.exec(desc)
  if (!m) return 0
  const d = Math.abs(Number(m[0]) - year)
  return d === 0 ? 3 : d === 1 ? 2 : d <= 3 ? 1 : 0
}

// ── Credits aggregate ────────────────────────────────────────────────────────
const CREDITS_V = 11
interface YtSnippet { title?: string; channelTitle?: string; description?: string; publishedAt?: string }

async function ytSnippet(env: ApiEnv, id: string, waitUntil?: WaitUntil): Promise<YtSnippet | null> {
  const key = env.YOUTUBE_API_KEY?.trim()
  if (!key) return null
  const headers: Record<string, string> = {}
  if (env.YOUTUBE_ANDROID_PACKAGE && env.YOUTUBE_ANDROID_CERT) { headers['X-Android-Package'] = env.YOUTUBE_ANDROID_PACKAGE; headers['X-Android-Cert'] = env.YOUTUBE_ANDROID_CERT }
  const r = await cached(env, `yt:v1:videos?id=${id}&part=snippet`, 7 * DAY, async () => {
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${id}&part=snippet&key=${key}`, { headers })
    return { status: res.status, body: await res.text() }
  }, waitUntil).catch(() => null)
  if (!r || r.status !== 200) return null
  try { return (JSON.parse(r.body) as { items?: { snippet?: YtSnippet }[] }).items?.[0]?.snippet ?? null } catch { return null }
}

export async function creditsApi(url: URL, env: ApiEnv, waitUntil?: WaitUntil): Promise<Response> {
  const v = url.searchParams.get('v') ?? ''
  if (!VIDEO_ID.test(v)) return json({ error: 'bad_id' }, 400)
  const key = `cr:v${CREDITS_V}:${v}`
  const kv = env.YT_CACHE
  const hit = kv ? await kv.get(key).catch(() => null) : null
  if (hit) return new Response(hit, { headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600', 'x-arnav-cache': 'hit' } })

  const sources = new Set<string>()
  const sn = await ytSnippet(env, v, waitUntil)
  const known = await knownSets(env)
  const raw = sn?.title ?? clip(url.searchParams.get('t'))
  const channel = sn?.channelTitle ?? ''
  const parsed = raw ? parseYouTubeTitle(raw, channel, { isKnownArtist: (n) => known.artists.has(nameKey(n)), isKnownFilm: (n) => known.films.has(nameKey(n)) }) : null
  const title = parsed?.title || clip(url.searchParams.get('t'))
  const artist = (parsed && !parsed.fromChannel ? parsed.artist : clip(url.searchParams.get('a'))) || parsed?.artist || ''
  const durationMs = Number(url.searchParams.get('d')) || null

  const fromDescription = sn?.description ? parseDescriptionCredits(sn.description) : []
  if (fromDescription.length) sources.add('YouTube description')
  const fromTitle = new CreditsBuilder()
  if (parsed && !parsed.fromChannel) {
    parsed.artist.split(/\s*,\s*|\s+&\s+/).filter(Boolean).forEach((n, i) => fromTitle.person('PERFORMED', i === 0 ? 'Artist' : 'Featured artist', n, 'Title'))
  }
  const label = isLabelChannel(channel)
  const album = parsed?.album ?? fromDescription.find((e) => e.role === 'Album')?.name ?? (clip(url.searchParams.get('al')) || null)
  if (label && parsed?.album && parsed.credits?.includes(',')) parsed.credits.split(',').map((s) => s.trim()).filter(Boolean).forEach((n) => fromTitle.person('FILM', 'Cast', n, 'Title'))
  if (fromTitle.entries.length) sources.add('Title')

  const hasWriters = fromDescription.some((e) => e.group === 'WRITTEN')
  const filmish = label || fromDescription.some((e) => e.group === 'FILM') || /\b(movie|film|soundtrack)\b/i.test(sn?.description ?? '')
  const year = sn?.publishedAt ? Number(sn.publishedAt.slice(0, 4)) : null
  const [mb, film] = await Promise.all([
    hasWriters && fromDescription.some((e) => e.role === 'ISRC') ? Promise.resolve({ entries: [] as CreditEntry[], isrc: null, isrcs: [] as string[], mbid: null }) : mbCredits(env, title, artist.split(',')[0] ?? '', durationMs, waitUntil).catch(() => ({ entries: [] as CreditEntry[], isrc: null, isrcs: [] as string[], mbid: null })),
    album && filmish ? wikidataFilm(env, album, year, waitUntil).catch(() => null) : Promise.resolve(null),
  ])
  if (mb.entries.length || mb.isrc) sources.add('MusicBrainz')
  const filmEntries: CreditEntry[] = []
  if (film) {
    sources.add('Wikidata')
    for (const p of film.director) filmEntries.push({ group: 'FILM', role: 'Director', name: p.name, person: true, source: 'Wikidata', link: p.wiki ?? undefined })
    for (const p of film.cast) filmEntries.push({ group: 'FILM', role: 'Cast', name: p.name, person: true, source: 'Wikidata', link: p.wiki ?? undefined })
    for (const p of film.producer) filmEntries.push({ group: 'FILM', role: 'Producer', name: p.name, person: true, source: 'Wikidata', link: p.wiki ?? undefined })
    // The film's composer only stands in when the song itself names none.
    if (!hasWriters && !mb.entries.some((e) => e.group === 'WRITTEN')) for (const p of film.composer) filmEntries.push({ group: 'WRITTEN', role: 'Music director (film)', name: p.name, person: true, source: 'Wikidata', link: p.wiki ?? undefined })
  }
  let isrc = fromDescription.find((e) => e.role === 'ISRC')?.name ?? mb.isrc
  const isrcFrom = fromDescription.some((e) => e.role === 'ISRC') ? 'YouTube description' : mb.isrc ? 'MusicBrainz' : null
  // No ISRC yet: find the recording on Deezer (title, artist, length) and take its ISRC.
  let deezerFound: { id: number; isrc: string | null } | null = null
  if (!isrc && title && artist) deezerFound = await deezerFind(env, title, artist.split(',')[0] ?? '', durationMs, waitUntil).catch(() => null)
  if (!isrc && deezerFound?.isrc) isrc = deezerFound.isrc
  let audio = isrc ? await deezerIsrc(env, isrc, waitUntil).catch(() => null) : null
  // That ISRC may be a re-release Deezer doesn't carry: try the recording's other ISRCs, then Deezer's own search.
  for (const alt of mb.isrcs.slice(1, 6)) {
    if (audio) break
    const a2 = await deezerIsrc(env, alt, waitUntil).catch(() => null)
    if (a2) { audio = a2; isrc = alt }
  }
  if (!audio && !deezerFound && title && artist) {
    deezerFound = await deezerFind(env, title, artist.split(',')[0] ?? '', durationMs, waitUntil).catch(() => null)
    if (deezerFound?.isrc) { audio = await deezerIsrc(env, deezerFound.isrc, waitUntil).catch(() => null); if (audio) isrc = deezerFound.isrc }
  }
  if (audio) sources.add('Deezer')
  const isrcEntry: CreditEntry[] = isrc && !fromDescription.some((e) => e.role === 'ISRC') ? [{ group: 'IDENTIFIERS', role: 'ISRC', name: isrc, person: false, source: mb.isrcs.includes(isrc) ? 'MusicBrainz' : 'Deezer' }] : []
  // The same recording on MusicBrainz, by ISRC (exact identity, not a title guess).
  const mbByIsrc = isrc && !mb.mbid ? await mbIsrc(env, isrc, waitUntil).catch(() => null) : null

  const body = JSON.stringify({
    v: CREDITS_V,
    video: sn ? { title: sn.title, channel: sn.channelTitle, published: sn.publishedAt?.slice(0, 10) ?? null } : null,
    parsed: parsed ? { title: parsed.title, artist: parsed.artist, album } : null,
    entries: mergeCredits(fromDescription, fromTitle.entries, mb.entries, filmEntries, isrcEntry),
    film,
    audio: audio ? { bpm: audio.bpm, gainDb: audio.gainDb, link: audio.link } : null,
    identity: isrc ? {
      isrc,
      from: isrcFrom ?? (deezerFound?.isrc ? 'Deezer' : null),
      deezer: audio ? { id: audio.id, link: audio.link, durationMs: audio.durationMs, title: audio.title } : null,
      musicbrainz: mb.mbid ?? mbByIsrc,
    } : null,
    mbid: mb.mbid,
    lyrics: sn?.description ? descriptionLyrics(sn.description) : null,
    sources: [...sources],
  })
  if (kv) {
    const put = kv.put(key, body, { expirationTtl: 30 * DAY }).catch(() => undefined)
    if (waitUntil) waitUntil(put)
  }
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' } })
}

// ── Community lyrics (version + timing listeners agreed on) ──────────────────
interface Community { choices: Record<string, number>; offsets: Record<string, number[]>; scales: Record<string, number[]>; updatedAt: number }
const CHOICE = /^(lrclib|netease):\d{1,14}$/
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

function summarize(c: Community | null) {
  if (!c) return { choice: null, offsetMs: null, scale: null, votes: 0, samples: 0 }
  const best = Object.entries(c.choices).sort((a, b) => b[1] - a[1])[0]
  const k = best?.[0] ?? null
  return { choice: k, votes: best?.[1] ?? 0, offsetMs: k ? median(c.offsets[k] ?? []) : null, scale: k ? median(c.scales[k] ?? []) : null, samples: k ? (c.offsets[k] ?? []).length : 0 }
}

export async function communityApi(request: Request, url: URL, env: ApiEnv): Promise<Response> {
  const kv = env.YT_CACHE
  if (request.method === 'GET') {
    const v = url.searchParams.get('v') ?? ''
    if (!VIDEO_ID.test(v)) return json({ error: 'bad_id' }, 400)
    const raw = kv ? await kv.get(`cm:v1:${v}`).catch(() => null) : null
    return json(summarize(raw ? (JSON.parse(raw) as Community) : null), 200, { 'cache-control': 'public, max-age=60' })
  }
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  if (!kv) return json({ error: 'unavailable' }, 503)
  const text = await request.text()
  if (text.length > 2000) return json({ error: 'too_large' }, 413)
  let body: { v?: string; choice?: string; offsetMs?: number; scale?: number }
  try { body = JSON.parse(text) } catch { return json({ error: 'bad_json' }, 400) }
  if (!body.v || !VIDEO_ID.test(body.v) || !body.choice || !CHOICE.test(body.choice)) return json({ error: 'bad_request' }, 400)
  const key = `cm:v1:${body.v}`
  const raw = await kv.get(key).catch(() => null)
  const c: Community = raw ? JSON.parse(raw) : { choices: {}, offsets: {}, scales: {}, updatedAt: 0 }
  c.choices[body.choice] = (c.choices[body.choice] ?? 0) + 1
  if (typeof body.offsetMs === 'number' && Number.isFinite(body.offsetMs) && Math.abs(body.offsetMs) <= 120_000) {
    c.offsets[body.choice] = [...(c.offsets[body.choice] ?? []), Math.round(body.offsetMs)].slice(-25)
  }
  if (typeof body.scale === 'number' && body.scale >= 0.85 && body.scale <= 1.15) {
    c.scales[body.choice] = [...(c.scales[body.choice] ?? []), Math.round(body.scale * 10000) / 10000].slice(-25)
  }
  // Keep the record small: at most 8 competing versions.
  const keep = Object.entries(c.choices).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k)
  c.choices = Object.fromEntries(keep.map((k) => [k, c.choices[k]]))
  c.offsets = Object.fromEntries(keep.filter((k) => c.offsets[k]).map((k) => [k, c.offsets[k]]))
  c.scales = Object.fromEntries(keep.filter((k) => c.scales[k]).map((k) => [k, c.scales[k]]))
  c.updatedAt = Date.now()
  await kv.put(key, JSON.stringify(c), { expirationTtl: 400 * DAY }).catch(() => undefined)
  return json(summarize(c))
}

export async function knownApi(env: ApiEnv): Promise<Response> {
  const s = await knownSets(env)
  return json({ artists: [...s.artists].slice(-8000), films: [...s.films].slice(-6000) }, 200, { 'cache-control': 'public, max-age=1800, s-maxage=3600' })
}
