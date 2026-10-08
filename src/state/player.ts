import { create } from 'zustand'
import { ls } from '../lib/idb'
import type { MediaVariant, Track } from '../lib/types'
import { remember } from './tracks'

export type Repeat = 'off' | 'all' | 'one'
export type Panel = 'lyrics' | 'queue' | null
export type Issue = { kind: 'unavailable'; code: number; trackId: string; resolving: boolean } | null
export type SleepTimer = { mode: 'time'; endsAt: number; minutes: number } | { mode: 'track' } | { mode: 'queue' } | null

export interface QueueItem { track: Track; key: string; source?: string }

interface PlayerState {
  queue: QueueItem[]
  index: number
  /** Order before shuffle, to restore. */
  unshuffled: QueueItem[] | null
  shuffle: boolean
  repeat: Repeat
  /** User intent: should be playing. */
  wantPlaying: boolean
  isPlaying: boolean
  isBuffering: boolean
  duration: number
  volume: number
  muted: boolean
  rate: number
  expanded: boolean
  panel: Panel
  issue: Issue
  sleep: SleepTimer
  /** Song/Video switch: which upload type is showing. */
  mode: MediaVariant
  resolvingMode: boolean
  /** Context label shown in Now Playing ("Playing from …"). */
  context: string | null
  /** Incremented to ask the engine to seek. */
  seekRequest: { ms: number; n: number } | null
  radioLoading: boolean
  /** A 15-second hold-to-preview is playing (the queue is untouched). */
  previewing: Track | null
  engineReady: boolean
}

interface PlayerActions {
  play: (tracks: Track[], startIndex?: number, opts?: { context?: string; shuffle?: boolean }) => void
  playNext: (tracks: Track[]) => void
  addToQueue: (tracks: Track[]) => void
  jumpTo: (i: number) => void
  next: (opts?: { auto?: boolean }) => void
  prev: (positionMs: number) => void
  toggle: () => void
  setPlaying: (p: boolean) => void
  seek: (ms: number) => void
  remove: (key: string) => void
  move: (from: number, to: number) => void
  setUpcoming: (items: QueueItem[]) => void
  clearUpcoming: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  setVolume: (v: number) => void
  toggleMute: () => void
  setRate: (r: number) => void
  setExpanded: (e: boolean) => void
  setPanel: (p: Panel) => void
  setSleep: (s: SleepTimer) => void
  replaceCurrent: (t: Track) => void
  patch: (p: Partial<PlayerState>) => void
}

let keySeq = 0
const item = (track: Track, source?: string): QueueItem => ({ track, key: `${track.id}#${++keySeq}`, source })

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const saved = ls.get<{ queue: Track[]; index: number; volume: number; muted: boolean; repeat: Repeat; shuffle: boolean; mode: MediaVariant; context: string | null } | null>('arnav.player', null)

export const usePlayer = create<PlayerState & PlayerActions>()((set, get) => ({
  queue: saved?.queue?.map((t) => item(t)) ?? [],
  index: Math.min(saved?.index ?? 0, Math.max(0, (saved?.queue?.length ?? 1) - 1)),
  unshuffled: null,
  shuffle: saved?.shuffle ?? false,
  repeat: saved?.repeat ?? 'off',
  wantPlaying: false,
  isPlaying: false,
  isBuffering: false,
  duration: 0,
  volume: saved?.volume ?? 80,
  muted: saved?.muted ?? false,
  rate: 1,
  expanded: false,
  panel: null,
  issue: null,
  sleep: null,
  mode: saved?.mode ?? 'SONG',
  resolvingMode: false,
  context: saved?.context ?? null,
  seekRequest: null,
  radioLoading: false,
  previewing: null,
  engineReady: false,

  play(tracks, startIndex = 0, opts = {}) {
    if (!tracks.length) return
    remember(tracks)
    let items = tracks.map((t) => item(t, opts.context))
    let index = Math.min(Math.max(0, startIndex), items.length - 1)
    let unshuffled: QueueItem[] | null = null
    const shuffle = opts.shuffle ?? get().shuffle
    if (shuffle) {
      unshuffled = items
      const first = items[index]
      items = [first, ...shuffled(items.filter((_, i) => i !== index))]
      index = 0
    }
    set({ queue: items, index, unshuffled, shuffle, wantPlaying: true, issue: null, context: opts.context ?? null, duration: 0, seekRequest: null })
  },
  playNext(tracks) {
    remember(tracks)
    const s = get()
    if (!s.queue.length) return get().play(tracks)
    const q = [...s.queue]
    q.splice(s.index + 1, 0, ...tracks.map((t) => item(t)))
    set({ queue: q })
  },
  addToQueue(tracks) {
    remember(tracks)
    const s = get()
    if (!s.queue.length) return get().play(tracks)
    set({ queue: [...s.queue, ...tracks.map((t) => item(t))] })
  },
  jumpTo(i) {
    const s = get()
    if (i < 0 || i >= s.queue.length) return
    set({ index: i, wantPlaying: true, issue: null, duration: 0, seekRequest: null })
  },
  next(opts = {}) {
    const s = get()
    if (!s.queue.length) return
    if (opts.auto && s.repeat === 'one') {
      set({ seekRequest: { ms: 0, n: (s.seekRequest?.n ?? 0) + 1 }, wantPlaying: true })
      return
    }
    if (s.index < s.queue.length - 1) set({ index: s.index + 1, issue: null, duration: 0, wantPlaying: true, seekRequest: null })
    else if (s.repeat === 'all') set({ index: 0, issue: null, duration: 0, wantPlaying: true, seekRequest: null })
    else if (opts.auto) set({ wantPlaying: false })
    else set({ index: s.index, seekRequest: { ms: 0, n: (s.seekRequest?.n ?? 0) + 1 }, wantPlaying: false })
  },
  prev(positionMs) {
    const s = get()
    if (positionMs > 3000 || s.index === 0) {
      set({ seekRequest: { ms: 0, n: (s.seekRequest?.n ?? 0) + 1 } })
      return
    }
    set({ index: s.index - 1, issue: null, duration: 0, wantPlaying: true, seekRequest: null })
  },
  toggle: () => set((s) => ({ wantPlaying: !s.wantPlaying })),
  setPlaying: (p) => set({ wantPlaying: p }),
  seek: (ms) => set((s) => ({ seekRequest: { ms: Math.max(0, ms), n: (s.seekRequest?.n ?? 0) + 1 } })),
  remove(key) {
    const s = get()
    const i = s.queue.findIndex((q) => q.key === key)
    if (i < 0 || i === s.index) return
    const q = s.queue.filter((x) => x.key !== key)
    set({ queue: q, index: i < s.index ? s.index - 1 : s.index })
  },
  move(from, to) {
    const s = get()
    if (from === to || from < 0 || to < 0 || from >= s.queue.length || to >= s.queue.length) return
    const q = [...s.queue]
    const [m] = q.splice(from, 1)
    q.splice(to, 0, m)
    const cur = s.queue[s.index].key
    set({ queue: q, index: q.findIndex((x) => x.key === cur) })
  },
  setUpcoming(items) {
    const s = get()
    set({ queue: [...s.queue.slice(0, s.index + 1), ...items] })
  },
  clearUpcoming: () => set((s) => ({ queue: s.queue.slice(0, s.index + 1) })),
  toggleShuffle() {
    const s = get()
    if (!s.queue.length) return set({ shuffle: !s.shuffle })
    const current = s.queue[s.index]
    if (!s.shuffle) {
      // Shuffle upcoming only (like the app): what's playing stays put.
      const upcoming = shuffled(s.queue.slice(s.index + 1))
      set({ shuffle: true, unshuffled: s.queue, queue: [...s.queue.slice(0, s.index + 1), ...upcoming] })
    } else {
      const base = s.unshuffled ?? s.queue
      const keys = new Set(s.queue.map((q) => q.key))
      const restored = base.filter((q) => keys.has(q.key))
      const extra = s.queue.filter((q) => !base.some((b) => b.key === q.key))
      const q = [...restored, ...extra]
      set({ shuffle: false, unshuffled: null, queue: q, index: Math.max(0, q.findIndex((x) => x.key === current.key)) })
    }
  },
  cycleRepeat: () => set((s) => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })),
  setVolume: (v) => set({ volume: Math.round(Math.min(100, Math.max(0, v))), muted: false }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  setRate: (r) => set({ rate: r }),
  setExpanded: (e) => set((s) => ({ expanded: e, panel: e ? s.panel : null })),
  setPanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  setSleep: (sleep) => set({ sleep }),
  replaceCurrent(t) {
    remember(t)
    const s = get()
    if (!s.queue[s.index]) return
    const q = [...s.queue]
    q[s.index] = { ...q[s.index], track: t }
    set({ queue: q })
  },
  patch: (p) => set(p),
}))

export const player = () => usePlayer.getState()
export const currentTrack = (s = usePlayer.getState()): Track | null => s.queue[s.index]?.track ?? null

// Persist the queue (like the app's playback_state) — cheap, throttled.
let persistTimer: ReturnType<typeof setTimeout> | null = null
usePlayer.subscribe((s, prev) => {
  if (s.queue === prev.queue && s.index === prev.index && s.volume === prev.volume && s.muted === prev.muted && s.repeat === prev.repeat && s.shuffle === prev.shuffle && s.mode === prev.mode) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    ls.set('arnav.player', {
      queue: s.queue.slice(0, 500).map((q) => q.track), index: s.index, volume: s.volume, muted: s.muted,
      repeat: s.repeat, shuffle: s.shuffle, mode: s.mode, context: s.context,
    })
  }, 500)
})

/** High-frequency playback position lives in its own tiny store so only progress UI re-renders. */
interface ProgressState { position: number; buffered: number; set: (p: number, b?: number) => void }
export const useProgress = create<ProgressState>()((set) => ({
  position: 0,
  buffered: 0,
  set: (position, buffered) => set(buffered == null ? { position } : { position, buffered }),
}))
