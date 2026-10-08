import { cachedSearch, search, ytQuotaState } from '../lib/youtube'
import { isSingle, titleSimilarity } from '../lib/classify'
import { buildProfile, diversify, rank, type Reason, type TasteProfile } from '../lib/taste'
import { artistKey, type MediaVariant, type PlayEvent, type Track, type TrackId } from '../lib/types'
import { allows, lib, likedIds, liveEvents } from '../state/library'
import { trackRegistry } from '../state/tracks'

let profileCache: { at: number; rev: number; profile: TasteProfile } | null = null

/** The listener's taste profile, recomputed at most once a minute or when the library changes. */
export function profile(): TasteProfile {
  const s = lib()
  if (profileCache && profileCache.rev === s.revision && Date.now() - profileCache.at < 60_000) return profileCache.profile
  const p = buildProfile(liveEvents(s.events), (id) => trackRegistry.get(id), likedIds(s.likes))
  profileCache = { at: Date.now(), rev: s.revision, profile: p }
  return p
}

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
    if (c) { out.push(...c.tracks); continue }
    if (remote >= remoteBudget || ytQuotaState() === 'EXHAUSTED') continue
    remote++
    try { out.push(...(await search(q, 'SONGS')).tracks) } catch { /* keep what we have */ }
  }
  return out
}

export interface Rec { track: Track; reason: Reason; caption: string }

function caption(t: Track, reason: Reason, seed?: Track): string {
  const f = seed ? followers(seed.id) : []
  if (seed && f.includes(t.id)) return `Often follows ${seed.title} in your sessions`
  if (seed && artistKey(seed.artist) === artistKey(t.artist)) return `More from ${t.artist}`
  switch (reason) {
    case 'ARTIST_RETURNING': return `You keep coming back to ${t.artist}`
    case 'FORGOTTEN_FAVORITE': return 'A favourite, quiet lately'
    case 'NEW_DISCOVERY': return 'New to you'
    case 'GENRE_MATCH': return t.genres[0] ? `Close to the ${t.genres[0]} you play` : 'Close to your genres'
    case 'HEAVY_ROTATION': return 'In heavy rotation'
    case 'SIMILAR_ENERGY': return 'Same energy'
    case 'LIKED': return 'You liked this'
    default: return 'Fits right now'
  }
}

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
  const localPool = trackRegistry.all().filter((t) =>
    artistKey(t.artist) === key || co.some((a) => a.key === artistKey(t.artist)) || t.genres.some((g) => seed.genres.includes(g)))
  const followIds = new Set(followers(seed.id))
  const exclude = new Set([seed.id, ...(opts.exclude ?? [])])
  const recent = liveEvents().filter((e) => Date.now() - e.startedAt < 2 * 3600_000).map((e) => e.trackId)
  recent.forEach((id) => exclude.add(id))
  const candidates = [...trackRegistry.many([...followIds]), ...remote, ...localPool]
    .filter((t) => isSingle(t) && allows(t) && titleSimilarity(t.title, seed.title) < 0.8)
  const ranked = rank(candidates, p, { liked: likedIds(), targetEnergy: seed.energy ?? p.energyPreference, discovery: 0.45, exclude })
    .map((s) => ({ ...s, score: s.score + (followIds.has(s.track.id) ? 0.6 : 0) }))
    .sort((a, b) => b.score - a.score)
  return diversify(ranked, 2).slice(0, opts.limit ?? 25).map((s) => ({ track: s.track, reason: s.reason, caption: caption(s.track, s.reason, seed) }))
}

/** Home "For you right now": time-of-day aware ranking over everything known. */
export function forYouNow(limit = 16): Rec[] {
  const p = profile()
  if (p.isCold) return []
  const hour = new Date().getHours()
  const hourWeight = (p.hourHistogram[hour] ?? 0) / Math.max(1, Math.max(...p.hourHistogram))
  const pool = trackRegistry.all().filter((t) => isSingle(t) && allows(t))
  const ranked = rank(pool, p, { liked: likedIds(), discovery: 0.25 + 0.2 * (1 - hourWeight) })
  return diversify(ranked, 2).slice(0, limit).map((s) => ({ track: s.track, reason: s.reason, caption: caption(s.track, s.reason) }))
}

/** Fresh finds: close to taste, never played. */
export function freshFinds(limit = 16): Rec[] {
  const p = profile()
  if (p.isCold) return []
  const played = new Set(liveEvents().map((e) => e.trackId))
  const pool = trackRegistry.all().filter((t) => !played.has(t.id) && isSingle(t) && allows(t))
  const ranked = rank(pool, p, { liked: likedIds(), discovery: 0.8 }).filter((s) => (p.artistAffinity.get(artistKey(s.track.artist)) ?? 0) > 0.05 || s.track.genres.some((g) => (p.genreAffinity.get(g) ?? 0) > 0.2))
  return diversify(ranked, 2).slice(0, limit).map((s) => ({ track: s.track, reason: 'NEW_DISCOVERY' as Reason, caption: (p.artistAffinity.get(artistKey(s.track.artist)) ?? 0) > 0.05 ? `New from ${s.track.artist}` : 'New to you, close to your taste' }))
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
    const tracks = trackRegistry.all().filter((t) => cluster.includes(artistKey(t.artist)) && isSingle(t) && allows(t))
    if (tracks.length < 5) continue
    const ranked = diversify(rank(tracks, p, { liked: likedIds(), discovery: 0.3 }), 4).slice(0, 30).map((s) => s.track)
    const names = [...new Set(ranked.map((t) => t.artist))].slice(0, 3)
    mixes.push({ id: `daily_${seed}`, title: `Daily Mix ${mixes.length + 1}`, artists: names, tracks: ranked, hue: (mixes.length * 77 + 250) % 360 })
  }
  return mixes
}

/** Finds another upload of the same song — the "Topic" audio for Song mode, a video for Video mode. */
export async function alternativeUpload(track: Track, want: MediaVariant | null, exclude: Set<string> = new Set()): Promise<Track | null> {
  const query = `${track.artist} ${track.title}`.slice(0, 100)
  const results = (await cachedSearch(query, 'SONGS')) ?? (await search(query, 'SONGS').catch(() => null))
  if (!results) return null
  const candidates = results.tracks.filter((c) => c.id !== track.id && !exclude.has(c.playbackRef) && isSingle(c) && titleSimilarity(c.title, track.title) >= 0.6)
  const sorted = candidates.sort((a, b) => {
    const v = (x: Track) => (want && x.variant === want ? 0 : x.variant == null ? 1 : 2)
    const ar = (x: Track) => (artistKey(x.artist) === artistKey(track.artist) ? 0 : 1)
    return v(a) - v(b) || ar(a) - ar(b)
  })
  return sorted.find((c) => want == null || c.variant === want || c.variant == null) ?? null
}
