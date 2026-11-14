import { cachedSearch, search, ytQuotaState } from '../lib/youtube'
import { cleanTitle } from '../lib/lyrics'
import { artistKey, type Track } from '../lib/types'

/**
 * "Watch next": other music videos by the artist of the video you're watching. One search per
 * artist (cached like every search, and answered from this device's cache when it has one), only
 * while the YouTube quota is healthy. Topic art tracks, other artists and repeats are left out.
 */
const byArtist = new Map<string, Track[]>()
const inflight = new Map<string, Promise<Track[]>>()

export const mainArtist = (t: Track) => t.artist.split(/,|&| feat\.? | ft\.? /i)[0].trim()

export async function watchNextFor(t: Track, limit = 10): Promise<Track[]> {
  const artist = mainArtist(t)
  const key = artistKey(artist)
  const pick = (list: Track[]) => list.filter((x) => x.id !== t.id && cleanTitle(x.title).toLowerCase() !== cleanTitle(t.title).toLowerCase()).slice(0, limit)
  const known = byArtist.get(key)
  if (known) return pick(known)
  let p = inflight.get(key)
  if (!p) {
    p = (async () => {
      const q = `${artist} official music video`
      const res = (await cachedSearch(q, 'VIDEOS').catch(() => null)) ?? (ytQuotaState() === 'NORMAL' ? await search(q, 'VIDEOS').catch(() => null) : null)
      const seen = new Set<string>()
      const list = (res?.tracks ?? []).filter((x) => {
        if (x.variant === 'SONG' || /- Topic$/i.test(x.channelTitle ?? '')) return false
        if (artistKey(mainArtist(x)) !== key) return false
        const title = cleanTitle(x.title).toLowerCase()
        if (seen.has(title)) return false
        seen.add(title)
        return true
      })
      byArtist.set(key, list)
      return list
    })().finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return pick(await p)
}
