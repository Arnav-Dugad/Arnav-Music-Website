import { itunesAlbums, type ItunesItem } from '../lib/meta'
import { splitArtists } from '../components/TrackRow'

/**
 * New releases (albums, EPs and singles from the last few months) by the artists you follow, from
 * Apple's catalogue. Looked up at most every two days per artist; Apple allows ~20 requests a
 * minute, so the list is capped.
 */
export async function newReleases(artists: string[], days = 120): Promise<ItunesItem[]> {
  const since = Date.now() - days * 86_400_000
  const seen = new Set<number | string>()
  const out: ItunesItem[] = []
  for (const name of artists.slice(0, 10)) {
    const want = name.toLowerCase()
    const albums = await itunesAlbums(name, 20, 2 * 86_400_000).catch(() => [] as ItunesItem[])
    for (const a of albums) {
      if (!a.releaseDate || Date.parse(a.releaseDate) < since || Date.parse(a.releaseDate) > Date.now() + 86_400_000) continue
      // Their own release (credited), not a compilation that happens to match the name.
      if (!a.artist || !splitArtists(a.artist).some((n) => n.toLowerCase() === want)) continue
      const key = a.collectionId ?? `${a.album}|${a.artist}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(a)
    }
  }
  return out.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '')).slice(0, 16)
}
