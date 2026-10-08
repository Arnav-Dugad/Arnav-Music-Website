/**
 * Names every visitor's YouTube results teach the server, so titles read correctly on anyone's first
 * visit. Only trustworthy sources are learned: YouTube's auto-generated "- Topic" artist channels,
 * the album line of Topic descriptions, and iTunes soundtrack albums — never our own title guesses.
 */
import type { ApiEnv, WaitUntil } from './util'

const ARTISTS = 'known:artists:v1'
const FILMS = 'known:films:v1'
const MAX_ARTISTS = 20_000
const MAX_FILMS = 12_000

/** Same key as the client's `artistKey` (lowercase letters and digits only). */
export const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

interface Sets { artists: Set<string>; films: Set<string>; at: number }
let memory: Sets | null = null
const pending = { artists: new Set<string>(), films: new Set<string>() }
let lastFlush = 0

export async function knownSets(env: ApiEnv): Promise<Sets> {
  if (memory && Date.now() - memory.at < 5 * 60_000) return memory
  const kv = env.YT_CACHE
  const [a, f] = kv ? await Promise.all([kv.get(ARTISTS).catch(() => null), kv.get(FILMS).catch(() => null)]) : [null, null]
  memory = { artists: new Set(a ? (JSON.parse(a) as string[]) : []), films: new Set(f ? (JSON.parse(f) as string[]) : []), at: Date.now() }
  for (const x of pending.artists) memory.artists.add(x)
  for (const x of pending.films) memory.films.add(x)
  return memory
}

/** "Kabir Singh (Original Motion Picture Soundtrack)" → "Kabir Singh". */
export const filmName = (album: string) => album.replace(/\s*[([](?:original\s+)?(?:motion\s+picture\s+)?(?:soundtrack|ost|from\s+the\s+[^)\]]*)[^)\]]*[)\]]\s*$/i, '').trim()

export function learn(kind: 'artists' | 'films', raw: string) {
  // Names, not sentences: short, no years or copyright lines.
  if (raw.length > 60 || raw.trim().split(/\s+/).length > 7 || /(19|20)\d\d|℗|©|https?:/.test(raw)) return
  const k = nameKey(kind === 'films' ? filmName(raw) : raw)
  if (k.length < 3 || k.length > 60) return
  if (memory?.[kind].has(k)) return
  pending[kind].add(k)
  memory?.[kind].add(k)
}

/** Learns from a YouTube API response body (search / videos / playlistItems). */
export function learnFromYouTube(body: string) {
  let data: { items?: { snippet?: { channelTitle?: string; videoOwnerChannelTitle?: string; description?: string } }[] }
  try { data = JSON.parse(body) } catch { return }
  for (const it of data.items ?? []) {
    const sn = it.snippet
    if (!sn) continue
    for (const ch of [sn.channelTitle, sn.videoOwnerChannelTitle]) {
      if (ch && /\s-\s*Topic$/i.test(ch)) learn('artists', ch.replace(/\s*-\s*Topic$/i, ''))
    }
    // Topic description: "Provided to YouTube by …\n\nSong · Artist\n\nAlbum\n\n℗ …"
    const d = sn.description
    if (d && /^Provided to YouTube by/im.test(d)) {
      const paras = d.split(/\n\s*\n/).map((p) => p.trim())
      const ti = paras.findIndex((p) => !p.includes('\n') && p.includes(' · '))
      const album = ti >= 0 ? paras[ti + 1] : undefined
      if (album && !album.includes('\n') && !/[:：℗©]/.test(album) && album.length <= 80) learn('films', album)
      if (ti >= 0) paras[ti].split(' · ').slice(1).forEach((a) => learn('artists', a))
    }
  }
}

/** Writes newly learned names, at most once a minute per isolate (KV writes are metered). */
export function flushKnown(env: ApiEnv, waitUntil?: WaitUntil) {
  const kv = env.YT_CACHE
  if (!kv || (!pending.artists.size && !pending.films.size) || Date.now() - lastFlush < 60_000) return
  lastFlush = Date.now()
  const take = { artists: [...pending.artists], films: [...pending.films] }
  pending.artists.clear()
  pending.films.clear()
  const job = (async () => {
    for (const [kind, key, max] of [['artists', ARTISTS, MAX_ARTISTS], ['films', FILMS, MAX_FILMS]] as const) {
      const add = take[kind]
      if (!add.length) continue
      const cur = await kv.get(key).catch(() => null)
      const set = new Set<string>(cur ? (JSON.parse(cur) as string[]) : [])
      const before = set.size
      for (const x of add) set.add(x)
      if (set.size === before) continue
      const list = [...set].slice(-max)
      await kv.put(key, JSON.stringify(list)).catch(() => undefined)
    }
  })()
  if (waitUntil) waitUntil(job)
}
