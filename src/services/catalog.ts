import { passesVerified, splitVerified } from '../lib/trust'
import type { Track } from '../lib/types'
import { settings } from '../state/settings'

/** Applies the listener's "verified music only" preference (fan uploads are always dropped). */
export const verified = (tracks: Track[]): Track[] => tracks.filter((t) => passesVerified(t, settings().verifiedOnly))
export const splitByTrust = (tracks: Track[]) => splitVerified(tracks, settings().verifiedOnly)
