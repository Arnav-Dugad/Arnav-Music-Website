/**
 * Replay, computed and saved: a period's minutes, top artists / songs / albums, where you listened
 * (phone, tablet, desktop) and your streaks. Each period is snapshotted and synced (w_replay) so
 * past months still show after older history is trimmed from a device.
 */
import type { PlayEvent, Track } from './types'
import { buildWrapped, rangeOf, wrappedMonths, wrappedYears, type Wrapped } from './wrapped'
import type { DeviceInfo, FormFactor, ReplaySnapshot, SnapTrack } from '../state/prefs'

/** Events Replay counts (the same rule as Wrapped: at least 15 seconds). */
const counts = (e: PlayEvent) => e.listenedMs >= 15_000

/** What kind of device this browser is. */
export function formFactor(): FormFactor {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const short = Math.min(screen.width, screen.height)
  if (coarse && short < 600) return 'phone'
  if (coarse || /iPad|Tablet/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'tablet'
  return 'desktop'
}

export function deviceLabel(kind: FormFactor): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${browser} on ${kind === 'phone' ? 'phone' : kind === 'tablet' ? 'tablet' : 'computer'}`
}

/**
 * Where each listen happened. Events recorded here carry no device; synced ones carry the id of the
 * device that recorded them. Unknown ids are the Android app, so they count as a phone.
 */
export function deviceMinutes(events: (PlayEvent & { device?: string })[], start: number, end: number, devices: Record<string, DeviceInfo>, thisDevice: string, thisKind: FormFactor): Record<FormFactor, number> {
  const ms: Record<FormFactor, number> = { phone: 0, tablet: 0, desktop: 0 }
  for (const e of events) {
    if (e.startedAt < start || e.startedAt >= end || !counts(e)) continue
    const id = e.device ?? thisDevice
    const kind = id === thisDevice ? thisKind : devices[id]?.kind ?? 'phone'
    ms[kind] += e.listenedMs
  }
  return { phone: Math.round(ms.phone / 60_000), tablet: Math.round(ms.tablet / 60_000), desktop: Math.round(ms.desktop / 60_000) }
}

const dayOf = (ts: number) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
const nextDay = (day: number) => { const d = new Date(day); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() }

export interface Streaks {
  /** Days in a row up to today (or yesterday, if you haven't listened yet today). */
  current: number
  /** Your longest run ever, and the day it ended. */
  longest: number
  longestEnd: number | null
}

/** Listening-day streaks across all your history. */
export function streaks(events: PlayEvent[], now = Date.now()): Streaks {
  const days = [...new Set(events.filter(counts).map((e) => dayOf(e.startedAt)))].sort((a, b) => a - b)
  let longest = 0, longestEnd: number | null = null, run = 0, prev = 0
  for (const d of days) {
    run = prev && nextDay(prev) === d ? run + 1 : 1
    if (run >= longest) { longest = run; longestEnd = d }
    prev = d
  }
  const today = dayOf(now)
  const yesterday = dayOf(today - 12 * 3_600_000)
  const set = new Set(days)
  let current = 0
  let d = set.has(today) ? today : set.has(yesterday) ? yesterday : 0
  while (d && set.has(d)) { current++; d = dayOf(d - 12 * 3_600_000) }
  return { current, longest, longestEnd }
}

const snapTrack = (t: Track): SnapTrack => ({ id: t.id, title: t.title, artist: t.artist, album: t.album ?? null, artworkUrl: t.artworkUrl ?? null, playbackRef: t.playbackRef, durationMs: t.durationMs ?? null })

export function toSnapshot(w: Wrapped, devices: Record<FormFactor, number>, bestStreak: number): ReplaySnapshot {
  return {
    key: w.key, label: w.label, kind: w.kind, minutes: w.minutes, plays: w.plays, artistsCount: w.artistsCount, change: w.change,
    songs: w.songs.map((s) => ({ track: snapTrack(s.track), plays: s.plays, minutes: s.minutes })),
    artists: w.artists, albums: w.albums, devices, streak: w.streak, bestStreak, at: Date.now(),
  }
}

/** Every period you have history for, as snapshots (top 10 of each list). */
export function snapshotAll(events: (PlayEvent & { device?: string })[], track: (id: string) => Track | undefined, devices: Record<string, DeviceInfo>, thisDevice: string, thisKind: FormFactor): ReplaySnapshot[] {
  const best = streaks(events).longest
  const out: ReplaySnapshot[] = []
  for (const key of [...wrappedYears(events), ...wrappedMonths(events)]) {
    const w = buildWrapped(key, events, track, 10)
    if (!w) continue
    const { start, end } = rangeOf(key)
    out.push(toSnapshot(w, deviceMinutes(events, start, end, devices, thisDevice, thisKind), best))
  }
  return out
}

/** The Replay to show: computed from history, unless the saved one has more listening in it. */
export function pickReplay(computed: ReplaySnapshot | null, saved: ReplaySnapshot | undefined): { view: ReplaySnapshot | null; fromSaved: boolean } {
  if (!computed) return { view: saved ?? null, fromSaved: !!saved }
  if (saved && saved.minutes > computed.minutes + 1) return { view: saved, fromSaved: true }
  return { view: computed, fromSaved: false }
}

// ── Export ────────────────────────────────────────────────────────────────

const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`

/** One CSV per period: a row per artist, song and album with minutes and plays. */
export function replayCsv(views: ReplaySnapshot[]): string {
  const rows: unknown[][] = [['period', 'section', 'rank', 'name', 'artist', 'minutes', 'plays']]
  for (const v of views) {
    rows.push([v.key, 'total', '', v.label, '', v.minutes, v.plays])
    for (const [k, m] of Object.entries(v.devices ?? {})) if (m) rows.push([v.key, 'device', '', k, '', m, ''])
    v.artists.forEach((a, i) => rows.push([v.key, 'artist', i + 1, a.name, '', a.minutes, a.plays]))
    v.songs.forEach((s, i) => rows.push([v.key, 'song', i + 1, s.track.title, s.track.artist, s.minutes, s.plays]))
    v.albums.forEach((a, i) => rows.push([v.key, 'album', i + 1, a.name, a.artist, a.minutes, '']))
  }
  return rows.map((r) => r.map(cell).join(',')).join('\n')
}

export function replayJson(views: ReplaySnapshot[]): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    periods: views.map((v) => ({
      period: v.key, label: v.label, minutes: v.minutes, plays: v.plays, artists: v.artistsCount, changePercent: v.change,
      devicesMinutes: v.devices, longestStreakInPeriod: v.streak, longestStreakEver: v.bestStreak,
      topArtists: v.artists.map((a) => ({ name: a.name, minutes: a.minutes, plays: a.plays })),
      topSongs: v.songs.map((s) => ({ title: s.track.title, artist: s.track.artist, album: s.track.album ?? null, youtubeId: s.track.playbackRef, minutes: s.minutes, plays: s.plays })),
      topAlbums: v.albums.map((a) => ({ name: a.name, artist: a.artist, minutes: a.minutes })),
    })),
  }, null, 2)
}

export function download(name: string, text: string, type: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
