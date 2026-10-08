import { artistKey } from './types'
import { ls } from './idb'

/**
 * Names known to be artists — learned from YouTube "- Topic" channels (auto-generated, official),
 * artists' own channels and your onboarding picks — and names known to be films/albums (Topic
 * album lines, iTunes soundtracks, Wikidata). The server shares what every visitor's results taught
 * it (/api/known), so label titles read right on a first visit. Used to read titles like
 * "Asees Kaur - Baarish" (Artist - Song) vs "Makhna - Drive" (Song - Film).
 */
const KEY = 'arnav.knownArtists.v3'
const FILMS_KEY = 'arnav.knownFilms.v1'
try { localStorage.removeItem('arnav.knownArtists'); localStorage.removeItem('arnav.knownArtists.v2') } catch { /* storage blocked */ }
const known = new Set<string>(ls.get<string[]>(KEY, []))
const films = new Set<string>(ls.get<string[]>(FILMS_KEY, []))
/** Server-learned names are kept in memory only (refreshed every few hours). */
const shared = { artists: new Set<string>(), films: new Set<string>() }
let saveTimer: ReturnType<typeof setTimeout> | null = null

const filmKey = (name: string) => name.toLowerCase().replace(/\s*[([](?:original\s+)?(?:motion\s+picture\s+)?(?:soundtrack|ost)[^)\]]*[)\]]\s*$/i, '').replace(/[^\p{L}\p{N}]/gu, '')

function save() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { ls.set(KEY, [...known]); ls.set(FILMS_KEY, [...films]) }, 1500)
}

export function addKnownArtist(name: string | null | undefined) {
  if (!name) return
  const k = artistKey(name)
  if (k.length < 3 || known.has(k)) return
  known.add(k)
  if (known.size > 5000) known.delete(known.values().next().value as string)
  save()
}

export function addKnownFilm(name: string | null | undefined) {
  if (!name) return
  const k = filmKey(name)
  if (k.length < 3 || films.has(k)) return
  films.add(k)
  if (films.size > 3000) films.delete(films.values().next().value as string)
  save()
}

export const isKnownArtist = (name: string) => {
  const k = artistKey(name)
  return k.length >= 3 && (known.has(k) || shared.artists.has(k)) && !isKnownFilm(name)
}

export const isKnownFilm = (name: string) => {
  const k = filmKey(name)
  return k.length >= 3 && (films.has(k) || shared.films.has(k))
}

export function mergeSharedNames(r: { artists: string[]; films: string[] }) {
  for (const a of r.artists) shared.artists.add(a)
  for (const f of r.films) shared.films.add(f)
}
