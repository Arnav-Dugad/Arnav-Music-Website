import { describe, expect, it } from 'vitest'
import { csvToList, parseCsv, spotifyJsonToLists, unzip } from '../src/lib/importFiles'
import { bestMatch } from '../src/services/importer'
import type { Track } from '../src/lib/types'

/** Builds a minimal ZIP (stored, no compression) for the reader. */
function zipStored(files: Record<string, string>): ArrayBuffer {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name)
    const d = enc.encode(text)
    const local = new Uint8Array(30 + n.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 0, true); lv.setUint32(18, d.length, true); lv.setUint32(22, d.length, true); lv.setUint16(26, n.length, true)
    local.set(n, 30)
    const cen = new Uint8Array(46 + n.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 0, true); cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true); cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true)
    cen.set(n, 46)
    parts.push(local, d)
    central.push(cen)
    offset += local.length + d.length
  }
  const cenSize = central.reduce((a, c) => a + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true); ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0))
  let p = 0
  for (const a of all) { out.set(a, p); p += a.length }
  return out.buffer
}

describe('import files', () => {
  it('parses quoted CSV and Exportify columns', () => {
    expect(parseCsv('a,"b, c","d ""q"""\n1,2,3')).toEqual([['a', 'b, c', 'd "q"'], ['1', '2', '3']])
    const l = csvToList('"Track Name","Artist Name(s)","Album Name","Duration (ms)"\n"Kesariya","Arijit Singh, Pritam","Brahmastra","268000"\n', 'My mix.csv')
    expect(l.name).toBe('My mix')
    expect(l.items).toEqual([{ title: 'Kesariya', artist: 'Arijit Singh', album: 'Brahmastra', durationMs: 268000 }])
    expect(() => csvToList('foo,bar\n1,2', 'x.csv')).toThrow()
  })
  it('reads Spotify library, playlists and streaming history', () => {
    const lib = spotifyJsonToLists('YourLibrary.json', JSON.stringify({ tracks: [{ artist: 'The Weeknd', album: 'After Hours', track: 'Blinding Lights' }] }))
    expect(lib[0]).toMatchObject({ kind: 'liked', items: [{ title: 'Blinding Lights', artist: 'The Weeknd' }] })
    const pl = spotifyJsonToLists('Playlist1.json', JSON.stringify({ playlists: [{ name: 'Drive', items: [{ track: { trackName: 'Starboy', artistName: 'The Weeknd', albumName: 'Starboy' } }, { track: null }] }] }))
    expect(pl).toEqual([{ name: 'Drive', kind: 'playlist', items: [{ title: 'Starboy', artist: 'The Weeknd', album: 'Starboy' }] }])
    const hist = spotifyJsonToLists('StreamingHistory_music_0.json', JSON.stringify([
      { trackName: 'A', artistName: 'X', msPlayed: 1000 }, { trackName: 'B', artistName: 'Y', msPlayed: 5000 }, { trackName: 'A', artistName: 'X', msPlayed: 9000 },
    ]))
    expect(hist[0].kind).toBe('top')
    expect(hist[0].items.map((i) => i.title)).toEqual(['A', 'B'])
  })
  it('unzips a Spotify export', async () => {
    const files = await unzip(zipStored({ 'Spotify Account Data/YourLibrary.json': '{"tracks":[]}', 'readme.txt': 'x' }), (n) => n.endsWith('.json'))
    expect([...files.keys()]).toEqual(['Spotify Account Data/YourLibrary.json'])
    expect(files.get('Spotify Account Data/YourLibrary.json')).toBe('{"tracks":[]}')
  })
})

describe('import matching', () => {
  const t = (id: string, title: string, artist: string, extra: Partial<Track> = {}): Track => ({ id: `yt:${id}`, title, artist, playbackRef: id, genres: [], durationMs: 200_000, ...extra })
  it('prefers the official upload of the same song', () => {
    const pool = [
      t('fan00000001', 'Blinding Lights', 'Someone', { trust: -1 }),
      t('vid00000002', 'Blinding Lights', 'The Weeknd', { trust: 2, variant: 'VIDEO' }),
      t('top00000003', 'Blinding Lights', 'The Weeknd', { trust: 3, variant: 'SONG' }),
      t('oth00000004', 'Save Your Tears', 'The Weeknd', { trust: 3 }),
    ]
    expect(bestMatch({ title: 'Blinding Lights', artist: 'The Weeknd' }, pool)?.playbackRef).toBe('top00000003')
    expect(bestMatch({ title: 'Kesariya', artist: 'Arijit Singh' }, pool)).toBeNull()
    expect(bestMatch({ title: 'Blinding Lights', artist: 'The Weeknd', durationMs: 400_000 }, pool)).toBeNull()
  })
})
