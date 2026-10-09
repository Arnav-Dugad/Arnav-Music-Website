import { describe, expect, it } from 'vitest'
import { deviceMinutes, pickReplay, replayCsv, replayJson, streaks } from '../src/lib/replay'
import { betterReplay, usePrefs, type ReplaySnapshot } from '../src/state/prefs'
import type { PlayEvent } from '../src/lib/types'

const day = (y: number, m: number, d: number, h = 20) => new Date(y, m - 1, d, h).getTime()
const ev = (at: number, ms = 200_000, device?: string): PlayEvent & { device?: string } => ({ trackId: 'yt:a', artistKey: 'a', startedAt: at, listenedMs: ms, durationMs: 200_000, completed: true, skipped: false, source: 'YOUTUBE', device })

describe('streaks', () => {
  it('finds the longest run and the current one', () => {
    const events = [1, 2, 3, 4, 7, 8, 20, 21, 22].map((d) => ev(day(2026, 9, d)))
    const s = streaks(events, day(2026, 9, 22, 23))
    expect(s.longest).toBe(4)
    expect(new Date(s.longestEnd!).getDate()).toBe(4)
    expect(s.current).toBe(3)
  })
  it('a streak survives until you miss a whole day', () => {
    const events = [10, 11].map((d) => ev(day(2026, 9, d)))
    expect(streaks(events, day(2026, 9, 12, 9)).current).toBe(2) // not played yet today
    expect(streaks(events, day(2026, 9, 13, 9)).current).toBe(0)
  })
  it('ignores listens under 15 seconds', () => {
    expect(streaks([ev(day(2026, 9, 1), 5_000)]).longest).toBe(0)
  })
})

describe('where you listened', () => {
  it('splits minutes by device kind; unknown devices are the phone app', () => {
    const devices = { lap: { kind: 'desktop' as const, label: 'Chrome on computer', at: 1 }, tab: { kind: 'tablet' as const, label: 'x', at: 1 } }
    const s = day(2026, 9, 1, 0), e = day(2026, 10, 1, 0)
    const events = [ev(day(2026, 9, 2), 600_000), ev(day(2026, 9, 3), 1_200_000, 'tab'), ev(day(2026, 9, 4), 300_000, 'android-123'), ev(day(2026, 9, 5), 300_000, 'lap')]
    expect(deviceMinutes(events, s, e, devices, 'lap', 'desktop')).toEqual({ phone: 5, tablet: 20, desktop: 15 })
  })
})

const snap = (minutes: number, at = 1): ReplaySnapshot => ({ key: '2026-09', label: 'September 2026', kind: 'month', minutes, plays: 3, artistsCount: 1, change: null, songs: [{ track: { id: 'yt:a', title: 'Song, "A"', artist: 'Ar', album: null, artworkUrl: null, playbackRef: 'a', durationMs: 1 }, plays: 3, minutes }], artists: [{ name: 'Ar', plays: 3, minutes, art: null }], albums: [], devices: { phone: minutes, tablet: 0, desktop: 0 }, streak: 2, bestStreak: 5, at })

describe('saved Replays', () => {
  it('keeps the fuller copy when merging', () => {
    expect(betterReplay(snap(100), snap(80))).toBe(true)
    expect(betterReplay(snap(80, 9), snap(100))).toBe(false)
    expect(betterReplay(snap(100, 9), snap(100, 1))).toBe(false) // same content
  })
  it('shows the saved copy once local history is trimmed', () => {
    expect(pickReplay(snap(40), snap(120)).fromSaved).toBe(true)
    expect(pickReplay(snap(120), snap(120)).fromSaved).toBe(false)
    expect(pickReplay(null, snap(10)).view?.minutes).toBe(10)
  })
  it('merges synced snapshots per period', () => {
    usePrefs.setState({ replay: { '2026-09': snap(100) } })
    usePrefs.getState().merge('replay', { '2026-09': snap(60, 99), '2026-08': { ...snap(30), key: '2026-08' } }, 99)
    const r = usePrefs.getState().replay
    expect(r['2026-09'].minutes).toBe(100)
    expect(r['2026-08'].minutes).toBe(30)
  })
  it('exports CSV and JSON', () => {
    const csv = replayCsv([snap(100)])
    expect(csv.split('\n')[0]).toBe('"period","section","rank","name","artist","minutes","plays"')
    expect(csv).toContain('"2026-09","song","1","Song, ""A""","Ar","100","3"')
    expect(JSON.parse(replayJson([snap(100)])).periods[0].topSongs[0].youtubeId).toBe('a')
  })
})

describe('glass history', () => {
  it('undoes a change, and a slider drag counts as one step', () => {
    usePrefs.setState({ glass: {} })
    const g = () => usePrefs.getState().glass.dev
    usePrefs.getState().setGlass('dev', { style: 'clear' })
    usePrefs.getState().setGlass('dev', { strength: 40 })
    usePrefs.getState().setGlass('dev', { strength: 30 })
    usePrefs.getState().setGlass('dev', { strength: 20 })
    expect(g().history!.map((h) => [h.style, h.strength])).toEqual([['clear', 60], ['tinted', 60]])
    usePrefs.getState().undoGlass('dev')
    expect([g().style, g().strength]).toEqual(['clear', 60])
    usePrefs.getState().undoGlass('dev')
    expect([g().style, g().strength]).toEqual(['tinted', 60])
    expect(g().history).toEqual([])
  })
})
