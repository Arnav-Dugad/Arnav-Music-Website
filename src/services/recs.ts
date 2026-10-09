import { cachedSearch, search, ytQuotaState } from '../lib/youtube'
import { isSingle, titleSimilarity } from '../lib/classify'
import { buildProfile, diversify, rank, type Reason, type TasteProfile } from '../lib/taste'
import { artistKey, type MediaVariant, type PlayEvent, type Track, type TrackId } from '../lib/types'
import { allows, lib, likedIds, liveEvents } from '../state/library'
import { remember, trackRegistry } from '../state/tracks'
import { verified } from './catalog'
import { cleanTitle } from '../lib/lyrics'
import { artistOverlap, VARIANT } from '../lib/meta'
import { tuner } from '../lib/tuner'
import { buildModel, recommend, topArtistsNow, type RecModel } from '../lib/recommender'
import { settings } from '../state/settings'

let profileCache: { at: number; rev: number; profile: TasteProfile } | null = null

/** The listener's taste profile, recomputed at most once a minute or when the library changes. */
export function profile(): TasteProfile {
  const s = lib()
  if (profileCache && profileCache.rev === s.revision && Date.now() - profileCache.at < 60_000) return profileCache.profile
  const p = buildProfile(liveEvents(s.events), (id) => trackRegistry.get(id), likedIds(s.likes))
  profileCache = { at: Date.now(), rev: s.revision, profile: p }
  return p
}

let modelCache: { at: number; rev: number; seeds: string; model: RecModel } | null = null

/** The v2 recommender model (src/lib/recommender.ts), rebuilt when the library changes. */
export function model(): RecModel {
  const s = lib()
  const seeds = settings().seedArtists.join('|')
  if (modelCache && modelCache.rev === s.revision && modelCache.seeds === seeds && Date.now() - modelCache.at < 5 * 60_000) return modelCache.model
  const m = buildModel(liveEvents(s.events), (id) => trackRegistry.get(id), likedIds(s.likes), { seedArtists: settings().seedArtists })
  modelCache = { at: Date.now(), rev: s.revision, seeds, model: m }
  return m
}
const titleOf = (id: TrackId) => trackRegistry.get(id)?.title
const playablePool = () => verified(trackRegistry.all()).filter((t) => isSingle(t) && allows(t))

/** Splits history into listening sessions (gap > 30 min starts a new one). */
function sessions(events: PlayEvent[]): PlayEvent[][] {
  const sorted = [...events].sort((a, b) => a.startedAt - b.startedAt)
  const out: PlayEvent[][] = []
  let cur: PlayEvent[] = []
  for (const e of sorted) {
    const last = cur[cur.length - 1]
    if (last && e.startedAt - (last.startedAt + last.listenedMs) > 30 * 60_000) { out.push(cur); cur = [] }
    cur.push(e)
  }
  if (cur.length) out.push(cur)
  return out
}

/** Artists that share sessions with [key] in your history ("played together" statistics). */
export function coListenedArtists(key: string, limit = 4): { key: string; name: string; weight: number }[] {
  const counts = new Map<string, number>()
  const names = new Map<string, string>()
  for (const s of sessions(liveEvents())) {
    const keys = new Set(s.map((e) => e.artistKey))
    if (!keys.has(key)) continue
    keys.forEach((k) => {
      if (k === key) return
      counts.set(k, (counts.get(k) ?? 0) + 1)
      if (!names.has(k)) {
        const ev = s.find((e) => e.artistKey === k)
        const t = ev && trackRegistry.get(ev.trackId)
        if (t) names.set(k, t.artist)
      }
    })
  }
  return [...counts.entries()].filter(([k]) => names.has(k)).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, w]) => ({ key: k, name: names.get(k)!, weight: w }))
}

/** Songs that most often follow [id] in your sessions. */
export function followers(id: TrackId, limit = 5): TrackId[] {
  const counts = new Map<TrackId, number>()
  for (const s of sessions(liveEvents())) {
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i].trackId === id && s[i + 1].trackId !== id) counts.set(s[i + 1].trackId, (counts.get(s[i + 1].trackId) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k)
}

/** Searches with cache first; remote only while quota allows ([remoteBudget] searches). */
async function gather(queries: string[], remoteBudget: number): Promise<Track[]> {
  const out: Track[] = []
  let remote = 0
  for (const q of queries) {
    const c = await cachedSearch(q, 'SONGS')
    if (c) { out.push(...verified(c.tracks)); continue }
    if (remote >= remoteBudget || ytQuotaState() === 'EXHAUSTED') continue
    remote++
    try { out.push(...verified((await search(q, 'SONGS')).tracks)) } catch { /* keep what we have */ }
  }
  return out
}

export interface Rec { track: Track; reason: Reason; caption: string }


/** Start radio / More like this / endless radio. */
export async function radioFor(seed: Track, opts: { exclude?: Set<TrackId>; limit?: number; remoteBudget?: number } = {}): Promise<Rec[]> {
  const p = profile()
  const key = artistKey(seed.artist)
  const co = coListenedArtists(key, 3)
  const queries = [
    `${seed.artist} songs`,
    ...co.slice(0, 2).map((a) => `${a.name} songs`),
    ...(seed.genres[0] ? [`${seed.genres[0]} songs`] : []),
  ]
  const state = ytQuotaState()
  const budget = opts.remoteBudget ?? (state === 'NORMAL' ? 2 : state === 'CONSERVE' ? 1 : 0)
  const remote = await gather(queries, budget)
  const localPool = verified(trackRegistry.all()).filter((t) =>
    artistKey(t.artist) === key || co.some((a) => a.key === artistKey(t.artist)) || t.genres.some((g) => seed.genres.includes(g)))
  const followIds = new Set(followers(seed.id))
  const exclude = new Set([seed.id, ...(opts.exclude ?? [])])
  const recent = liveEvents().filter((e) => Date.now() - e.startedAt < 2 * 3600_000).map((e) => e.trackId)
  recent.forEach((id) => exclude.add(id))
  const candidates = [...trackRegistry.many([...followIds]), ...remote, ...localPool]
    .filter((t) => isSingle(t) && allows(t) && titleSimilarity(t.title, seed.title) < 0.8)
  void p
  const picks = recommend(candidates, model(), { mode: 'radio', limit: opts.limit ?? 25, seed, exclude, names: titleOf })
  return picks.map((x) => ({ track: x.track, reason: (x.kind === 'new' ? 'NEW_DISCOVERY' : x.kind === 'context' ? 'ARTIST_RETURNING' : 'GENRE_MATCH') as Reason, caption: followIds.has(x.track.id) ? `Often follows ${seed.title} in your sessions` : x.why }))
}

/** Home "For you right now": time-of-day aware ranking over everything known. */
export function forYouNow(limit = 16): Rec[] {
  const m = model()
  if (m.cold && !m.seeds.size) return []
  return recommend(playablePool(), m, { mode: 'quick', limit, names: titleOf }).map((x) => ({ track: x.track, reason: 'TIME_OF_DAY' as Reason, caption: x.why }))
}

/** Fresh finds: close to taste, never played. */
export function freshFinds(limit = 16): Rec[] {
  const m = model()
  if (m.cold) return []
  return recommend(playablePool(), m, { mode: 'discover', limit, onlyNew: true, names: titleOf }).filter((x) => x.score > 0.2).map((x) => ({ track: x.track, reason: 'NEW_DISCOVERY' as Reason, caption: x.why }))
}

/** A chart (e.g. YouTube's trending music) ordered for you: popular, close to your scenes. */
export function trendingForYou(chart: Track[], limit = 20): Rec[] {
  const m = model()
  const pool = verified(chart).filter((t) => isSingle(t) && allows(t))
  if (m.cold && !m.seeds.size) return pool.slice(0, limit).map((t) => ({ track: t, reason: 'NEW_DISCOVERY' as Reason, caption: 'Trending now' }))
  return recommend(pool, m, { mode: 'trending', limit, names: titleOf }).map((x) => ({ track: x.track, reason: 'NEW_DISCOVERY' as Reason, caption: x.why }))
}

/**
 * A new listener's picked artists: fetch some of their songs so Home has them from the first visit
 * (the shared edge cache usually answers, so it rarely costs quota).
 */
let warming: Promise<number> | null = null
export function warmSeeds(): Promise<number> {
  if (warming) return warming
  warming = (async () => {
    const seeds = settings().seedArtists.slice(0, 5)
    if (!seeds.length) return 0
    const all = verified(trackRegistry.all())
    const missing = seeds.filter((a) => all.filter((t) => artistKey(t.artist).includes(artistKey(a))).length < 4)
    if (!missing.length) return 0
    const state = ytQuotaState()
    const tracks = await gather(missing.map((a) => `${a} songs`), state === 'NORMAL' ? 4 : state === 'CONSERVE' ? 2 : 0)
    remember(tracks)
    modelCache = null
    return tracks.length
  })()
  return warming
}

/** Your top artists right now, with a track of theirs for artwork. */
export function topArtists(limit = 8): { key: string; name: string; track: Track }[] {
  const keys = topArtistsNow(model(), limit * 2)
  const out: { key: string; name: string; track: Track }[] = []
  const all = verified(trackRegistry.all())
  for (const k of keys) {
    const t = all.filter((x) => artistKey(x.artist) === k).sort((a, b) => (b.trust ?? 0) - (a.trust ?? 0))[0]
    if (t) out.push({ key: k, name: t.artist.split(',')[0].trim(), track: t })
    if (out.length >= limit) break
  }
  return out
}

/** Albums and soundtracks in your world, ranked by how much you like their artists (none played to death). */
export function albumsForYou(limit = 12): { name: string; artist: string; tracks: Track[]; art: string | null }[] {
  const m = model()
  const groups = new Map<string, Track[]>()
  for (const t of verified(trackRegistry.all())) {
    if (!t.album || !allows(t) || t.album.toLowerCase() === t.title.toLowerCase() || /single$/i.test(t.album)) continue
    const k = t.album.toLowerCase().replace(/\s*[([].*?[)\]]/g, '').trim()
    groups.set(k, [...(groups.get(k) ?? []), t])
  }
  const scored = [...groups.values()].filter((g) => g.length >= 2).map((g) => {
    const aff = Math.max(...g.map((t) => (m.artistLong.get(artistKey(t.artist)) ?? 0) + 0.5 * (m.artistShort.get(artistKey(t.artist)) ?? 0)))
    return { g, score: aff + 0.05 * g.length }
  }).sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ g }) => ({ name: g[0].album!, artist: g[0].artist.split(',')[0], tracks: g, art: g[0].artworkUrl ?? null }))
}

/** Rediscover: loved before, quiet lately. */
export function rediscover(limit = 16): Rec[] {
  const p = profile()
  const now = Date.now()
  const liked = likedIds()
  const pool = trackRegistry.many([...new Set([...p.trackPlayCounts.keys(), ...liked])])
    .filter((t) => allows(t) && (now - (p.lastPlayedAt.get(t.id) ?? 0)) > 30 * 86_400_000 && ((p.trackPlayCounts.get(t.id) ?? 0) >= 2 || liked.has(t.id)))
  return pool
    .sort((a, b) => (p.trackPlayCounts.get(b.id) ?? 0) - (p.trackPlayCounts.get(a.id) ?? 0))
    .slice(0, limit)
    .map((t) => ({ track: t, reason: 'FORGOTTEN_FAVORITE' as Reason, caption: (p.trackPlayCounts.get(t.id) ?? 0) >= 2 ? `${p.trackPlayCounts.get(t.id)} plays, none lately` : 'Liked, quiet lately' }))
}

export interface DailyMix { id: string; title: string; artists: string[]; tracks: Track[]; hue: number }

/** Daily mixes: clusters around your top artists, each a familiar core plus close new songs. */
export function dailyMixes(): DailyMix[] {
  const p = profile()
  if (p.isCold) return []
  const tops = [...p.artistAffinity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k]) => k)
  const used = new Set<string>()
  const mixes: DailyMix[] = []
  for (const seed of tops) {
    if (used.has(seed) || mixes.length >= 4) continue
    const co = coListenedArtists(seed, 3).map((a) => a.key)
    const cluster = [seed, ...co.filter((c) => !used.has(c))].slice(0, 3)
    cluster.forEach((c) => used.add(c))
    const tracks = verified(trackRegistry.all()).filter((t) => cluster.includes(artistKey(t.artist)) && isSingle(t) && allows(t))
    if (tracks.length < 5) continue
    const ranked = diversify(rank(tracks, p, { tune: tuner.multipliers(), liked: likedIds(), discovery: 0.3 }), 4).slice(0, 30).map((s) => s.track)
    const names = [...new Set(ranked.map((t) => t.artist))].slice(0, 3)
    mixes.push({ id: `daily_${seed}`, title: `Daily Mix ${mixes.length + 1}`, artists: names, tracks: ranked, hue: (mixes.length * 77 + 250) % 360 })
  }
  return mixes
}

/** Finds another upload of the same song — the "Topic" audio for Song mode, a video for Video mode. */
/**
 * The same song as another kind of upload — the official music video for Video mode, the audio
 * (Topic / official audio) for Song mode, or any other official upload when one fails.
 * The search query is fixed per song and mode, so the edge cache answers it for every visitor.
 */
export async function alternativeUpload(track: Track, want: MediaVariant | null, exclude: Set<string> = new Set()): Promise<Track | null> {
  const title = cleanTitle(track.title)
  const base = `${track.artistFromChannel ? '' : track.artist.split(',')[0]} ${title}`.trim().slice(0, 90)
  const query = want === 'VIDEO' ? `${base} official video` : want === 'SONG' ? `${base} audio` : base
  const results = (await cachedSearch(query, 'SONGS')) ?? (await search(query, 'SONGS').catch(() => null))
  if (!results) return null
  return pickCounterpart(track, want, verified(results.tracks), exclude)
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
