/**
 * Arnav's recommender (v2) — on device, deterministic, explainable.
 *
 * A model is built from your history once per library change:
 *  - artist taste on three clocks: long-term (45-day half-life), short-term (the last few days) and
 *    this time of day (what you play in the morning vs late at night);
 *  - a listening graph: which song tends to follow which, and which artists share your sessions;
 *  - scene and genre taste (Bollywood, Punjabi, Latin, Arabic, K-pop… detected from the uploads);
 *  - feedback: early skips (per song and per artist), "not interested", and fatigue for songs
 *    you've played a lot in the last few days.
 * Candidates are scored per shelf (quick picks, discovery, radio…), rotated a little each day, and
 * picked with a diversity pass so one artist or album never floods a shelf. Every pick carries the
 * reason it was chosen, in words.
 */
import type { PlayEvent, Track, TrackId } from './types'
import { artistKey } from './types'
import { isSingle } from './classify'

const DAY = 86_400_000
const HOUR = 3_600_000

export type Scene = 'bollywood' | 'punjabi' | 'tamil' | 'telugu' | 'latin' | 'arabic' | 'kpop' | 'jpop' | 'western'
const SCENE_LABEL: Record<Scene, string> = { bollywood: 'Bollywood', punjabi: 'Punjabi', tamil: 'Tamil', telugu: 'Telugu', latin: 'Latin', arabic: 'Arabic', kpop: 'K-pop', jpop: 'J-pop', western: 'International' }

/** The music scene an upload belongs to, from its script, channel and title. */
export function sceneOf(t: Pick<Track, 'title' | 'artist' | 'channelTitle' | 'rawTitle' | 'album'>): Scene | null {
  const text = `${t.rawTitle ?? t.title} ${t.artist}`
  const ch = (t.channelTitle ?? '').toLowerCase()
  if (/[਀-੿]/.test(text) || /speed records|white hill|desi music factory|geet mp3|jass records|humble music|brown boys|5911 records|sidhu moose wala|diljit|ap dhillon|karan aujla/.test(`${ch} ${t.artist.toLowerCase()}`) || /\bpunjabi\b/i.test(text)) return 'punjabi'
  if (/[஀-௿]/.test(text) || /\btamil\b|think music|sony music south|lahari/i.test(`${text} ${ch}`)) return 'tamil'
  if (/[ఀ-౿]/.test(text) || /\btelugu\b|aditya music|mango music/i.test(`${text} ${ch}`)) return 'telugu'
  if (/[ऀ-ॿ]/.test(text) || /t-series|tseries|sony music india|zee music|tips (official|music)|saregama|yrf|eros now|times music|shemaroo|junglee/.test(ch) || /\b(bollywood|hindi)\b/i.test(text)) return 'bollywood'
  if (/[؀-ۿ]/.test(text) || /\b(rotana|mazzika|arabic)\b/i.test(`${text} ${ch}`)) return 'arabic'
  if (/[가-힯]/.test(text) || /hybe|smtown|jyp|ygentertainment|1thek|stone music/i.test(ch)) return 'kpop'
  if (/[぀-ヿ]/.test(text)) return 'jpop'
  if (/[ñ¿¡]|\b(oficial|letra|reggaet[oó]n|bachata|corrido)\b/i.test(text)) return 'latin'
  if (/VEVO$/i.test(t.channelTitle ?? '') || /- Topic$/.test(t.channelTitle ?? '')) return 'western'
  return null
}

/** Live, remix, slowed… — another take of a song (shown only if you play those). */
const VERSION = /\b(live|remix|reprise|acoustic|unplugged|slowed|reverb|sped up|lo-?fi|karaoke|instrumental|cover|mashup|8d|tour)\b/i
/** One key per song across uploads: the artist plus the title up to any bracket or dash. */
export const songKey = (t: Pick<Track, 'artist' | 'title'>) => `${artistKey(t.artist.split(',')[0])}|${t.title.toLowerCase().split(/\s*[([]|\s+[-–|]\s+/)[0].replace(/[^\p{L}\p{N}]+/gu, '')}`

export type Mode = 'quick' | 'discover' | 'familiar' | 'radio' | 'trending'

export interface RecModel {
  now: number
  artistLong: Map<string, number>
  artistShort: Map<string, number>
  artistNow: Map<string, number>
  genre: Map<string, number>
  scene: Map<Scene, number>
  trackTaste: Map<TrackId, number>
  plays: Map<TrackId, number>
  earlySkips: Map<TrackId, number>
  artistSkipRate: Map<string, number>
  recent72h: Map<TrackId, number>
  lastPlayed: Map<TrackId, number>
  /** Song → songs that followed it in a session (counts). */
  next: Map<TrackId, Map<TrackId, number>>
  /** Artist → artists in the same sessions (association strength 0..1). */
  coArtist: Map<string, Map<string, number>>
  /** The last few songs you played (the "context" for quick picks). */
  recent: TrackId[]
  liked: Set<TrackId>
  seeds: Set<string>
  cold: boolean
}

const norm = <K>(m: Map<K, number>): Map<K, number> => {
  let top = 0
  m.forEach((v) => { if (v > top) top = v })
  const out = new Map<K, number>()
  if (top > 0) m.forEach((v, k) => { if (v > 0) out.set(k, v / top) })
  return out
}
const bump = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v)
const daypart = (h: number) => (h < 5 ? 0 : h < 12 ? 1 : h < 17 ? 2 : h < 22 ? 3 : 0)

export function buildModel(events: PlayEvent[], tracks: (id: TrackId) => Track | undefined, liked: Set<TrackId>, opts: { now?: number; seedArtists?: string[] } = {}): RecModel {
  const now = opts.now ?? Date.now()
  const long = new Map<string, number>(), short = new Map<string, number>(), nowA = new Map<string, number>()
  const genre = new Map<string, number>(), scene = new Map<Scene, number>()
  const trackTaste = new Map<TrackId, number>(), plays = new Map<TrackId, number>(), earlySkips = new Map<TrackId, number>()
  const artistPlays = new Map<string, number>(), artistSkips = new Map<string, number>()
  const recent72h = new Map<TrackId, number>(), lastPlayed = new Map<TrackId, number>()
  const part = daypart(new Date(now).getHours())
  const sorted = [...events].sort((a, b) => a.startedAt - b.startedAt)
  for (const e of sorted) {
    const age = Math.max(0, now - e.startedAt) / DAY
    const cr = e.durationMs ? Math.min(1, e.listenedMs / e.durationMs) : e.completed ? 1 : 0.5
    const early = e.skipped && (cr < 0.25 || e.listenedMs < 30_000)
    // A finished song is a strong yes; an early skip is a no.
    const eng = early ? -0.6 : 0.2 + 0.8 * cr
    const t = tracks(e.trackId)
    bump(long, e.artistKey, eng * Math.pow(0.5, age / 45))
    bump(short, e.artistKey, eng * Math.pow(0.5, age / 1.5))
    if (daypart(new Date(e.startedAt).getHours()) === part) bump(nowA, e.artistKey, eng * Math.pow(0.5, age / 30))
    bump(trackTaste, e.trackId, eng * Math.pow(0.5, age / 60))
    if (!early) bump(plays, e.trackId, 1)
    if (early) bump(earlySkips, e.trackId, 1)
    bump(artistPlays, e.artistKey, 1)
    if (early) bump(artistSkips, e.artistKey, 1)
    if (now - e.startedAt < 72 * HOUR && !early) bump(recent72h, e.trackId, 1)
    lastPlayed.set(e.trackId, Math.max(lastPlayed.get(e.trackId) ?? 0, e.startedAt))
    if (t && eng > 0) {
      const w = eng * Math.pow(0.5, age / 45)
      t.genres?.forEach((g) => bump(genre, g.toLowerCase(), w))
      const s = sceneOf(t)
      if (s) bump(scene, s, w)
    }
  }
  for (const id of liked) {
    const t = tracks(id)
    if (!t) continue
    bump(long, artistKey(t.artist), 1.2)
    bump(trackTaste, id, 1.5)
    t.genres?.forEach((g) => bump(genre, g.toLowerCase(), 0.6))
    const s = sceneOf(t)
    if (s) bump(scene, s, 0.8)
  }
  // Sessions (a gap of 30 min starts a new one) → song transitions and artist co-occurrence.
  const next = new Map<TrackId, Map<TrackId, number>>()
  const pair = new Map<string, Map<string, number>>()
  const artistSessions = new Map<string, number>()
  let session: PlayEvent[] = []
  const flush = () => {
    const keys = [...new Set(session.filter((e) => !e.skipped || e.listenedMs > 30_000).map((e) => e.artistKey))]
    keys.forEach((k) => bump(artistSessions, k, 1))
    for (const a of keys) for (const b of keys) if (a !== b) { const m = pair.get(a) ?? new Map<string, number>(); bump(m, b, 1); pair.set(a, m) }
    for (let i = 0; i < session.length - 1; i++) {
      const a = session[i], b = session[i + 1]
      if (a.trackId === b.trackId || (b.skipped && b.listenedMs < 30_000)) continue
      const m = next.get(a.trackId) ?? new Map<TrackId, number>()
      bump(m, b.trackId, 1)
      next.set(a.trackId, m)
    }
    session = []
  }
  for (const e of sorted) {
    const last = session[session.length - 1]
    if (last && e.startedAt - (last.startedAt + last.listenedMs) > 30 * 60_000) flush()
    session.push(e)
  }
  flush()
  // Association: co-sessions / sqrt(sessions a × sessions b) — 1 when two artists always appear together.
  const coArtist = new Map<string, Map<string, number>>()
  pair.forEach((m, a) => {
    const out = new Map<string, number>()
    m.forEach((c, b) => out.set(b, c / Math.sqrt((artistSessions.get(a) ?? 1) * (artistSessions.get(b) ?? 1))))
    coArtist.set(a, out)
  })
  const artistSkipRate = new Map<string, number>()
  artistPlays.forEach((n, k) => { if (n >= 3) artistSkipRate.set(k, (artistSkips.get(k) ?? 0) / n) })
  const recent = sorted.filter((e) => !e.skipped || e.listenedMs > 45_000).slice(-6).map((e) => e.trackId).reverse()
  return {
    now, artistLong: norm(long), artistShort: norm(short), artistNow: norm(nowA), genre: norm(genre), scene: norm(scene),
    trackTaste: norm(trackTaste), plays, earlySkips, artistSkipRate, recent72h, lastPlayed, next, coArtist, recent, liked,
    seeds: new Set((opts.seedArtists ?? []).map(artistKey)), cold: events.length < 8 && liked.size < 5,
  }
}

export interface RecPick { track: Track; score: number; why: string; kind: 'context' | 'artist' | 'scene' | 'new' | 'popular' | 'liked' | 'favourite' | 'seed' }

/** A stable per-day wobble, so shelves rotate daily without reshuffling on every visit. */
function jitter(id: string, now: number): number {
  const day = Math.floor(now / DAY)
  let h = 2166136261 ^ day
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return ((h >>> 0) % 1000) / 1000
}

export function scoreTrack(t: Track, m: RecModel, mode: Mode, opts: { seed?: Track | null; names?: (id: TrackId) => string | undefined } = {}): RecPick {
  const ak = artistKey(t.artist)
  const long = m.artistLong.get(ak) ?? 0, short = m.artistShort.get(ak) ?? 0, here = m.artistNow.get(ak) ?? 0
  const artist = 0.55 * long + 0.3 * short + 0.15 * here + (m.seeds.has(ak) ? (m.cold ? 0.7 : 0.15) : 0)
  // Context: songs that follow what you just played, and artists you play alongside them.
  let context = 0
  let because: TrackId | null = null
  const seeds = opts.seed ? [opts.seed.id] : m.recent
  seeds.forEach((sid, i) => {
    const decay = 1 / (1 + i * 0.6)
    const follows = m.next.get(sid)
    const f = follows ? (follows.get(t.id) ?? 0) / Math.max(...follows.values()) : 0
    if (f * decay > context) { context = f * decay; because = sid }
  })
  const seedArtists = opts.seed ? [artistKey(opts.seed.artist)] : [...new Set(m.recent.slice(0, 3).map((id) => opts.names?.(id)).filter(Boolean).map((n) => artistKey(n!)))]
  let co = 0
  for (const sa of seedArtists) co = Math.max(co, sa === ak ? (opts.seed ? 0.8 : 0.35) : m.coArtist.get(sa)?.get(ak) ?? 0)
  const scene = sceneOf(t)
  const sceneAff = scene ? m.scene.get(scene) ?? 0 : 0
  const genreAff = Math.max(0, ...(t.genres ?? []).map((g) => m.genre.get(g.toLowerCase()) ?? 0))
  const style = Math.max(sceneAff, genreAff)
  const fam = Math.max(0, m.trackTaste.get(t.id) ?? 0)
  const novelty = 1 - Math.min(1, fam * 1.5)
  const pop = t.views ? Math.min(1, Math.log10(t.views + 1) / 9.5) : 0.3
  const liked = m.liked.has(t.id)
  const W = {
    quick: { artist: 0.9, context: 0.7, co: 0.45, style: 0.35, fam: 0.35, novelty: 0.18, pop: 0.08 },
    discover: { artist: 0.55, context: 0.35, co: 0.5, style: 0.6, fam: 0, novelty: 0.7, pop: 0.22 },
    familiar: { artist: 0.4, context: 0.2, co: 0.1, style: 0.1, fam: 1.0, novelty: 0, pop: 0 },
    radio: { artist: 0.6, context: 1.0, co: 0.9, style: 0.5, fam: 0.2, novelty: 0.25, pop: 0.1 },
    trending: { artist: 0.6, context: 0.2, co: 0.3, style: 0.7, fam: 0.1, novelty: 0.2, pop: 0.6 },
  }[mode]
  let s = W.artist * artist + W.context * context + W.co * co + W.style * style + W.fam * fam + W.novelty * novelty + W.pop * pop + (liked ? 0.25 : 0)
  // Feedback and fatigue.
  s -= Math.min(0.9, 0.35 * (m.earlySkips.get(t.id) ?? 0))
  s -= 0.35 * (m.artistSkipRate.get(ak) ?? 0)
  const last = m.lastPlayed.get(t.id)
  if (last && m.now - last < 90 * 60_000) s -= 1.2
  if (mode !== 'familiar') s -= 0.12 * Math.max(0, (m.recent72h.get(t.id) ?? 0) - 1)
  if (mode === 'familiar' && last) s += Math.min(0.5, (m.now - last) / (60 * DAY))
  // Another version (live, remix…) gives way to the original unless it's one you play.
  if (VERSION.test(t.rawTitle ?? t.title) && fam < 0.2 && !liked) s -= 0.3
  s += 0.07 * jitter(t.id, m.now)
  // The reason a listener would recognise.
  let kind: RecPick['kind'] = 'artist'
  let why = `More from ${t.artist}`
  const name = because ? opts.names?.(because) : undefined
  if (context > 0.3 && because && name) { kind = 'context'; why = `Because you played ${name}` }
  else if (opts.seed && co > 0.3 && ak !== artistKey(opts.seed.artist)) { kind = 'context'; why = `Fans of ${opts.seed.artist} play this` }
  else if (mode === 'familiar' && last) { kind = 'favourite'; why = `${m.plays.get(t.id) ?? 1} plays · last ${Math.round((m.now - last) / DAY)} days ago` }
  else if (liked) { kind = 'liked'; why = 'From your likes' }
  else if (m.cold && m.seeds.has(ak)) { kind = 'seed'; why = `Because you like ${t.artist}` }
  else if (fam < 0.05 && artist > 0.25) { kind = 'new'; why = `New from ${t.artist}` }
  else if (fam < 0.05 && style > 0.4 && scene) { kind = 'scene'; why = `${SCENE_LABEL[scene]} you're into` }
  else if (fam < 0.05) { kind = pop > 0.75 ? 'popular' : 'new'; why = pop > 0.75 ? 'Popular right now' : 'New to you' }
  else if (short > 0.6) why = `On repeat lately`
  return { track: t, score: s, why, kind }
}

/**
 * Ranks a pool for one shelf: scores every candidate, then picks greedily, trading score against
 * similarity to what's already picked (same artist, same album, artists you play together).
 */
export function recommend(pool: Track[], m: RecModel, opts: { mode: Mode; limit: number; seed?: Track | null; exclude?: Set<TrackId>; names?: (id: TrackId) => string | undefined; maxPerArtist?: number; onlyNew?: boolean } ): RecPick[] {
  const seen = new Set<string>()
  const scored: RecPick[] = []
  for (const t of pool) {
    if (opts.exclude?.has(t.id) || seen.has(t.id) || !isSingle(t)) continue
    seen.add(t.id)
    if (opts.onlyNew && (m.plays.get(t.id) ?? 0) > 0) continue
    scored.push(scoreTrack(t, m, opts.mode, { seed: opts.seed, names: opts.names }))
  }
  scored.sort((a, b) => b.score - a.score)
  // The same song from several uploads (official video, audio, live…) counts once: the best one stays.
  const songs = new Set<string>()
  const unique = scored.filter((p) => { const k = songKey(p.track); if (songs.has(k)) return false; songs.add(k); return true })
  scored.length = 0
  scored.push(...unique)
  const out: RecPick[] = []
  const perArtist = new Map<string, number>()
  const max = opts.maxPerArtist ?? (opts.mode === 'radio' ? 3 : 2)
  const candidates = scored.slice(0, Math.max(opts.limit * 6, 60))
  while (out.length < opts.limit && candidates.length) {
    let best = -1, bestVal = -Infinity
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      const ak = artistKey(c.track.artist)
      if ((perArtist.get(ak) ?? 0) >= max) continue
      let sim = 0
      for (const p of out.slice(-6)) {
        const pk = artistKey(p.track.artist)
        if (pk === ak) sim = Math.max(sim, out[out.length - 1] === p ? 1 : 0.6)
        else if (c.track.album && c.track.album === p.track.album) sim = Math.max(sim, 0.5)
        else sim = Math.max(sim, 0.4 * (m.coArtist.get(pk)?.get(ak) ?? 0))
      }
      const val = c.score - 0.35 * sim
      if (val > bestVal) { bestVal = val; best = i }
    }
    if (best < 0) break
    const [pick] = candidates.splice(best, 1)
    perArtist.set(artistKey(pick.track.artist), (perArtist.get(artistKey(pick.track.artist)) ?? 0) + 1)
    out.push(pick)
  }
  return out
}

/** Your top artists right now (long-term taste with a lift for what you've played lately). */
export function topArtistsNow(m: RecModel, limit = 8): string[] {
  const all = new Map<string, number>()
  m.artistLong.forEach((v, k) => all.set(k, v * 0.6))
  m.artistShort.forEach((v, k) => all.set(k, (all.get(k) ?? 0) + v * 0.4))
  m.seeds.forEach((k) => { if (!all.has(k)) all.set(k, 0.2) })
  return [...all.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k)
}
