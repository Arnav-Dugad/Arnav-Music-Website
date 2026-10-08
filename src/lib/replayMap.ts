/**
 * Replay map: for each song, which parts you actually hear, where you skip away and which
 * stretches you rewind to hear again. Recorded by the player as you listen; kept on this device.
 */
import { idbGet, idbSet } from './idb'

export const BINS = 48
export interface ReplayMap {
  /** Milliseconds heard per slice of the song. */
  heard: number[]
  /** Times you skipped away from each slice. */
  skips: number[]
  /** Rewinds: from where back to where (slice indexes), most recent last. */
  rewinds: { from: number; to: number; at: number }[]
  plays: number
  updatedAt: number
}

const fresh = (): ReplayMap => ({ heard: new Array(BINS).fill(0), skips: new Array(BINS).fill(0), rewinds: [], plays: 0, updatedAt: 0 })
const cache = new Map<string, ReplayMap>()
const loading = new Map<string, Promise<ReplayMap>>()
const dirty = new Set<string>()
const key = (id: string) => `rp|v1|${id}`
const bin = (posMs: number, durMs: number) => Math.min(BINS - 1, Math.max(0, Math.floor((posMs / durMs) * BINS)))

export function loadReplay(id: string): Promise<ReplayMap> {
  const hit = cache.get(id)
  if (hit) return Promise.resolve(hit)
  const p = loading.get(id) ?? idbGet<ReplayMap>(key(id), 'cache').then((m) => {
    const map = m && Array.isArray(m.heard) && m.heard.length === BINS ? m : fresh()
    if (!cache.has(id)) cache.set(id, map)
    loading.delete(id)
    return cache.get(id)!
  })
  loading.set(id, p)
  return p
}

function edit(id: string, fn: (m: ReplayMap) => void) {
  const m = cache.get(id)
  if (!m) { void loadReplay(id).then(() => edit(id, fn)); return }
  fn(m)
  m.updatedAt = Date.now()
  dirty.add(id)
}

export const recordPlay = (id: string) => edit(id, (m) => { m.plays++ })
export function recordHeard(id: string, posMs: number, durMs: number, dtMs: number) {
  if (durMs <= 0 || dtMs <= 0) return
  edit(id, (m) => { m.heard[bin(posMs, durMs)] += dtMs })
}
export function recordSkip(id: string, posMs: number, durMs: number) {
  if (durMs <= 0 || posMs >= durMs * 0.97) return
  edit(id, (m) => { m.skips[bin(posMs, durMs)]++ })
}
export function recordRewind(id: string, fromMs: number, toMs: number, durMs: number) {
  if (durMs <= 0 || fromMs - toMs < 3000) return
  edit(id, (m) => { m.rewinds = [...m.rewinds, { from: bin(fromMs, durMs), to: bin(toMs, durMs), at: Date.now() }].slice(-40) })
}

setInterval(() => {
  for (const id of dirty) { const m = cache.get(id); if (m) void idbSet(key(id), m, 'cache') }
  dirty.clear()
}, 8000)
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { for (const id of dirty) { const m = cache.get(id); if (m) void idbSet(key(id), m, 'cache') } })

export interface ReplayInsight { skipAt: number | null; skipCount: number; replayFrom: number | null; replayTo: number | null; replayCount: number; favorite: number | null }

/** Plain findings (ms): where you usually skip, the stretch you rewind to, your most-heard moment. */
export function replayInsight(m: ReplayMap, durMs: number): ReplayInsight {
  const at = (b: number) => Math.round(((b + 0.5) / BINS) * durMs)
  const maxSkip = Math.max(...m.skips)
  const skipBin = maxSkip >= 2 ? m.skips.indexOf(maxSkip) : -1
  const targets = new Map<number, { n: number; from: number }>()
  for (const r of m.rewinds) { const t = targets.get(r.to) ?? { n: 0, from: r.from }; t.n++; t.from = Math.max(t.from, r.from); targets.set(r.to, t) }
  const top = [...targets.entries()].sort((a, b) => b[1].n - a[1].n)[0]
  const avg = m.heard.reduce((a, b) => a + b, 0) / BINS
  const fav = Math.max(...m.heard)
  return {
    skipAt: skipBin >= 0 ? at(skipBin) : null,
    skipCount: maxSkip,
    replayFrom: top && top[1].n >= 2 ? at(top[0]) : null,
    replayTo: top && top[1].n >= 2 ? at(top[1].from) : null,
    replayCount: top?.[1].n ?? 0,
    favorite: fav > avg * 1.35 && fav > 20_000 ? at(m.heard.indexOf(fav)) : null,
  }
}
