import { SMART, smartPlaylist, type SmartKind } from '../lib/taste'
import { dailyMixes } from './recs'
import { likedIds, lib, liveEvents } from '../state/library'
import { trackRegistry } from '../state/tracks'
import type { Track } from '../lib/types'

/**
 * The songs a smart playlist ("smart:<kind>") or Daily mix ("daily:<id>") has right now — what a
 * mix pinned to YouTube Music refreshes to. Null when it can't be made any more (a Daily mix that
 * rotated away keeps its last songs).
 */
export function resolveMix(source: string): { title: string; tracks: Track[] } | null {
  if (source.startsWith('smart:')) {
    const k = source.slice(6) as SmartKind
    if (!SMART[k]) return null
    const s = lib()
    return { title: SMART[k].title, tracks: trackRegistry.many(smartPlaylist(k, liveEvents(s.events), likedIds(s.likes))) }
  }
  if (source.startsWith('daily:')) {
    const d = dailyMixes().find((m) => m.id === `daily_${source.slice(6)}`)
    return d ? { title: d.title, tracks: d.tracks } : null
  }
  return null
}
