/**
 * Readers for Spotify data exports (.zip / .json) and CSV playlists (Exportify or any CSV with
 * title + artist columns). Pure parsing — matching to YouTube happens in services/importer.ts.
 */

export interface ImportItem { title: string; artist: string; album?: string | null; durationMs?: number | null }
export interface ImportList { name: string; items: ImportItem[]; kind: 'playlist' | 'liked' | 'top' }

// ── Minimal ZIP reader (stored + deflate) using the browser's DecompressionStream ──
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function unzip(buf: ArrayBuffer, want: (name: string) => boolean): Promise<Map<string, string>> {
  const b = new Uint8Array(buf)
  const dv = new DataView(buf)
  const out = new Map<string, string>()
  // End of central directory: search backwards for 0x06054b50.
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('That file isn’t a ZIP archive.')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  for (let n = 0; n < count && p + 46 <= b.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOff = dv.getUint32(p + 42, true)
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    if (!want(name) || name.endsWith('/')) continue
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = b.subarray(start, start + compSize)
    const data = method === 0 ? raw : method === 8 ? await inflateRaw(raw) : null
    if (data) out.set(name, dec.decode(data))
  }
  return out
}

// ── CSV ──────────────────────────────────────────────────────────────────────
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else quoted = false }
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((x) => x.trim())) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x.trim())) rows.push(row)
  return rows
}

export function csvToList(text: string, fallbackName: string): ImportList {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('That CSV has no songs.')
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const find = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)))
  const ti = find('track name', 'song name', 'title', 'track', 'song', 'name')
  const ai = find('artist name(s)', 'artist name', 'artists', 'artist')
  const al = find('album name', 'album')
  const du = find('duration (ms)', 'duration_ms', 'duration')
  if (ti < 0 || ai < 0) throw new Error('Couldn’t find title and artist columns in that CSV.')
  const items: ImportItem[] = []
  for (const r of rows.slice(1)) {
    const title = (r[ti] ?? '').trim()
    const artist = (r[ai] ?? '').split(/\s*[;,]\s*/)[0]?.trim() ?? ''
    if (!title || !artist) continue
    const d = du >= 0 ? Number(r[du]) : NaN
    items.push({ title, artist, album: al >= 0 ? r[al]?.trim() || null : null, durationMs: Number.isFinite(d) && d > 1000 ? (d > 30_000 ? d : d * 1000) : null })
  }
  return { name: fallbackName.replace(/\.csv$/i, '') || 'Imported playlist', items, kind: 'playlist' }
}

// ── Spotify JSON ─────────────────────────────────────────────────────────────
interface SpLibrary { tracks?: { artist?: string; album?: string; track?: string }[] }
interface SpPlaylists { playlists?: { name?: string; items?: { track?: { trackName?: string; artistName?: string; albumName?: string } | null }[] }[] }
type SpHistory = { trackName?: string; artistName?: string; msPlayed?: number; master_metadata_track_name?: string; master_metadata_album_artist_name?: string; master_metadata_album_album_name?: string; ms_played?: number }[]

export function spotifyJsonToLists(name: string, text: string): ImportList[] {
  let data: unknown
  try { data = JSON.parse(text) } catch { return [] }
  const out: ImportList[] = []
  const lib = data as SpLibrary
  if (Array.isArray(lib?.tracks)) {
    const items = lib.tracks.filter((t) => t.track && t.artist).map((t) => ({ title: t.track!, artist: t.artist!, album: t.album ?? null }))
    if (items.length) out.push({ name: 'Liked Songs from Spotify', items, kind: 'liked' })
  }
  const pls = data as SpPlaylists
  if (Array.isArray(pls?.playlists)) {
    for (const p of pls.playlists) {
      const items = (p.items ?? []).map((i) => i.track).filter((t): t is NonNullable<typeof t> => !!t?.trackName && !!t?.artistName)
        .map((t) => ({ title: t.trackName!, artist: t.artistName!, album: t.albumName ?? null }))
      if (items.length) out.push({ name: p.name || 'Spotify playlist', items, kind: 'playlist' })
    }
  }
  if (Array.isArray(data) && /history/i.test(name)) {
    // Streaming history → your 50 most-played songs (history itself isn't imported).
    const ms = new Map<string, { item: ImportItem; ms: number }>()
    for (const h of data as SpHistory) {
      const title = h.trackName ?? h.master_metadata_track_name
      const artist = h.artistName ?? h.master_metadata_album_artist_name
      const played = h.msPlayed ?? h.ms_played ?? 0
      if (!title || !artist) continue
      const k = `${title.toLowerCase()}|${artist.toLowerCase()}`
      const e = ms.get(k) ?? { item: { title, artist, album: h.master_metadata_album_album_name ?? null }, ms: 0 }
      e.ms += played
      ms.set(k, e)
    }
    const items = [...ms.values()].sort((a, b) => b.ms - a.ms).slice(0, 50).map((x) => x.item)
    if (items.length) out.push({ name: 'Top 50 from Spotify', items, kind: 'top' })
  }
  return out
}

/** Reads any supported file into import lists. Streaming-history files are merged into one Top 50. */
export async function readImportFile(file: File): Promise<ImportList[]> {
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.csv') || file.type === 'text/csv') return [csvToList(await file.text(), file.name)]
  if (lower.endsWith('.json')) return spotifyJsonToLists(file.name, await file.text())
  if (lower.endsWith('.zip')) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t open ZIP files — unzip it and pick the JSON files instead.')
    const files = await unzip(await file.arrayBuffer(), (n) => /\.(json|csv)$/i.test(n) && /(yourlibrary|playlist|streaminghistory|streaming_history)/i.test(n))
    const lists: ImportList[] = []
    const history: string[] = []
    for (const [n, text] of files) {
      if (/streaming/i.test(n)) history.push(text)
      else if (n.toLowerCase().endsWith('.csv')) lists.push(csvToList(text, n.split('/').pop() ?? n))
      else lists.push(...spotifyJsonToLists(n, text))
    }
    if (history.length) {
      const merged = history.flatMap((t) => { try { const d = JSON.parse(t); return Array.isArray(d) ? d : [] } catch { return [] } })
      lists.push(...spotifyJsonToLists('StreamingHistory.json', JSON.stringify(merged)))
    }
    if (!lists.length) throw new Error('No playlists or liked songs found in that Spotify export.')
    return lists
  }
  throw new Error('Pick a Spotify export (.zip or .json) or a .csv file.')
}
