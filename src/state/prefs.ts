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

interface Prefs {
  playlistAutomix: Record<string, AutomixStyle>
  lyricsFix: Record<string, LyricsFix>
  /** Per-family edit times, for last-write-wins merges with other browsers. */
  stamps: Record<string, number>
}

interface PrefsStore extends Prefs {
  setPlaylistAutomix: (playlistId: string, style: AutomixStyle | null) => void
  setLyricsFix: (trackId: string, fix: Partial<LyricsFix> | null) => void
  merge: (family: keyof Omit<Prefs, 'stamps'>, value: unknown, at: number) => void
}

const MAX_FIXES = 1500

export const usePrefs = create<PrefsStore>()(
  persist(
    (set, get) => ({
      playlistAutomix: {},
      lyricsFix: {},
      stamps: {},
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
