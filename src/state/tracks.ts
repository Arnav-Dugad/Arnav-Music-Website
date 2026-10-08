import { idbGet, idbSet } from '../lib/idb'
import type { Track, TrackId } from '../lib/types'

/**
 * Registry of every track the app has seen (search results, library, history). Persisted to
 * IndexedDB so library rows, history and recommendations render offline.
 */
const map = new Map<TrackId, Track>()
const listeners = new Set<() => void>()
let version = 0
let saveTimer: ReturnType<typeof setTimeout> | null = null
const MAX = 6000

export const trackRegistry = {
  get: (id: TrackId) => map.get(id),
  has: (id: TrackId) => map.has(id),
  all: () => [...map.values()],
  many: (ids: TrackId[]) => ids.map((id) => map.get(id)).filter((t): t is Track => !!t),
  version: () => version,
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
}

export function remember(tracks: Track[] | Track | undefined | null) {
  if (!tracks) return
  const list = Array.isArray(tracks) ? tracks : [tracks]
  let changed = false
  for (const t of list) {
    if (!t?.id || !t.title) continue
    const prev = map.get(t.id)
    // Keep richer metadata when a sparse copy (e.g. from cloud history) arrives later.
    const merged: Track = prev
      ? ({ ...prev, ...Object.fromEntries(Object.entries(t).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0))) } as Track)
      : { ...t, genres: t.genres ?? [] }
    map.delete(t.id)
    map.set(t.id, merged)
    changed = true
  }
  if (!changed) return
  while (map.size > MAX) {
    const first = map.keys().next().value
    if (first === undefined) break
    map.delete(first)
  }
  version++
  listeners.forEach((l) => l())
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void idbSet('tracks', [...map.values()]) }, 800)
}

export async function loadTracks() {
  const saved = await idbGet<Track[]>('tracks')
  if (saved?.length) {
    for (const t of saved) if (!map.has(t.id)) map.set(t.id, { ...t, genres: t.genres ?? [] })
    version++
    listeners.forEach((l) => l())
  }
}
