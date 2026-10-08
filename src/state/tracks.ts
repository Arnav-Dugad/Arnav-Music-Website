import { idbGet, idbSet } from '../lib/idb'
import type { Track, TrackId } from '../lib/types'
import { addKnownArtist } from '../lib/knownArtists'
import { reparse } from '../lib/classify'
import { channelArtist } from '../lib/trust'

function learn(t: Track) {
  // Only an artist's own channel confirms a name: a label upload's artist is our reading of its
  // title, and learning from it would let one misread ("Kabir Singh" the film) teach the next.
  if (t.trust === 2) addKnownArtist(channelArtist(t))
}

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
    // A fresh copy from the YouTube API (it carries parseV) replaces parsed fields outright, so a
    // corrected parse can clear an old wrong album; sparse copies (cloud history) only fill gaps.
    const merged: Track = prev
      ? (t.parseV != null
        ? { ...prev, ...t, genres: t.genres ?? prev.genres ?? [] }
        : ({ ...prev, ...Object.fromEntries(Object.entries(t).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0))) } as Track))
      : { ...t, genres: t.genres ?? [] }
    map.delete(t.id)
    map.set(t.id, merged)
    learn(merged)
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

/**
 * Drops cached tracks that can't be re-read with today's parser (saved before the original title
 * was kept) unless something in the library still points at them. They are only a cache.
 */
export function pruneRegistry(referenced: Set<TrackId>) {
  let dropped = 0
  for (const [id, t] of map) {
    if (!t.rawTitle && !referenced.has(id)) { map.delete(id); dropped++ }
  }
  if (dropped) {
    version++
    listeners.forEach((l) => l())
    void idbSet('tracks', [...map.values()])
  }
  return dropped
}

export async function loadTracks() {
  const saved = await idbGet<Track[]>('tracks')
  if (saved?.length) {
    for (const s of saved) {
      if (map.has(s.id)) continue
      const t = reparse({ ...s, genres: s.genres ?? [] })
      map.set(t.id, t)
      learn(t)
    }
    version++
    listeners.forEach((l) => l())
  }
}
