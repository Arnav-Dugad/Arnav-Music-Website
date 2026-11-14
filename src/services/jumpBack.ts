import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { player, usePlayer, useProgress } from '../state/player'
import { remember, trackRegistry } from '../state/tracks'
import { artworkFor } from '../lib/classify'
import type { Track, TrackId } from '../lib/types'

/**
 * Jump back in: what you were listening to (a playlist, an album, an AI session, a radio…), kept as
 * the queue it was — songs, the one you were on and where in it — so one tap carries on exactly
 * there. The newest ten, one per place.
 */
export interface Resume { key: string; label: string; ids: TrackId[]; index: number; posMs: number; art: string | null; at: number }

const SKIP = /^(Samples|Shared link|Preview)$/
const MAX = 10

export const useJumpBack = create<{ items: Resume[] }>()(persist(() => ({ items: [] as Resume[] }), {
  name: 'arnav.jumpBack', version: 1, storage: createJSONStorage(() => localStorage),
}))

function save(entry: Resume) {
  const rest = useJumpBack.getState().items.filter((x) => x.key !== entry.key)
  useJumpBack.setState({ items: [entry, ...rest].slice(0, MAX) })
}

/** Resumes a saved place: same songs, same song, same moment. */
export function resume(r: Resume) {
  const tracks = trackRegistry.many(r.ids)
  if (!tracks.length) return false
  const at = Math.max(0, Math.min(tracks.length - 1, tracks.findIndex((t) => t.id === r.ids[r.index]) ?? 0))
  player().play(tracks, at, { context: r.label, contextId: r.key.startsWith('ctx:') ? undefined : r.key, startMs: r.posMs > 5000 ? r.posMs : undefined })
  return true
}

let started = false
export function startJumpBack() {
  if (started) return
  started = true
  let last: { key: string; label: string } | null = null
  const snapshot = () => {
    const s = usePlayer.getState()
    const cur = s.queue[s.index]
    if (!cur || !s.context || SKIP.test(s.context)) return null
    const key = s.contextId ?? `ctx:${s.context}`
    const tracks: Track[] = s.queue.map((q) => q.track).slice(0, 200)
    remember(tracks)
    return { key, label: s.context, ids: tracks.map((t) => t.id), index: Math.min(s.index, tracks.length - 1), posMs: useProgress.getState().position, art: artworkFor(cur.track), at: Date.now() }
  }
  usePlayer.subscribe((s, p) => {
    if (s.context !== p.context || s.contextId !== p.contextId || s.index !== p.index || s.queue !== p.queue) {
      const snap = snapshot()
      if (snap) { save(snap); last = { key: snap.key, label: snap.label } }
    }
  })
  // Where in the song: kept fresh every few seconds while you listen.
  setInterval(() => {
    if (!last || !usePlayer.getState().isPlaying) return
    const items = useJumpBack.getState().items
    const i = items.findIndex((x) => x.key === last!.key)
    if (i < 0) return
    const next = [...items]
    next[i] = { ...items[i], posMs: useProgress.getState().position, at: Date.now() }
    useJumpBack.setState({ items: next })
  }, 5000)
}
