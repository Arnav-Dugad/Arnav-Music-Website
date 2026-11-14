import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { player, usePlayer, type SkipSource } from '../state/player'
import { toast } from '../state/ui'

/**
 * Undo skip: skip a song you'd been listening to for a while (20 s or more) and a toast offers to
 * take you back — same song, same moment. Quick skips through songs you don't want stay quiet.
 *
 * Every skip is counted by the control it came from, and every Undo against it: a control with a
 * high Undo rate is one people hit by accident (Settings → Usage shows the table). Undos are also
 * reported anonymously — only the control's name and how far into the song — so mis-tap spots can
 * be found and fixed. Never the song or anything about you.
 */
const MIN_LISTENED_MS = 20_000

export interface SkipCount { skips: number; late: number; undos: number }
export const useSkipStats = create<{ by: Partial<Record<SkipSource, SkipCount>>; since: number }>()(
  persist(() => ({ by: {}, since: Date.now() }), { name: 'arnav.skipStats', version: 1, storage: createJSONStorage(() => localStorage) }),
)

function bump(from: SkipSource, key: keyof SkipCount) {
  const by = { ...useSkipStats.getState().by }
  const c = { skips: 0, late: 0, undos: 0, ...by[from] }
  c[key]++
  by[from] = c
  useSkipStats.setState({ by })
}

export function resetSkipStats() { useSkipStats.setState({ by: {}, since: Date.now() }) }

function report(from: SkipSource, posMs: number) {
  try {
    if (!import.meta.env.PROD) return
    const body = JSON.stringify({ where: 'undo-skip', message: `undo after ${from} skip at ${Math.round(posMs / 1000)}s`, path: location.pathname, ua: navigator.userAgent.slice(0, 160), at: Date.now() })
    if (!navigator.sendBeacon?.('/api/log', new Blob([body], { type: 'application/json' }))) {
      void fetch('/api/log', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => undefined)
    }
  } catch { /* never throws */ }
}

let started = false
export function startSkipUndo() {
  if (started) return
  started = true
  let handled: unknown = null
  usePlayer.subscribe((s, p) => {
    const skip = s.lastSkip
    if (!skip || skip === handled || Date.now() - skip.at > 2000) return
    // Once the skip has actually moved on from that song (not "next" at the end of the queue).
    if (s.queue[s.index]?.key === skip.key || s.index === p.index) return
    handled = skip
    bump(skip.from, 'skips')
    if (skip.posMs < MIN_LISTENED_MS) return
    bump(skip.from, 'late')
    toast(`Skipped “${skip.title}”`, {
      label: 'Undo',
      run: () => {
        const q = usePlayer.getState().queue
        const i = q.findIndex((x) => x.key === skip.key)
        if (i < 0) return
        bump(skip.from, 'undos')
        report(skip.from, skip.posMs)
        player().jumpTo(i, skip.posMs)
      },
    })
  })
}
