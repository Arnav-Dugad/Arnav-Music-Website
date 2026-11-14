import { isKnownArtist } from './knownArtists'

/**
 * One set of rules for every stats page (Taste DNA, Replay, Wrapped), so they always agree.
 *
 * A play counts once you've listened 30 seconds (Spotify's rule) — or, for a very short song, when
 * it played to the end and you heard at least half of it (seeking to the end doesn't count).
 * Minutes always include everything you heard.
 */
export const PLAY_MIN_MS = 30_000
export const countsAsPlay = (e: { listenedMs: number; completed?: boolean; durationMs?: number | null }) =>
  e.listenedMs >= PLAY_MIN_MS || (!!e.completed && !!e.durationMs && e.listenedMs >= e.durationMs / 2)

/** Midnight of the local calendar day (safe across daylight-saving changes, unlike adding 24 h). */
export const dayStart = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }
/** The next local midnight after [day]. */
export const nextDay = (day: number) => { const d = new Date(day); d.setDate(d.getDate() + 1); return d.getTime() }

/**
 * The lead artist's name from a credit line for display ("Pritam, Arijit Singh" → "Pritam").
 * A duo the catalogue knows as one act ("Vishal & Shekhar") stays whole.
 */
export function leadArtist(credit: string): string {
  const first = credit.split(',')[0].replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, '').replace(/\s+-\s+topic$/i, '').trim()
  if (isKnownArtist(first)) return first
  return first.split(/\s*(?:&|×|\/)\s*/)[0].trim() || first
}
