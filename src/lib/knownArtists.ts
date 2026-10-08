import { artistKey } from './types'
import { ls } from './idb'

/**
 * Names known to be artists — learned from YouTube "- Topic" channels (auto-generated, official),
 * artists' own channels and your onboarding picks. Used to read label titles
 * ("Asees Kaur - Baarish" is Artist - Song; "Makhna - Drive" is Song - Film).
 */
const KEY = 'arnav.knownArtists.v3'
try { localStorage.removeItem('arnav.knownArtists'); localStorage.removeItem('arnav.knownArtists.v2') } catch { /* storage blocked */ }
const known = new Set<string>(ls.get<string[]>(KEY, []))
let saveTimer: ReturnType<typeof setTimeout> | null = null

export function addKnownArtist(name: string | null | undefined) {
  if (!name) return
  const k = artistKey(name)
  if (k.length < 3 || known.has(k)) return
  known.add(k)
  if (known.size > 5000) known.delete(known.values().next().value as string)
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => ls.set(KEY, [...known]), 1500)
}

export const isKnownArtist = (name: string) => {
  const k = artistKey(name)
  return k.length >= 3 && known.has(k)
}
