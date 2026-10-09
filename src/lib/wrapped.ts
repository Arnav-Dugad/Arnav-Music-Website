/** "Wrapped", monthly: your month in music, computed on this device from your listening history. */
import type { PlayEvent, Track, TrackId } from './types'
import { MOODS, type Mood } from './types'
import { hourLabel } from './taste'

export interface WrappedSong { track: Track; plays: number; minutes: number }
export interface WrappedArtist { name: string; plays: number; minutes: number; art: string | null }
export interface Wrapped {
  /** A month ("2026-10") or a whole year ("2026"). */
  kind: 'month' | 'year'
  key: string
  label: string
  start: number
  end: number
  minutes: number
  plays: number
  songs: WrappedSong[]
  artists: WrappedArtist[]
  album: { name: string; artist: string; minutes: number; art: string | null } | null
  /** Albums / films by minutes (top `top`). */
  albums: { name: string; artist: string; minutes: number; art: string | null }[]
  newArtists: string[]
  peakHour: number | null
  peakHourLabel: string
  busiestDay: { date: number; minutes: number } | null
  streak: number
  mood: Mood
  /** Minutes compared with the month before (null when there's no earlier month). */
  change: number | null
  firstSong: Track | null
  /** Year only: each month's minutes and top artist. */
  months: { key: string; label: string; minutes: number; topArtist: string | null }[]
  /** The period before (last month / last year), for comparisons. */
  prev: { minutes: number; topArtist: string | null; topSong: string | null; artists: number } | null
  artistsCount: number
}

export const monthKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
export function monthRange(key: string): { start: number; end: number; label: string } {
  const [y, m] = key.split('-').map(Number)
  const start = new Date(y, m - 1, 1).getTime()
  const end = new Date(y, m, 1).getTime()
  return { start, end, label: new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }
}

/** A month key or a year key → its range. */
export function rangeOf(key: string): { start: number; end: number; label: string; kind: 'month' | 'year' } {
  if (/^\d{4}$/.test(key)) { const y = Number(key); return { start: new Date(y, 0, 1).getTime(), end: new Date(y + 1, 0, 1).getTime(), label: key, kind: 'year' } }
  return { ...monthRange(key), kind: 'month' }
}

/** Years with at least two wrapped months, newest first. */
export function wrappedYears(events: PlayEvent[]): string[] {
  const counts = new Map<string, number>()
  for (const m of wrappedMonths(events)) counts.set(m.slice(0, 4), (counts.get(m.slice(0, 4)) ?? 0) + 1)
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([y]) => y).sort().reverse()
}

/** Months you listened in, newest first (only months with at least 30 minutes). */
export function wrappedMonths(events: PlayEvent[]): string[] {
  const m = new Map<string, number>()
  for (const e of events) m.set(monthKey(e.startedAt), (m.get(monthKey(e.startedAt)) ?? 0) + e.listenedMs)
  return [...m.entries()].filter(([, ms]) => ms >= 30 * 60_000).map(([k]) => k).sort().reverse()
}

function moodOf(energy: number): Mood {
  let best: Mood = 'CHILL'
  let d = Infinity
  for (const [k, v] of Object.entries(MOODS) as [Mood, (typeof MOODS)[Mood]][]) {
    if (k === 'AGGRESSIVE' || k === 'CINEMATIC' || k === 'NOSTALGIC') continue
    const x = Math.abs(v.energy - energy)
    if (x < d) { d = x; best = k }
  }
  return best
}

/** `top`: how many songs, artists and albums to rank (the story shows 5; Replay shows more). */
export function buildWrapped(key: string, events: PlayEvent[], track: (id: TrackId) => Track | undefined, top = 5): Wrapped | null {
  const { start, end, label, kind } = rangeOf(key)
  const inMonth = events.filter((e) => e.startedAt >= start && e.startedAt < end && e.listenedMs >= 15_000)
  if (!inMonth.length) return null
  const ms = inMonth.reduce((a, e) => a + e.listenedMs, 0)
  // Songs
  const bySong = new Map<string, { plays: number; ms: number }>()
  for (const e of inMonth) { const s = bySong.get(e.trackId) ?? { plays: 0, ms: 0 }; s.plays++; s.ms += e.listenedMs; bySong.set(e.trackId, s) }
  const songs = [...bySong.entries()].map(([id, s]) => ({ t: track(id), ...s })).filter((x): x is { t: Track; plays: number; ms: number } => !!x.t)
    .sort((a, b) => b.plays - a.plays || b.ms - a.ms).slice(0, top).map((x) => ({ track: x.t, plays: x.plays, minutes: Math.round(x.ms / 60_000) }))
  // Artists
  const byArtist = new Map<string, { name: string; plays: number; ms: number; art: string | null }>()
  for (const e of inMonth) {
    const t = track(e.trackId)
    const name = t?.artist.split(/,|&/)[0].trim() || e.artistKey
    const k = name.toLowerCase()
    const a = byArtist.get(k) ?? { name, plays: 0, ms: 0, art: t?.artworkUrl ?? null }
    a.plays++; a.ms += e.listenedMs
    byArtist.set(k, a)
  }
  const artists = [...byArtist.values()].sort((a, b) => b.ms - a.ms).slice(0, top).map((a) => ({ name: a.name, plays: a.plays, minutes: Math.round(a.ms / 60_000), art: a.art }))
  // Album / film
  const byAlbum = new Map<string, { name: string; artist: string; ms: number; art: string | null }>()
  for (const e of inMonth) {
    const t = track(e.trackId)
    if (!t?.album) continue
    const a = byAlbum.get(t.album.toLowerCase()) ?? { name: t.album, artist: t.artist, ms: 0, art: t.artworkUrl ?? null }
    a.ms += e.listenedMs
    byAlbum.set(t.album.toLowerCase(), a)
  }
  const rankedAlbums = [...byAlbum.values()].sort((a, b) => b.ms - a.ms)
  const topAlbum = rankedAlbums[0]
  // New artists: first ever played this month.
  const before = new Set(events.filter((e) => e.startedAt < start).map((e) => e.artistKey))
  const newKeys = [...new Set(inMonth.map((e) => e.artistKey))].filter((k) => !before.has(k))
  const newArtists = newKeys.map((k) => { const e = inMonth.find((x) => x.artistKey === k); const t = e ? track(e.trackId) : undefined; return t?.artist.split(/,|&/)[0].trim() ?? k }).slice(0, 12)
  // Rhythm
  const hours = new Array(24).fill(0)
  const days = new Map<number, number>()
  for (const e of inMonth) {
    const d = new Date(e.startedAt)
    hours[d.getHours()] += e.listenedMs
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    days.set(day, (days.get(day) ?? 0) + e.listenedMs)
  }
  const peak = hours.indexOf(Math.max(...hours))
  const busiest = [...days.entries()].sort((a, b) => b[1] - a[1])[0]
  let streak = 0
  let run = 0
  for (let d = start; d < end; d += 86_400_000) {
    const day = new Date(d); const k = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
    if (days.has(k)) { run++; streak = Math.max(streak, run) } else run = 0
  }
  // Mood from the energy of what you played (weighted by time).
  let eSum = 0
  let wSum = 0
  for (const e of inMonth) { const t = track(e.trackId); if (t?.energy != null) { eSum += t.energy * e.listenedMs; wSum += e.listenedMs } }
  const prev = kind === 'year' ? rangeOf(String(Number(key) - 1)) : monthRange(monthKey(start - 86_400_000))
  const prevEvents = events.filter((e) => e.startedAt >= prev.start && e.startedAt < prev.end && e.listenedMs >= 15_000)
  const prevMs = prevEvents.reduce((a, e) => a + e.listenedMs, 0)
  const topOf = (list: PlayEvent[], by: (e: PlayEvent) => string | null) => {
    const m = new Map<string, number>()
    for (const e of list) { const k = by(e); if (k) m.set(k, (m.get(k) ?? 0) + e.listenedMs) }
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }
  const artistName = (e: PlayEvent) => track(e.trackId)?.artist.split(/,|&/)[0].trim() || null
  const months = kind === 'year' ? Array.from({ length: 12 }, (_, i) => {
    const mk = `${key}-${String(i + 1).padStart(2, '0')}`
    const r = monthRange(mk)
    const evs = inMonth.filter((e) => e.startedAt >= r.start && e.startedAt < r.end)
    return { key: mk, label: new Date(Number(key), i, 1).toLocaleDateString(undefined, { month: 'short' }), minutes: Math.round(evs.reduce((a, e) => a + e.listenedMs, 0) / 60_000), topArtist: topOf(evs, artistName) }
  }) : []
  const first = [...inMonth].sort((a, b) => a.startedAt - b.startedAt)[0]
  return {
    key, label, start, end,
    minutes: Math.round(ms / 60_000),
    plays: inMonth.length,
    songs, artists,
    album: topAlbum ? { name: topAlbum.name, artist: topAlbum.artist, minutes: Math.round(topAlbum.ms / 60_000), art: topAlbum.art } : null,
    albums: rankedAlbums.slice(0, top).map((a) => ({ name: a.name, artist: a.artist, minutes: Math.round(a.ms / 60_000), art: a.art })),
    newArtists,
    peakHour: hours[peak] > 0 ? peak : null,
    peakHourLabel: hours[peak] > 0 ? hourLabel(peak) : '',
    busiestDay: busiest ? { date: busiest[0], minutes: Math.round(busiest[1] / 60_000) } : null,
    streak,
    mood: moodOf(wSum ? eSum / wSum : 0.5),
    change: prevMs > 0 ? Math.round(((ms - prevMs) / prevMs) * 100) : null,
    firstSong: first ? track(first.trackId) ?? null : null,
    kind,
    months,
    prev: prevMs > 0 ? { minutes: Math.round(prevMs / 60_000), topArtist: topOf(prevEvents, artistName), topSong: (() => { const id = topOf(prevEvents, (e) => e.trackId); return id ? track(id)?.title ?? null : null })(), artists: new Set(prevEvents.map((e) => e.artistKey)).size } : null,
    artistsCount: byArtist.size,
  }
}

/** A short, honest line about when you listen. */
export function clockLine(h: number | null): string {
  if (h == null) return ''
  if (h >= 22 || h < 4) return 'A night owl — your music comes alive after dark.'
  if (h < 9) return 'An early riser — you start the day with music.'
  if (h < 13) return 'Morning momentum — music gets your day going.'
  if (h < 18) return 'An afternoon listener — music carries you through the day.'
  return 'Evenings are yours — that’s when you press play.'
}
