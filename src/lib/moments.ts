import type { AestheticDescriptor, Mood } from './types'

export type MomentMotion = 'DRIFT' | 'PULSE' | 'RAIN' | 'SHIMMER' | 'STILL' | 'SURGE'

export interface Moment {
  id: string
  title: string
  subtitle: string
  moods: Mood[]
  seedQueries: string[]
  aesthetic: AestheticDescriptor
  motion: MomentMotion
  /** Three colours the environment is painted with. */
  palette: [string, string, string]
  /** Typeface personality for the environment. */
  type: 'display' | 'mono' | 'serif'
}

const a = (mood: string, energy: number, warmth: number, motion: number, density: number, paletteHints: string[]): AestheticDescriptor =>
  ({ mood, energy, warmth, motion, density, paletteHints })

/** The app's ten immersive procedural environments — no images, no AI image generation. */
export const MOMENTS: Moment[] = [
  { id: 'night_drive', title: 'Night Drive', subtitle: 'Neon roads, steady pulse', moods: ['NIGHT', 'CINEMATIC'],
    seedQueries: ['synthwave night drive', 'late night drive songs', 'retrowave'], aesthetic: a('midnight_drive', 0.62, 0.25, 0.45, 0.35, ['indigo', 'magenta']),
    motion: 'DRIFT', palette: ['#0B1030', '#3A1C71', '#D76D77'], type: 'display' },
  { id: 'rain', title: 'Rain', subtitle: 'Soft textures for grey days', moods: ['CALM', 'MELANCHOLY'],
    seedQueries: ['rainy day lofi', 'ambient piano rain', 'mellow indie'], aesthetic: a('rain', 0.25, 0.35, 0.3, 0.6, ['slate', 'teal']),
    motion: 'RAIN', palette: ['#1C2833', '#2E4053', '#5D8AA8'], type: 'serif' },
  { id: 'deep_focus', title: 'Deep Focus', subtitle: 'Minimal, wordless, unbroken', moods: ['FOCUS', 'CALM'],
    seedQueries: ['deep focus instrumental', 'study beats', 'minimal electronic focus'], aesthetic: a('focus', 0.4, 0.45, 0.15, 0.2, ['graphite', 'sage']),
    motion: 'STILL', palette: ['#101418', '#1F2A2E', '#7FA38A'], type: 'mono' },
  { id: 'golden_hour', title: 'Golden Hour', subtitle: 'Warm light, easy rhythm', moods: ['UPBEAT', 'CHILL'],
    seedQueries: ['golden hour indie', 'sunset chill', 'feel good acoustic'], aesthetic: a('golden_hour', 0.55, 0.9, 0.35, 0.4, ['amber', 'rose']),
    motion: 'SHIMMER', palette: ['#2B1608', '#B8572A', '#F4C27A'], type: 'serif' },
  { id: 'gym', title: 'Gym', subtitle: 'Heavy sets, no small talk', moods: ['WORKOUT', 'ENERGETIC'],
    seedQueries: ['workout hip hop', 'gym motivation', 'high energy edm'], aesthetic: a('gym', 0.95, 0.55, 0.8, 0.7, ['crimson', 'steel']),
    motion: 'SURGE', palette: ['#140606', '#7A1010', '#FF5A36'], type: 'display' },
  { id: 'late_night', title: 'Late Night', subtitle: 'Low lights, slow thoughts', moods: ['NIGHT', 'CHILL'],
    seedQueries: ['late night r&b', 'midnight lofi', 'slow jams'], aesthetic: a('late_night', 0.35, 0.3, 0.25, 0.3, ['navy', 'violet']),
    motion: 'DRIFT', palette: ['#05060F', '#1B1F4B', '#6C5CE7'], type: 'display' },
  { id: 'calm', title: 'Calm', subtitle: 'Breathe out', moods: ['CALM', 'ACOUSTIC'],
    seedQueries: ['calm acoustic', 'ambient relaxing', 'soft piano'], aesthetic: a('calm', 0.2, 0.55, 0.15, 0.2, ['mist', 'sand']),
    motion: 'STILL', palette: ['#121615', '#2F3E3A', '#B9D3C2'], type: 'serif' },
  { id: 'throwback', title: 'Throwback', subtitle: 'Songs that remember you', moods: ['NOSTALGIC', 'UPBEAT'],
    seedQueries: ['2000s hits', '90s classics', 'throwback party songs'], aesthetic: a('throwback', 0.65, 0.7, 0.4, 0.5, ['teal', 'coral']),
    motion: 'PULSE', palette: ['#0F1F24', '#1E6F72', '#FF8A65'], type: 'display' },
  { id: 'discovery', title: 'Discovery', subtitle: 'Just outside your comfort zone', moods: ['UPBEAT', 'CINEMATIC'],
    seedQueries: ['new indie songs', 'underground electronic', 'alternative discoveries'], aesthetic: a('discovery', 0.6, 0.5, 0.5, 0.5, ['cyan', 'lime']),
    motion: 'SHIMMER', palette: ['#061417', '#0E4D64', '#9BE15D'], type: 'mono' },
  { id: 'high_energy', title: 'High Energy', subtitle: 'All gas', moods: ['PARTY', 'ENERGETIC'],
    seedQueries: ['party anthems', 'dance hits', 'high energy pop'], aesthetic: a('high_energy', 0.92, 0.65, 0.75, 0.75, ['magenta', 'gold']),
    motion: 'PULSE', palette: ['#16041C', '#8E2DE2', '#FFC837'], type: 'display' },
]

export const momentById = (id: string) => MOMENTS.find((m) => m.id === id)

/** Time-of-day aware featured moment (the app's featuredMoment). */
export function featuredMoment(hour = new Date().getHours(), selected: Mood[] = []): Moment {
  const pick = (id: string) => momentById(id)!
  const byMood = selected.length ? MOMENTS.find((m) => m.moods.some((x) => selected.includes(x))) : undefined
  if (hour >= 22 || hour < 4) return pick('late_night')
  if (hour >= 19) return pick('night_drive')
  if (hour >= 17) return pick('golden_hour')
  if (hour >= 9 && hour < 12) return byMood ?? pick('deep_focus')
  if (hour >= 5 && hour < 9) return pick('calm')
  return byMood ?? pick('discovery')
}
