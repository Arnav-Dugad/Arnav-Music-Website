import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AutomixStyle } from './settings'
import type { Track } from '../lib/types'

/**
 * Web preferences that follow you between browsers (synced as `w_*` live records, which the app
 * ignores): per-playlist automix and your lyric fixes (version, timing).
 */
export interface LyricsFix {
  /** "lrclib:<id>" / "netease:<id>" — the version you picked. */
  choice?: string
  /** Lyrics shift in ms (+ = later). */
  offsetMs?: number
  /** Tempo scale fitted by "Fix timing" (1 = none). */
  scale?: number
  /** Piecewise timing for an edited video: [lrcFrom, lrcTo, offsetMs] per part. */
  map?: [number, number, number][]
  /** Who made the timing: you, or Arnav AI listening to the video. */
  by?: 'you' | 'ai'
  at: number
}

/** Liquid Glass preferences for one device (a phone wants different glass than a big monitor). */
export interface GlassPref {
  /** Tinted (frosted, coloured by the album) or Clear (iOS 26's see-through style). */
  style: 'tinted' | 'clear'
  /** 0 – 100: how much frost and tint. */
  strength: number
  /** Adjust to how busy the artwork behind is. */
  adaptive: boolean
  at: number
  /** Earlier settings on this device, newest first (so a change can be undone, here or after a sync). */
  history?: GlassState[]
}
export type GlassState = Omit<GlassPref, 'history'>
const GLASS_HISTORY = 12
/** Changes this close together (dragging the slider) count as one step. */
const GLASS_COALESCE_MS = 2500
export const DEFAULT_GLASS: GlassPref = { style: 'tinted', strength: 60, adaptive: true, at: 0 }

export type FormFactor = 'phone' | 'tablet' | 'desktop'
/** A browser you use Arnav Music in, so Replay can say where you listened. */
export interface DeviceInfo { kind: FormFactor; label: string; at: number }

/** Song in a Replay snapshot: just enough to show and play it. */
export type SnapTrack = Pick<Track, 'id' | 'title' | 'artist' | 'album' | 'artworkUrl' | 'playbackRef' | 'durationMs'>
/**
 * A month's (or year's) Replay, saved and synced so it survives when older listening history is
 * trimmed from a device. The copy with more listening in it wins a merge.
 */
export interface ReplaySnapshot {
  key: string
  label: string
  kind: 'month' | 'year'
  minutes: number
  plays: number
  artistsCount: number
  change: number | null
  songs: { track: SnapTrack; plays: number; minutes: number }[]
  artists: { name: string; plays: number; minutes: number; art: string | null }[]
  albums: { name: string; artist: string; minutes: number; art: string | null }[]
  /** Minutes on each kind of device. */
  devices: Record<FormFactor, number>
  /** Longest run of listening days inside the period. */
  streak: number
  /** Your all-time longest streak as of this snapshot. */
  bestStreak: number
  at: number
}

interface Prefs {
  playlistAutomix: Record<string, AutomixStyle>
  lyricsFix: Record<string, LyricsFix>
  /** Glass preferences per device id, synced so every device keeps its own and a new one starts from your latest. */
  glass: Record<string, GlassPref>
  /** Your browsers and what kind of device each is (phone / tablet / desktop). */
  devices: Record<string, DeviceInfo>
  /** Saved Replays by period ("2026-10", "2026"). */
  replay: Record<string, ReplaySnapshot>
  /** Per-family edit times, for last-write-wins merges with other browsers. */
  stamps: Record<string, number>
}

interface PrefsStore extends Prefs {
  setPlaylistAutomix: (playlistId: string, style: AutomixStyle | null) => void
  setLyricsFix: (trackId: string, fix: Partial<LyricsFix> | null) => void
  setGlass: (deviceId: string, patch: Partial<Omit<GlassState, 'at'>>) => void
  /** Goes back to the glass you had before the last change (or to a given earlier one). */
  undoGlass: (deviceId: string, index?: number) => void
  setDevice: (deviceId: string, info: Omit<DeviceInfo, 'at'>) => void
  saveReplay: (snaps: ReplaySnapshot[]) => void
  merge: (family: keyof Omit<Prefs, 'stamps'>, value: unknown, at: number) => void
}

const MAX_FIXES = 1500

export const usePrefs = create<PrefsStore>()(
  persist(
    (set, get) => ({
      playlistAutomix: {},
      lyricsFix: {},
      glass: {},
      devices: {},
      replay: {},
      stamps: {},
      setDevice(id, info) {
        const cur = get().devices[id]
        if (cur && cur.kind === info.kind && cur.label === info.label && Date.now() - cur.at < 7 * 86_400_000) return
        const now = Date.now()
        set({ devices: { ...get().devices, [id]: { ...info, at: now } }, stamps: { ...get().stamps, devices: now } })
      },
      saveReplay(snaps) {
        const out = { ...get().replay }
        let changed = false
        for (const sn of snaps) if (betterReplay(sn, out[sn.key])) { out[sn.key] = sn; changed = true }
        if (!changed) return
        // Keep the newest 40 periods (about three years of months plus the years).
        const keys = Object.keys(out).sort().reverse()
        for (const k of keys.slice(40)) delete out[k]
        set({ replay: out, stamps: { ...get().stamps, replay: Date.now() } })
      },
      setGlass(id, patch) {
        const cur = get().glass[id] ?? { ...glassFor(get().glass, id), history: [] }
        const { history = [], ...was } = cur
        const now = Date.now()
        const next = { ...was, ...patch }
        if (next.style === was.style && next.strength === was.strength && next.adaptive === was.adaptive) return
        // Remember what it was — unless this continues the change just made (a slider drag).
        const prev = history[0]
        const continuing = !!prev && now - was.at < GLASS_COALESCE_MS && Object.keys(patch).every((k) => k === 'strength') && prev.style === was.style && prev.adaptive === was.adaptive
        const hist = continuing ? history : [was, ...history].slice(0, GLASS_HISTORY)
        set({ glass: { ...get().glass, [id]: { ...next, at: now, history: hist } }, stamps: { ...get().stamps, glass: now } })
      },
      undoGlass(id, index = 0) {
        const cur = get().glass[id]
        const target = cur?.history?.[index]
        if (!cur || !target) return
        const now = Date.now()
        set({ glass: { ...get().glass, [id]: { ...target, at: now, history: cur.history!.slice(index + 1) } }, stamps: { ...get().stamps, glass: now } })
      },
      setPlaylistAutomix(id, style) {
        const next = { ...get().playlistAutomix }
        if (style) next[id] = style
        else delete next[id]
        set({ playlistAutomix: next, stamps: { ...get().stamps, playlistAutomix: Date.now() } })
      },
      setLyricsFix(id, fix) {
        const next = { ...get().lyricsFix }
        if (fix) next[id] = { ...next[id], ...fix, at: Date.now() }
        else delete next[id]
        const keys = Object.keys(next)
        if (keys.length > MAX_FIXES) {
          keys.sort((a, b) => next[a].at - next[b].at).slice(0, keys.length - MAX_FIXES).forEach((k) => delete next[k])
        }
        set({ lyricsFix: next, stamps: { ...get().stamps, lyricsFix: Date.now() } })
      },
      merge(family, value, at) {
        if (!value || typeof value !== 'object') return
        if (family === 'devices') {
          const out = { ...get().devices }
          for (const [k, v] of Object.entries(value as Record<string, DeviceInfo>)) if (v && typeof v.at === 'number' && (!out[k] || out[k].at < v.at)) out[k] = v
          set({ devices: out })
          return
        }
        if (family === 'replay') {
          const out = { ...get().replay }
          for (const [k, v] of Object.entries(value as Record<string, ReplaySnapshot>)) if (v && typeof v.minutes === 'number' && betterReplay(v, out[k])) out[k] = v
          set({ replay: out })
          return
        }
        if (family === 'glass') {
          // Per device: the newer setting wins.
          const out = { ...get().glass }
          for (const [k, v] of Object.entries(value as Record<string, GlassPref>)) if (v && typeof v.at === 'number' && (!out[k] || out[k].at < v.at)) out[k] = v
          set({ glass: out })
          return
        }
        if (family === 'lyricsFix') {
          // Per song: the newer fix wins.
          const mine = get().lyricsFix
          const theirs = value as Record<string, LyricsFix>
          const out = { ...mine }
          for (const [k, v] of Object.entries(theirs)) if (v && typeof v.at === 'number' && (!out[k] || out[k].at < v.at)) out[k] = v
          set({ lyricsFix: out })
        } else if ((get().stamps[family] ?? 0) < at) {
          set({ [family]: value, stamps: { ...get().stamps, [family]: at } } as Partial<Prefs>)
        }
      },
    }),
    { name: 'arnav.prefs', version: 1, storage: createJSONStorage(() => localStorage) },
  ),
)

export const prefs = () => usePrefs.getState()

/** This device's glass — or, for a device that hasn't chosen yet, your most recent choice anywhere. */
export function glassFor(all: Record<string, GlassPref>, deviceId: string): GlassPref {
  if (all[deviceId]) return all[deviceId]
  const latest = Object.values(all).sort((a, b) => b.at - a.at)[0]
  if (!latest) return DEFAULT_GLASS
  const { history: _h, ...rest } = latest
  void _h
  return { ...rest }
}

/** A snapshot replaces another when it has more listening in it (a fuller history), or the same and is newer. */
export function betterReplay(a: ReplaySnapshot, b: ReplaySnapshot | undefined): boolean {
  if (!b) return true
  if (a.minutes !== b.minutes) return a.minutes > b.minutes
  return a.at > b.at && JSON.stringify({ ...a, at: 0 }) !== JSON.stringify({ ...b, at: 0 })
}
