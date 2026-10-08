import { create } from 'zustand'
import { ls } from './idb'

export type QuotaState = 'NORMAL' | 'CONSERVE' | 'EXHAUSTED'
export const COSTS = { SEARCH: 100, VIDEOS_LIST: 1, PLAYLIST_ITEMS: 1, CHANNELS_LIST: 1 }

/** YouTube quota resets at midnight Pacific time. */
export function quotaDay(now = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}

export interface Ledger {
  day: string
  units: number
  remoteSearches: number
  calls: number
  cacheHits: number
  serverExhausted: boolean
  aiRequests: number
  aiCacheHits: number
  aiFallbacks: number
  firestoreReads: number
  firestoreWrites: number
  lyricsLookups: number
}

const fresh = (day: string): Ledger => ({
  day, units: 0, remoteSearches: 0, calls: 0, cacheHits: 0, serverExhausted: false,
  aiRequests: 0, aiCacheHits: 0, aiFallbacks: 0, firestoreReads: 0, firestoreWrites: 0, lyricsLookups: 0,
})

interface UsageStore extends Ledger {
  bump: (patch: Partial<Record<keyof Ledger, number | boolean>>) => void
}

function load(): Ledger {
  const l = ls.get<Ledger | null>('arnav.usage', null)
  const today = quotaDay()
  return l && l.day === today ? { ...fresh(today), ...l } : fresh(today)
}

export const useUsage = create<UsageStore>()((set, get) => ({
  ...load(),
  bump: (patch) => {
    const today = quotaDay()
    const base: Ledger = get().day === today ? get() : fresh(today)
    const next: Ledger = { ...base }
    for (const [k, v] of Object.entries(patch) as [keyof Ledger, number | boolean][]) {
      if (typeof v === 'boolean') (next[k] as boolean) = v
      else (next[k] as number) = ((base[k] as number) ?? 0) + v
    }
    const { day, units, remoteSearches, calls, cacheHits, serverExhausted, aiRequests, aiCacheHits, aiFallbacks, firestoreReads, firestoreWrites, lyricsLookups } = next
    const plain: Ledger = { day, units, remoteSearches, calls, cacheHits, serverExhausted, aiRequests, aiCacheHits, aiFallbacks, firestoreReads, firestoreWrites, lyricsLookups }
    ls.set('arnav.usage', plain)
    set(plain)
  },
}))

export function quotaState(budget: number): QuotaState {
  const u = useUsage.getState()
  if (u.day !== quotaDay()) return 'NORMAL'
  if (u.serverExhausted || u.units >= budget) return 'EXHAUSTED'
  if (u.units >= budget * 0.8) return 'CONSERVE'
  return 'NORMAL'
}

const HOUR = 3_600_000
export const cachePolicy = {
  maxAge: (s: QuotaState) => (s === 'NORMAL' ? 24 * HOUR : s === 'CONSERVE' ? 7 * 24 * HOUR : Number.MAX_SAFE_INTEGER),
  isFresh: (fetchedAt: number, s: QuotaState, now = Date.now()) => now - fetchedAt <= cachePolicy.maxAge(s),
  shouldRevalidate: (fetchedAt: number, s: QuotaState, now = Date.now()) => s === 'NORMAL' && now - fetchedAt > 6 * HOUR,
}
