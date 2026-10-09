import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { AutomixStyle } from './settings'

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
}
export const DEFAULT_GLASS: GlassPref = { style: 'tinted', strength: 60, adaptive: true, at: 0 }

interface Prefs {
  playlistAutomix: Record<string, AutomixStyle>
  lyricsFix: Record<string, LyricsFix>
  /** Glass preferences per device id, synced so every device keeps its own and a new one starts from your latest. */
  glass: Record<string, GlassPref>
  /** Per-family edit times, for last-write-wins merges with other browsers. */
  stamps: Record<string, number>
}

interface PrefsStore extends Prefs {
  setPlaylistAutomix: (playlistId: string, style: AutomixStyle | null) => void
  setLyricsFix: (trackId: string, fix: Partial<LyricsFix> | null) => void
  setGlass: (deviceId: string, patch: Partial<Omit<GlassPref, 'at'>>) => void
  merge: (family: keyof Omit<Prefs, 'stamps'>, value: unknown, at: number) => void
}

const MAX_FIXES = 1500

export const usePrefs = create<PrefsStore>()(
  persist(
    (set, get) => ({
      playlistAutomix: {},
      lyricsFix: {},
      glass: {},
      stamps: {},
      setGlass(id, patch) {
        const cur = get().glass[id] ?? glassFor(get().glass, id)
        set({ glass: { ...get().glass, [id]: { ...cur, ...patch, at: Date.now() } }, stamps: { ...get().stamps, glass: Date.now() } })
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
  return latest ? { ...latest } : DEFAULT_GLASS
}
