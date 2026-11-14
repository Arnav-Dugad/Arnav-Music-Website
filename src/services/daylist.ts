import { forYouNow, freshFinds } from './recs'
import { lib, liveEvents } from '../state/library'
import { trackRegistry } from '../state/tracks'
import { countsAsPlay } from '../lib/metrics'
import type { Track } from '../lib/types'

/**
 * Daylist: a playlist for this part of the day, named after what you actually play at this time
 * ("Friday late night punjabi chill"). It changes with the time of day and stays the same within
 * one stretch, so the link works until the next one starts.
 */
export interface Daylist { title: string; subtitle: string; slot: Slot; tracks: Track[]; hues: [number, number]; until: number }
type Slot = 'early morning' | 'morning' | 'afternoon' | 'evening' | 'night' | 'late night'

const SLOTS: { slot: Slot; from: number; to: number; hues: [number, number] }[] = [
  { slot: 'late night', from: 1, to: 5, hues: [256, 222] },
  { slot: 'early morning', from: 5, to: 9, hues: [32, 190] },
  { slot: 'morning', from: 9, to: 12, hues: [48, 168] },
  { slot: 'afternoon', from: 12, to: 17, hues: [14, 330] },
  { slot: 'evening', from: 17, to: 21, hues: [300, 22] },
  { slot: 'night', from: 21, to: 25, hues: [232, 280] },
]
const slotOf = (h: number) => SLOTS.find((s) => (h >= s.from && h < s.to) || (h + 24 >= s.from && h + 24 < s.to)) ?? SLOTS[5]
const inSlot = (h: number, s: (typeof SLOTS)[number]) => (h >= s.from && h < s.to) || (h + 24 >= s.from && h + 24 < s.to)

/** Small deterministic shuffle (same order all through one stretch of the day). */
function seeded<T>(xs: T[], seed: number): T[] {
  const a = [...xs]
  let s = seed || 1
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

const SCENE_WORDS: [RegExp, string][] = [
  [/punjabi/i, 'punjabi'], [/bollywood|hindi|filmi/i, 'bollywood'], [/k-?pop|korean/i, 'k-pop'], [/latin|reggaeton/i, 'latin'],
  [/hip.?hop|rap/i, 'hip-hop'], [/r&b|rnb|soul/i, 'r&b'], [/lo-?fi/i, 'lo-fi'], [/edm|electronic|house|techno/i, 'electronic'],
  [/rock|metal/i, 'rock'], [/indie/i, 'indie'], [/pop/i, 'pop'], [/acoustic|folk/i, 'acoustic'], [/jazz/i, 'jazz'], [/classical/i, 'classical'],
]

export function buildDaylist(now = new Date()): Daylist | null {
  const s = slotOf(now.getHours())
  const day = now.toLocaleDateString([], { weekday: 'long' })
  // What you play in this stretch of the day (the last eight weeks).
  const since = now.getTime() - 56 * 86_400_000
  const plays = new Map<string, number>()
  for (const e of liveEvents(lib().events)) {
    if (e.startedAt < since || !countsAsPlay(e) || !inSlot(new Date(e.startedAt).getHours(), s)) continue
    plays.set(e.trackId, (plays.get(e.trackId) ?? 0) + 1)
  }
  const yours = trackRegistry.many([...plays.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)).slice(0, 40)
  // Named after it: the scene you lean to now, and how it feels.
  const words = new Map<string, number>()
  for (const t of yours) for (const g of t.genres ?? []) for (const [re, w] of SCENE_WORDS) if (re.test(g)) { words.set(w, (words.get(w) ?? 0) + (plays.get(t.id) ?? 1)); break }
  const scene = [...words.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const energies = yours.map((t) => t.energy).filter((x): x is number => typeof x === 'number')
  const avg = energies.length ? energies.reduce((a, b) => a + b, 0) / energies.length : s.slot === 'late night' || s.slot === 'night' ? 0.35 : 0.55
  const feel = avg < 0.4 ? 'chill' : avg < 0.62 ? 'easy' : 'hype'
  const title = [day, s.slot, scene, feel].filter(Boolean).join(' ').toLowerCase()
  // Mostly what you love at this hour, with a few new ones that fit it.
  const fresh = [...forYouNow(24), ...freshFinds(12)].map((r) => r.track)
  const seed = Number(`${now.getFullYear()}${now.getMonth()}${now.getDate()}${SLOTS.indexOf(s)}`)
  const picks = new Map<string, Track>()
  for (const t of seeded(yours.slice(0, 26), seed)) picks.set(t.id, t)
  for (const t of seeded(fresh, seed + 1)) { if (picks.size >= 30) break; if (!picks.has(t.id)) picks.set(t.id, t) }
  const tracks = seeded([...picks.values()], seed + 2)
  if (tracks.length < 8) return null
  const end = new Date(now)
  end.setHours(s.to % 24, 0, 0, 0)
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1)
  return { title, subtitle: yours.length >= 8 ? `What you play on ${day} ${s.slot}s, with a few new ones` : `Picked for ${s.slot}, from your taste`, slot: s.slot, tracks, hues: s.hues, until: end.getTime() }
}
