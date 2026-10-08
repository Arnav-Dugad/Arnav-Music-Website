import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Mood } from '../lib/types'

export type ThemeMode = 'system' | 'dark' | 'light'
export type MotionLevel = 'full' | 'reduced' | 'off'
/** How one song hands over to the next (per playlist, or the default). */
export type AutomixStyle = 'off' | 'gapless' | 'crossfade' | 'smart'
export type PlayerBarPreset = 'compact' | 'wide' | 'studio'

export interface Settings {
  onboardingDone: boolean
  guestMode: boolean
  themeMode: ThemeMode
  accentMode: 'artwork' | 'preset'
  presetAccent: string
  glass: boolean
  motion: MotionLevel
  highContrast: boolean
  // playback
  preferVideos: boolean
  /** Official uploads only (Topic / VEVO / labels / artist channels / established channels). */
  verifiedOnly: boolean
  autoReplaceUnavailable: boolean
  endlessRadio: boolean
  crossfadeOnSkip: boolean
  /** App fields (synced): next song starts without a gap. */
  gapless: boolean
  /** App field (synced): crossfade length between songs; 0 = none. */
  crossfadeMs: number
  /** App field (synced): fade length follows each pair of songs (energy, tempo, intros). */
  smartTransitions: boolean
  /** App field (synced): visuals move with the beat (shader background, lyric pulse). */
  beatVisuals: boolean
  playerBar: PlayerBarPreset
  /** The record slides out of its sleeve and spins while playing. */
  vinylMode: boolean
  /** Which script to prefer when a song has lyrics in several ("auto" follows the song title). */
  lyricsScript: 'auto' | 'original' | 'latin'
  /** Shift lyrics to fit the video (intro scenes) when the timing source is the audio release. */
  autoAlignLyrics: boolean
  ambientIdle: boolean
  coverBreathing: boolean
  movingGradient: boolean
  // lyrics
  onlineLyrics: boolean
  miniPlayerLyrics: boolean
  // AI
  aiEnabled: boolean
  /** Spoken AI DJ intros between songs (on-device voice). */
  aiDj: boolean
  /** Use local weather (with location permission) to suggest moods and moments. */
  weatherMoods: boolean
  aiPersonalization: boolean
  explanations: boolean
  dailyAiLimit: number
  // sources
  youtubeKey: string
  youtubeDailyBudget: number
  regionCode: string
  // sync
  cloudSync: boolean
  /** Keep shared preferences (theme, AI, playback, taste) in sync with the Android app. */
  syncSettings: boolean
  // taste
  selectedMoods: Mood[]
  seedArtists: string[]
  homeLayout: 'shelves' | 'grid'
  libraryLayout: 'grid' | 'list'
  /** Desktop: keep Now Playing docked beside the page. */
  dockedPlayer: boolean
  /** The old cover dissolves into particles as the new one forms. */
  coverParticles: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  onboardingDone: false,
  guestMode: false,
  themeMode: 'dark',
  accentMode: 'artwork',
  presetAccent: '#8C7CFF',
  glass: true,
  motion: 'full',
  highContrast: false,
  preferVideos: false,
  verifiedOnly: true,
  autoReplaceUnavailable: true,
  endlessRadio: true,
  crossfadeOnSkip: true,
  gapless: true,
  crossfadeMs: 6000,
  smartTransitions: true,
  beatVisuals: true,
  playerBar: 'wide',
  vinylMode: false,
  lyricsScript: 'auto',
  autoAlignLyrics: true,
  ambientIdle: true,
  coverBreathing: true,
  movingGradient: true,
  onlineLyrics: true,
  miniPlayerLyrics: true,
  aiEnabled: true,
  aiDj: false,
  weatherMoods: false,
  aiPersonalization: true,
  explanations: true,
  dailyAiLimit: 40,
  youtubeKey: '',
  youtubeDailyBudget: 10000,
  regionCode: '',
  cloudSync: true,
  syncSettings: true,
  selectedMoods: [],
  seedArtists: [],
  homeLayout: 'shelves',
  libraryLayout: 'grid',
  dockedPlayer: false,
  coverParticles: true,
}

interface SettingsStore extends Settings {
  update: (patch: Partial<Settings>) => void
  reset: () => void
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (patch) => set(patch),
      reset: () => set({ ...DEFAULT_SETTINGS, onboardingDone: true }),
    }),
    {
      name: 'arnav.settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ update: _u, reset: _r, ...rest }) => rest,
      merge: (persisted, current) => ({ ...current, ...(persisted as Partial<Settings>) }),
    },
  ),
)

export const settings = () => useSettings.getState()

/** The default hand-over style, from the app-compatible fields. */
export function defaultAutomix(s: Settings = settings()): AutomixStyle {
  if (s.crossfadeMs > 0) return s.smartTransitions ? 'smart' : 'crossfade'
  return s.gapless ? 'gapless' : 'off'
}
export function automixPatch(style: AutomixStyle, s: Settings = settings()): Partial<Settings> {
  const fade = s.crossfadeMs > 0 ? s.crossfadeMs : 6000
  if (style === 'off') return { gapless: false, crossfadeMs: 0 }
  if (style === 'gapless') return { gapless: true, crossfadeMs: 0 }
  return { gapless: true, crossfadeMs: fade, smartTransitions: style === 'smart' }
}

/** Region for charts: explicit setting, else the browser's locale region. */
export function regionCode(): string {
  const s = settings().regionCode.trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(s)) return s
  try {
    const loc = new Intl.Locale(navigator.language)
    const r = loc.maximize().region
    if (r && /^[A-Z]{2}$/.test(r)) return r
  } catch { /* ignore */ }
  return 'US'
}
