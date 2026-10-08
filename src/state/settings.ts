import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Mood } from '../lib/types'

export type ThemeMode = 'system' | 'dark' | 'light'
export type MotionLevel = 'full' | 'reduced' | 'off'

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
