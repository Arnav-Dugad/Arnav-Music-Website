import type { PlayEvent, Track, TrackId } from './types'
import { artistKey } from './types'
import { isSingle } from './classify'

/** The listener's taste vector, computed entirely on device (port of TasteProfileBuilder). */
export interface TasteProfile {
  artistAffinity: Map<string, number>
  genreAffinity: Map<string, number>
  trackFamiliarity: Map<TrackId, number>
  trackPlayCounts: Map<TrackId, number>
  lastPlayedAt: Map<TrackId, number>
  artistLastPlayedAt: Map<string, number>
  energyPreference: number | null
  hourHistogram: number[]
  dayHistogram: number[] // Monday first
  skipRate: number
  repeatTendency: number
  discoveryRatio: number
  totalListenMs: number
  eventCount: number
  isCold: boolean
}

const DAY = 86_400_000
const HALF_LIFE_DAYS = 30

export const completionRatio = (e: PlayEvent) =>
  e.durationMs && e.durationMs > 0 ? Math.min(1, Math.max(0, e.listenedMs / e.durationMs)) : e.completed ? 1 : 0.5

function normalised<K>(m: Map<K, number>): Map<K, number> {
  let top = 0
  m.forEach((v) => { if (v > top) top = v })
  const out = new Map<K, number>()
  if (top <= 0) return out
  m.forEach((v, k) => { if (v > 0) out.set(k, v / top) })
  return out
}

export function buildProfile(events: PlayEvent[], tracks: (id: TrackId) => Track | undefined, liked: Set<TrackId>, now = Date.now()): TasteProfile {
  const lambda = Math.log(2) / HALF_LIFE_DAYS
  const artist = new Map<string, number>()
  const genre = new Map<string, number>()
  const trackWeight = new Map<TrackId, number>()
  const counts = new Map<TrackId, number>()
  const lastPlayed = new Map<TrackId, number>()
  const artistLast = new Map<string, number>()
  const hours = Array(24).fill(0)
  const days = Array(7).fill(0)
  let energySum = 0
  let energyWeight = 0
  let skips = 0
  let totalMs = 0
  const add = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v)

  for (const e of events) {
    const ageDays = Math.max(0, (now - e.startedAt) / DAY)
    const decay = Math.exp(-lambda * ageDays)
    const cr = completionRatio(e)
    const engagement = e.skipped && cr < 0.3 ? -0.35 : 0.25 + 0.75 * cr
    const w = decay * engagement
    add(artist, e.artistKey, w)
    add(trackWeight, e.trackId, w)
    if (!e.skipped || cr > 0.5) add(counts, e.trackId, 1)
    lastPlayed.set(e.trackId, Math.max(lastPlayed.get(e.trackId) ?? 0, e.startedAt))
    artistLast.set(e.artistKey, Math.max(artistLast.get(e.artistKey) ?? 0, e.startedAt))
    const t = tracks(e.trackId)
    if (t) {
      t.genres?.forEach((g) => add(genre, g.toLowerCase(), w))
      if (t.energy != null && w > 0) { energySum += t.energy * w; energyWeight += w }
    }
    if (e.skipped) skips++
    totalMs += e.listenedMs
    const d = new Date(e.startedAt)
    hours[d.getHours()] += e.listenedMs / 60_000
    days[(d.getDay() + 6) % 7] += e.listenedMs / 60_000
  }
  for (const id of liked) {
    const t = tracks(id)
    if (!t) continue
    add(artist, artistKey(t.artist), 1.5)
    add(trackWeight, id, 1.5)
    t.genres?.forEach((g) => add(genre, g.toLowerCase(), 0.8))
  }
  const distinct = Math.max(1, counts.size)
  let repeats = 0
  let first = 0
  counts.forEach((c) => { if (c >= 3) repeats++; if (c === 1) first++ })
  const fam = new Map<TrackId, number>()
  trackWeight.forEach((v, k) => fam.set(k, 1 - Math.exp(-Math.max(0, v) / 2)))
  return {
    artistAffinity: normalised(artist),
    genreAffinity: normalised(genre),
    trackFamiliarity: fam,
    trackPlayCounts: counts,
    lastPlayedAt: lastPlayed,
    artistLastPlayedAt: artistLast,
    energyPreference: energyWeight > 0 ? energySum / energyWeight : null,
    hourHistogram: hours,
    dayHistogram: days,
    skipRate: events.length ? skips / events.length : 0,
    repeatTendency: Math.min(1, repeats / distinct),
    discoveryRatio: Math.min(1, first / distinct),
    totalListenMs: totalMs,
    eventCount: events.length,
    isCold: events.length < 5,
  }
}

export type Reason = 'ARTIST_RETURNING' | 'SIMILAR_ENERGY' | 'GENRE_MATCH' | 'FORGOTTEN_FAVORITE' | 'NEW_DISCOVERY' | 'HEAVY_ROTATION' | 'LIKED' | 'TIME_OF_DAY'
export const REASON_COPY: Record<Reason, string> = {
  ARTIST_RETURNING: 'An artist you keep coming back to',
  SIMILAR_ENERGY: 'Matches the energy you asked for',
  GENRE_MATCH: 'Close to the genres you play most',
  FORGOTTEN_FAVORITE: 'A favourite you haven’t played in a while',
  NEW_DISCOVERY: 'New to you',
  HEAVY_ROTATION: 'In your heavy rotation',
  LIKED: 'You liked this',
  TIME_OF_DAY: 'Fits this time of day',
}

export interface Scored { track: Track; score: number; reason: Reason; parts?: Record<'artist' | 'genre' | 'energy' | 'familiarity' | 'novelty', number> }

const W = { artist: 1.0, genre: 0.6, energy: 0.5, familiarity: 0.4, novelty: 0.35, recencyPenalty: 0.8, liked: 0.5 }

/** Deterministic hybrid ranker. Gemini never decides what plays; it only shapes the constraints. */
export function rank(candidates: Track[], p: TasteProfile, opts: { now?: number; liked?: Set<TrackId>; targetEnergy?: number | null; discovery?: number; exclude?: Set<TrackId>; tune?: Partial<Record<'artist' | 'genre' | 'energy' | 'familiarity' | 'novelty', number>> } = {}): Scored[] {
  const M = { artist: 1, genre: 1, energy: 1, familiarity: 1, novelty: 1, ...opts.tune }
  const now = opts.now ?? Date.now()
  const liked = opts.liked ?? new Set()
  const d = Math.min(1, Math.max(0, opts.discovery ?? 0.3))
  const target = opts.targetEnergy ?? p.energyPreference
  const seen = new Set<TrackId>()
  const out: Scored[] = []
  for (const t of candidates) {
    if (opts.exclude?.has(t.id) || seen.has(t.id)) continue
    seen.add(t.id)
    const ak = artistKey(t.artist)
    const artistAff = p.artistAffinity.get(ak) ?? 0
    const genreAff = Math.max(0, ...(t.genres ?? []).map((g) => p.genreAffinity.get(g.toLowerCase()) ?? 0))
    const familiarity = p.trackFamiliarity.get(t.id) ?? 0
    const energyFit = target != null && t.energy != null ? 1 - Math.abs(target - t.energy) : 0.5
    const last = p.lastPlayedAt.get(t.id)
    const hoursSince = last ? (now - last) / 3_600_000 : Infinity
    const recency = last ? Math.exp(-hoursSince / 8) : 0
    const isLiked = liked.has(t.id)
    const parts = { artist: W.artist * artistAff, genre: W.genre * genreAff, energy: W.energy * energyFit, familiarity: W.familiarity * familiarity * (1 - d), novelty: W.novelty * (1 - familiarity) * d }
    const score = M.artist * parts.artist + M.genre * parts.genre + M.energy * parts.energy + M.familiarity * parts.familiarity +
      M.novelty * parts.novelty + (isLiked ? W.liked : 0) - W.recencyPenalty * recency
    let reason: Reason = 'TIME_OF_DAY'
    if (isLiked && hoursSince > 24 * 21) reason = 'FORGOTTEN_FAVORITE'
    else if (familiarity < 0.05 && artistAff < 0.1) reason = 'NEW_DISCOVERY'
    else if (artistAff > 0.6) reason = 'ARTIST_RETURNING'
    else if (target != null && t.energy != null && energyFit > 0.85) reason = 'SIMILAR_ENERGY'
    else if (genreAff > 0.4) reason = 'GENRE_MATCH'
    else if (familiarity > 0.7) reason = 'HEAVY_ROTATION'
    else if (isLiked) reason = 'LIKED'
    out.push({ track: t, score, reason, parts })
  }
  return out.sort((a, b) => b.score - a.score || a.track.id.localeCompare(b.track.id))
}

/** Keeps artists varied: at most [maxPerArtist], never two in a row. */
export function diversify(list: Scored[], maxPerArtist = 2): Scored[] {
  const per = new Map<string, number>()
  const out: Scored[] = []
  const rest = [...list]
  while (rest.length) {
    const lastArtist = out.length ? artistKey(out[out.length - 1].track.artist) : null
    const idx = rest.findIndex((s) => {
      const k = artistKey(s.track.artist)
      return k !== lastArtist && (per.get(k) ?? 0) < maxPerArtist
    })
    if (idx < 0) break
    const [pick] = rest.splice(idx, 1)
    const k = artistKey(pick.track.artist)
    per.set(k, (per.get(k) ?? 0) + 1)
    out.push(pick)
  }
  return out
}

// ── Smart playlists ───────────────────────────────────────────────────────────
export type SmartKind = 'TOP_THIS_MONTH' | 'HEAVY_ROTATION' | 'FORGOTTEN_FAVORITES' | 'RECENTLY_DISCOVERED' | 'MOST_REPLAYED' | 'NIGHT_OWL' | 'SUNDAY_MORNING' | 'NEVER_FINISHED' | 'FRESH_FINDS' | 'REDISCOVER'
export const SMART: Record<SmartKind, { title: string; blurb: string; hue: number }> = {
  TOP_THIS_MONTH: { title: 'Top songs this month', blurb: 'Most listened since the 1st, refreshed as you play', hue: 262 },
  HEAVY_ROTATION: { title: 'Heavy Rotation', blurb: 'What you keep coming back to this month', hue: 340 },
  FORGOTTEN_FAVORITES: { title: 'Forgotten Favorites', blurb: 'Loved once, quiet lately', hue: 28 },
  RECENTLY_DISCOVERED: { title: 'Recently Discovered', blurb: 'First heard in the last two weeks', hue: 168 },
  MOST_REPLAYED: { title: 'Most Replayed', blurb: 'Your all-time repeats', hue: 8 },
  NIGHT_OWL: { title: 'Night Owl', blurb: 'What plays after midnight', hue: 238 },
  SUNDAY_MORNING: { title: 'Sunday Morning', blurb: 'Slow-start weekend picks', hue: 45 },
  NEVER_FINISHED: { title: 'Never Finished', blurb: 'Started, never quite completed', hue: 200 },
  FRESH_FINDS: { title: 'Fresh Finds', blurb: 'New to you, already sticking', hue: 140 },
  REDISCOVER: { title: 'Rediscover', blurb: 'Not played in over a month', hue: 300 },
}
export const SMART_KINDS = Object.keys(SMART) as SmartKind[]

export function smartPlaylist(kind: SmartKind, events: PlayEvent[], liked: Set<TrackId>, now = Date.now(), limit = 50): TrackId[] {
  if (!events.length && !liked.size) return []
  const byTrack = new Map<TrackId, PlayEvent[]>()
  for (const e of events) {
    const l = byTrack.get(e.trackId)
    if (l) l.push(e)
    else byTrack.set(e.trackId, [e])
  }
  const firstPlayed = new Map<TrackId, number>()
  const lastPlayed = new Map<TrackId, number>()
  const goodPlays = new Map<TrackId, number>()
  byTrack.forEach((v, k) => {
    firstPlayed.set(k, Math.min(...v.map((e) => e.startedAt)))
    lastPlayed.set(k, Math.max(...v.map((e) => e.startedAt)))
    goodPlays.set(k, v.filter((e) => !e.skipped || completionRatio(e) > 0.6).length)
  })
  const countBy = (list: PlayEvent[]) => {
    const m = new Map<TrackId, number>()
    list.forEach((e) => m.set(e.trackId, (m.get(e.trackId) ?? 0) + 1))
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  const hour = (e: PlayEvent) => new Date(e.startedAt).getHours()
  let ids: TrackId[] = []
  switch (kind) {
    case 'TOP_THIS_MONTH': {
      const d = new Date(now)
      const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
      const ms = new Map<TrackId, number>()
      events.filter((e) => e.startedAt >= start).forEach((e) => ms.set(e.trackId, (ms.get(e.trackId) ?? 0) + e.listenedMs))
      ids = [...ms.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
      break
    }
    case 'HEAVY_ROTATION':
      ids = countBy(events.filter((e) => now - e.startedAt < 30 * DAY && !e.skipped)).filter(([, c]) => c >= 2).map(([k]) => k)
      break
    case 'FORGOTTEN_FAVORITES':
      ids = [...new Set([...liked, ...[...goodPlays.entries()].filter(([, c]) => c >= 4).map(([k]) => k)])]
        .filter((id) => { const l = lastPlayed.get(id) ?? 0; return l === 0 || now - l > 45 * DAY })
        .sort((a, b) => (goodPlays.get(b) ?? 0) - (goodPlays.get(a) ?? 0))
      break
    case 'RECENTLY_DISCOVERED':
      ids = [...firstPlayed.entries()].filter(([, t]) => now - t < 14 * DAY).sort((a, b) => b[1] - a[1]).map(([k]) => k)
      break
    case 'MOST_REPLAYED':
      ids = [...goodPlays.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).map(([k]) => k)
      break
    case 'NIGHT_OWL':
      ids = countBy(events.filter((e) => hour(e) <= 4 && !e.skipped)).map(([k]) => k)
      break
    case 'SUNDAY_MORNING':
      ids = countBy(events.filter((e) => new Date(e.startedAt).getDay() === 0 && hour(e) >= 6 && hour(e) <= 12 && !e.skipped)).map(([k]) => k)
      break
    case 'NEVER_FINISHED':
      ids = [...byTrack.entries()].filter(([, v]) => v.length >= 2 && v.every((e) => !e.completed)).sort((a, b) => b[1].length - a[1].length).map(([k]) => k)
      break
    case 'FRESH_FINDS':
      ids = [...firstPlayed.entries()].filter(([id, f]) => now - f < 30 * DAY && (goodPlays.get(id) ?? 0) >= 2).sort((a, b) => (goodPlays.get(b[0]) ?? 0) - (goodPlays.get(a[0]) ?? 0)).map(([k]) => k)
      break
    case 'REDISCOVER':
      ids = [...lastPlayed.entries()].filter(([id, l]) => now - l > 30 * DAY && (goodPlays.get(id) ?? 0) >= 2).sort((a, b) => (goodPlays.get(b[0]) ?? 0) - (goodPlays.get(a[0]) ?? 0)).map(([k]) => k)
      break
  }
  return ids.slice(0, limit)
}

// ── Insights / Taste DNA ─────────────────────────────────────────────────────
export interface ArtistStat { key: string; name: string; plays: number; ms: number; artwork?: string | null; lastAt: number }

export function topArtists(events: PlayEvent[], tracks: (id: TrackId) => Track | undefined, since = 0): ArtistStat[] {
  const m = new Map<string, ArtistStat>()
  for (const e of events) {
    if (e.startedAt < since) continue
    const t = tracks(e.trackId)
    const name = t?.artist ?? e.artistKey
    const s = m.get(e.artistKey) ?? { key: e.artistKey, name, plays: 0, ms: 0, artwork: t?.artworkUrl, lastAt: 0 }
    s.plays += 1
    s.ms += e.listenedMs
    s.lastAt = Math.max(s.lastAt, e.startedAt)
    if (!s.artwork && t?.artworkUrl) s.artwork = t.artworkUrl
    m.set(e.artistKey, s)
  }
  return [...m.values()].sort((a, b) => b.ms - a.ms)
}

export interface TrackStat { id: TrackId; plays: number; ms: number; firstAt: number; lastAt: number }
export function topTracks(events: PlayEvent[], since = 0): TrackStat[] {
  const m = new Map<TrackId, TrackStat>()
  for (const e of events) {
    if (e.startedAt < since) continue
    const s = m.get(e.trackId) ?? { id: e.trackId, plays: 0, ms: 0, firstAt: e.startedAt, lastAt: e.startedAt }
    s.plays += 1
    s.ms += e.listenedMs
    s.firstAt = Math.min(s.firstAt, e.startedAt)
    s.lastAt = Math.max(s.lastAt, e.startedAt)
    m.set(e.trackId, s)
  }
  return [...m.values()].sort((a, b) => b.ms - a.ms)
}

const dayStart = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }

/** Minutes per local day for the last [days] days (oldest first). */
export function dailyMinutes(events: PlayEvent[], days = 371, now = Date.now()): { day: number; minutes: number }[] {
  const end = dayStart(now)
  const m = new Map<number, number>()
  for (const e of events) {
    const d = dayStart(e.startedAt)
    m.set(d, (m.get(d) ?? 0) + e.listenedMs / 60_000)
  }
  const out: { day: number; minutes: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end)
    d.setDate(d.getDate() - i)
    const k = d.getTime()
    out.push({ day: k, minutes: m.get(k) ?? 0 })
  }
  return out
}

export function streaks(events: PlayEvent[], now = Date.now()): { current: number; longest: number } {
  const days = new Set(events.filter((e) => e.listenedMs >= 60_000 || e.completed).map((e) => dayStart(e.startedAt)))
  if (!days.size) return { current: 0, longest: 0 }
  const sorted = [...days].sort((a, b) => a - b)
  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    const gap = Math.round((sorted[i] - sorted[i - 1]) / DAY)
    run = gap === 1 ? run + 1 : 1
    longest = Math.max(longest, run)
  }
  let current = 0
  const cursor = new Date(dayStart(now))
  if (!days.has(cursor.getTime())) cursor.setDate(cursor.getDate() - 1)
  while (days.has(cursor.getTime())) { current++; cursor.setDate(cursor.getDate() - 1) }
  return { current, longest }
}

export interface Milestone { id: string; title: string; reached: boolean; progress: number; detail: string }
export function milestones(events: PlayEvent[], likes: number): Milestone[] {
  const minutes = events.reduce((a, e) => a + e.listenedMs, 0) / 60_000
  const artists = new Set(events.map((e) => e.artistKey)).size
  const songs = new Set(events.map((e) => e.trackId)).size
  const m = (id: string, title: string, value: number, goal: number, unit: string): Milestone => ({
    id, title, reached: value >= goal, progress: Math.min(1, value / goal), detail: `${Math.floor(Math.min(value, goal)).toLocaleString()} / ${goal.toLocaleString()} ${unit}`,
  })
  return [
    m('min100', 'First 100 minutes', minutes, 100, 'min'),
    m('min1000', '1,000 minutes', minutes, 1000, 'min'),
    m('min10000', '10,000 minutes', minutes, 10000, 'min'),
    m('artists25', '25 artists', artists, 25, 'artists'),
    m('artists100', '100 artists', artists, 100, 'artists'),
    m('songs500', '500 different songs', songs, 500, 'songs'),
    m('likes50', '50 liked songs', likes, 50, 'likes'),
  ]
}

/** Weekly discovery score: share of this week's listening that was new to you. */
export function discoveryScore(events: PlayEvent[], now = Date.now()): number | null {
  const weekAgo = now - 7 * DAY
  const before = new Set(events.filter((e) => e.startedAt < weekAgo).map((e) => e.trackId))
  const week = events.filter((e) => e.startedAt >= weekAgo)
  const total = week.reduce((a, e) => a + e.listenedMs, 0)
  if (total < 10 * 60_000) return null
  const fresh = week.filter((e) => !before.has(e.trackId)).reduce((a, e) => a + e.listenedMs, 0)
  return fresh / total
}

export interface TimeMachine { kind: string; title: string; subtitle: string; trackIds: TrackId[] }

/** "You loved these three months ago" — only claims the data supports. */
export function timeMachine(events: PlayEvent[], now = Date.now()): TimeMachine[] {
  const out: TimeMachine[] = []
  const windowTop = (from: number, to: number) => topTracks(events.filter((e) => e.startedAt >= from && e.startedAt < to)).filter((t) => t.plays >= 2).map((t) => t.id)
  const recent = new Set(events.filter((e) => now - e.startedAt < 21 * DAY).map((e) => e.trackId))
  const threeMonths = windowTop(now - 100 * DAY, now - 80 * DAY).filter((id) => !recent.has(id)).slice(0, 12)
  if (threeMonths.length >= 3) out.push({ kind: '3mo', title: 'You loved these three months ago', subtitle: 'Back in rotation?', trackIds: threeMonths })
  const lastYear = windowTop(now - 372 * DAY, now - 358 * DAY).filter((id) => !recent.has(id)).slice(0, 12)
  if (lastYear.length >= 3) out.push({ kind: '1yr', title: 'This week, one year ago', subtitle: 'Take me back', trackIds: lastYear })
  return out
}

export function hourLabel(h: number) {
  return h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`
}

/** Plain-language listening personality from the clock and gauges. */
export function personality(p: TasteProfile): { title: string; line: string } {
  if (p.isCold) return { title: 'Just getting started', line: 'Play a few songs and your Taste DNA will take shape.' }
  const peak = p.hourHistogram.indexOf(Math.max(...p.hourHistogram))
  const time = peak >= 22 || peak <= 4 ? 'night owl' : peak <= 10 ? 'early riser' : peak <= 16 ? 'daytime listener' : 'evening listener'
  const style = p.discoveryRatio > 0.55 ? 'explorer' : p.repeatTendency > 0.35 ? 'loyalist' : 'balanced listener'
  return {
    title: `${time[0].toUpperCase()}${time.slice(1)} · ${style}`,
    line: `You listen most around ${hourLabel(peak)}. ${Math.round(p.discoveryRatio * 100)}% of your songs were heard only once; ${Math.round(p.repeatTendency * 100)}% are on repeat.`,
  }
}

export const singlesOnly = (tracks: Track[]) => tracks.filter(isSingle)
