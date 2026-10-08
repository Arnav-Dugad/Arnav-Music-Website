import { ls } from './idb'
import type { TrackId } from './types'

/**
 * Recommendation tuner — a small multiplicative-weights bandit (the web counterpart of the app's
 * self-tuning blend). Each recommendation remembers which signals picked it; finishing a song
 * strengthens those signals, an early skip weakens them. Weights stay within [0.4, 2.5].
 */
export const SIGNALS = ['artist', 'genre', 'energy', 'familiarity', 'novelty'] as const
export type Signal = (typeof SIGNALS)[number]
export type Parts = Record<Signal, number>

interface TunerState { m: Parts; plays: number; finished: number; skipped: number; updatedAt: number }

const KEY = 'arnav.tuner'
const ETA = 0.18
const fresh = (): TunerState => ({ m: { artist: 1, genre: 1, energy: 1, familiarity: 1, novelty: 1 }, plays: 0, finished: 0, skipped: 0, updatedAt: 0 })
let state: TunerState = { ...fresh(), ...ls.get<Partial<TunerState>>(KEY, {}) }
const offered = new Map<TrackId, Parts>()
const listeners = new Set<() => void>()

export const tuner = {
  multipliers: (): Parts => state.m,
  stats: () => state,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },

  /** Remembers why tracks were recommended (latest offer wins). */
  offer(items: { track: { id: TrackId }; parts?: Parts }[]) {
    for (const it of items) if (it.parts) offered.set(it.track.id, it.parts)
    while (offered.size > 600) offered.delete(offered.keys().next().value as TrackId)
  },

  /** Learns from how a recommended song was received. */
  observe(id: TrackId, completed: boolean, skipped: boolean) {
    const parts = offered.get(id)
    if (!parts) return
    offered.delete(id)
    const reward = completed ? 1 : skipped ? 0 : 0.6
    const total = SIGNALS.reduce((a, k) => a + Math.abs(parts[k]), 0) || 1
    const m = { ...state.m }
    for (const k of SIGNALS) {
      const share = Math.abs(parts[k]) / total
      m[k] = Math.min(2.5, Math.max(0.4, m[k] * Math.exp(ETA * (reward - 0.55) * share * SIGNALS.length)))
    }
    state = { m, plays: state.plays + 1, finished: state.finished + (completed ? 1 : 0), skipped: state.skipped + (skipped ? 1 : 0), updatedAt: Date.now() }
    ls.set(KEY, state)
    listeners.forEach((l) => l())
  },

  /** Takes another browser's newer weights (web sync). */
  adopt(remote: Partial<TunerState>) {
    if (!remote.m || typeof remote.updatedAt !== 'number' || remote.updatedAt <= state.updatedAt) return
    const m = { ...state.m }
    for (const k of SIGNALS) { const v = Number(remote.m[k]); if (Number.isFinite(v)) m[k] = Math.min(2.5, Math.max(0.4, v)) }
    state = { m, plays: Number(remote.plays) || state.plays, finished: Number(remote.finished) || state.finished, skipped: Number(remote.skipped) || state.skipped, updatedAt: remote.updatedAt }
    ls.set(KEY, state)
    listeners.forEach((l) => l())
  },

  reset() {
    state = fresh()
    ls.set(KEY, state)
    listeners.forEach((l) => l())
  },
}

export const SIGNAL_COPY: Record<Signal, { label: string; line: string }> = {
  artist: { label: 'Artists you love', line: 'Songs by artists you return to' },
  genre: { label: 'Your genres', line: 'Songs close to the genres you play' },
  energy: { label: 'Energy match', line: 'Songs that fit the energy of the moment' },
  familiarity: { label: 'Familiar favourites', line: 'Songs you already know' },
  novelty: { label: 'New discoveries', line: 'Songs you haven’t heard yet' },
}
