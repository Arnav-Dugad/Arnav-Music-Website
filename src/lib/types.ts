/** Domain model — mirrors the Android app's `com.arnav.music.domain.model` so data syncs both ways. */

export type SourceType = 'YOUTUBE' | 'LOCAL'
export type MediaVariant = 'SONG' | 'VIDEO'

/** Stable cross-source id: "yt:<videoId>" or "local:<id>". */
export type TrackId = string

export interface Track {
  id: TrackId
  title: string
  artist: string
  album?: string | null
  durationMs?: number | null
  artworkUrl?: string | null
  /** YouTube video id. */
  playbackRef: string
  channelId?: string | null
  genres: string[]
  /** Estimated 0..1 energy; null when unknown — never fabricated. */
  energy?: number | null
  year?: number | null
  variant?: MediaVariant | null
  credits?: string | null
  compilation?: boolean
  // Web-only catalog signals (never synced): who uploaded it and how official it is.
  channelTitle?: string | null
  rawTitle?: string | null
  views?: number | null
  /** The title named no artist; the uploader's channel name stands in. */
  artistFromChannel?: boolean
  /** Title-parser version that produced title/artist/album (re-parsed when it changes). */
  parseV?: number
  /** -1 fan upload · 0 unverified · 1 established · 2 artist channel · 3 official (Topic/VEVO/label). */
  trust?: -1 | 0 | 1 | 2 | 3 | null
}

export interface Artist {
  key: string
  name: string
  artworkUrl?: string | null
  channelId?: string | null
}

export type PlaylistKind = 'ARNAV' | 'YOUTUBE' | 'LOCAL' | 'SMART'

export interface Playlist {
  id: string
  name: string
  description: string
  kind: PlaylistKind
  artworkUrl?: string | null
  trackIds: TrackId[]
  createdAt: number
  updatedAt: number
  pinned: boolean
  deleted?: boolean
  /** Linked remote YouTube playlist id for imported playlists. */
  remoteRef?: string | null
}

/** One listening event — same shape as the app's PlayEvent / SharedListen. */
export interface PlayEvent {
  trackId: TrackId
  artistKey: string
  startedAt: number
  listenedMs: number
  durationMs: number | null
  completed: boolean
  skipped: boolean
  source: SourceType
  /** Cloud record id (h_<sha256>) once synced. */
  cloudId?: string
}

export interface Like {
  trackId: TrackId
  likedAt: number
  updatedAt: number
  deleted: boolean
}

export const ytId = (videoId: string): TrackId => `yt:${videoId}`
export const nativeId = (id: TrackId) => id.slice(id.indexOf(':') + 1)
export const sourceOf = (id: TrackId): SourceType => (id.startsWith('local:') ? 'LOCAL' : 'YOUTUBE')

const featRegex = /(?:\s+|\s*[([]\s*)(feat\.?|ft\.?|featuring|with)\s.*$/i
const topicSuffix = /\s*-\s*topic$/i
const vevoSuffix = /vevo$/i

/** Normalised artist identity used for affinity math — identical to the app's ArtistKey.of. */
export function artistKey(raw: string): string {
  const primary = raw.split(/[,&×/]/)[0] ?? ''
  const k = primary
    .replace(featRegex, '')
    .replace(topicSuffix, '')
    .trim()
    .replace(vevoSuffix, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
  return k || raw.toLowerCase().trim()
}

export type Mood =
  | 'ENERGETIC' | 'UPBEAT' | 'CALM' | 'FOCUS' | 'NIGHT' | 'MELANCHOLY' | 'ROMANTIC'
  | 'PARTY' | 'WORKOUT' | 'CINEMATIC' | 'ACOUSTIC' | 'CHILL' | 'AGGRESSIVE' | 'NOSTALGIC'

export const MOODS: Record<Mood, { label: string; energy: number; valence: number; hue: number }> = {
  ENERGETIC: { label: 'Energetic', energy: 0.85, valence: 0.75, hue: 14 },
  UPBEAT: { label: 'Upbeat', energy: 0.72, valence: 0.85, hue: 42 },
  CALM: { label: 'Calm', energy: 0.25, valence: 0.6, hue: 165 },
  FOCUS: { label: 'Focus', energy: 0.45, valence: 0.5, hue: 205 },
  NIGHT: { label: 'Late night', energy: 0.4, valence: 0.4, hue: 245 },
  MELANCHOLY: { label: 'Melancholy', energy: 0.3, valence: 0.2, hue: 220 },
  ROMANTIC: { label: 'Romantic', energy: 0.4, valence: 0.7, hue: 340 },
  PARTY: { label: 'Party', energy: 0.9, valence: 0.9, hue: 300 },
  WORKOUT: { label: 'Workout', energy: 0.95, valence: 0.6, hue: 0 },
  CINEMATIC: { label: 'Cinematic', energy: 0.55, valence: 0.5, hue: 260 },
  ACOUSTIC: { label: 'Acoustic', energy: 0.35, valence: 0.6, hue: 30 },
  CHILL: { label: 'Chill', energy: 0.35, valence: 0.65, hue: 185 },
  AGGRESSIVE: { label: 'Aggressive', energy: 0.97, valence: 0.3, hue: 355 },
  NOSTALGIC: { label: 'Nostalgic', energy: 0.45, valence: 0.55, hue: 28 },
}
export const MOOD_KEYS = Object.keys(MOODS) as Mood[]

export interface AestheticDescriptor {
  mood: string
  energy: number
  warmth: number
  motion: number
  density: number
  paletteHints: string[]
}

export type MusicErrorKind = 'missingKey' | 'quota' | 'offline' | 'unavailable' | 'notConfigured' | 'http'
export class MusicError extends Error {
  constructor(public kind: MusicErrorKind, message?: string, public status?: number) {
    super(message ?? kind)
  }
}
