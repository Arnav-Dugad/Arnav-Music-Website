/**
 * Brings in the parts of your phone's library that the app doesn't sync live, from the app's own
 * cloud backups (users/{uid}/backups + vaultChunks: a gzip'd JSON archive of its database):
 * listening history from before sync, recent searches, "not interested" / blocked artists and the
 * lyrics you saved, pasted, re-timed or had Arnav AI write on the phone. Read-only — nothing on the
 * phone or in the backup changes; merges never duplicate.
 */
import { collection, doc, getDoc, getDocs, limit, orderBy, query } from 'firebase/firestore'
import { firestore } from '../lib/firebase'
import { idbGet, idbSet } from '../lib/idb'
import { artistKey, type Track } from '../lib/types'
import { lib, useLibrary, type LocalEvent } from '../state/library'
import { remember, trackRegistry } from '../state/tracks'

export interface PhoneBackup { id: string; device: string; createdAt: number; bytes: number; counts: Record<string, number>; chunkIds: string[]; hash: string }
export interface ImportResult { history: number; searches: number; hidden: number; blocked: number; lyrics: number }

interface ArchiveValue { type: string; value?: string }
interface ArchiveTable { name: string; columns: string[]; rows: ArchiveValue[][] }
interface UserArchive { schema: number; roomVersion: number; tables: ArchiveTable[]; preferences?: Record<string, Record<string, ArchiveValue>> }

export async function latestPhoneBackup(uid: string): Promise<PhoneBackup | null> {
  const snap = await getDocs(query(collection(firestore(), 'users', uid, 'backups'), orderBy('publishedAt', 'desc'), limit(1)))
  const d = snap.docs[0]
  if (!d) return null
  const x = d.data()
  return {
    id: d.id,
    device: String(x.deviceLabel ?? 'Android phone'),
    createdAt: Number(x.createdAt ?? 0),
    bytes: Number(x.bytes ?? 0),
    counts: (x.counts ?? {}) as Record<string, number>,
    chunkIds: Array.isArray(x.chunkIds) ? (x.chunkIds as string[]) : [],
    hash: String(x.hash ?? ''),
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function download(uid: string, b: PhoneBackup, onProgress: (p: number) => void): Promise<UserArchive> {
  if (!b.chunkIds.length || b.chunkIds.length > 256 || b.bytes > 64 * 1024 * 1024) throw new Error('This backup is too large to open here')
  const parts: Uint8Array[] = []
  for (let i = 0; i < b.chunkIds.length; i++) {
    const id = b.chunkIds[i]
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Backup damaged')
    const snap = await getDoc(doc(firestore(), 'users', uid, 'vaultChunks', id))
    const payload = snap.data()?.payload
    if (typeof payload !== 'string') throw new Error('A part of the backup is missing')
    const bin = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    if ((await sha256Hex(bin)) !== id) throw new Error('Backup integrity check failed')
    parts.push(bin)
    onProgress((i + 1) / (b.chunkIds.length + 1))
  }
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) { all.set(p, o); o += p.length }
  if (b.hash && (await sha256Hex(all)) !== b.hash) throw new Error('Backup integrity check failed')
  const stream = new Blob([all as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  const text = await new Response(stream).text()
  const archive = JSON.parse(text) as UserArchive
  if (archive.schema !== 1) throw new Error('This backup needs a newer website')
  return archive
}

function rows(a: UserArchive, table: string): Record<string, string | null>[] {
  const t = a.tables.find((x) => x.name === table)
  if (!t) return []
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]?.type === 'null' ? null : r[i]?.value ?? null])))
}

export async function importPhoneBackup(uid: string, b: PhoneBackup, onProgress: (p: number) => void = () => {}): Promise<ImportResult> {
  const a = await download(uid, b, onProgress)
  const result: ImportResult = { history: 0, searches: 0, hidden: 0, blocked: 0, lyrics: 0 }

  // Song details, so imported history shows titles.
  const tracks: Track[] = []
  for (const r of rows(a, 'tracks')) {
    const id = r.id ?? ''
    if (!id.startsWith('yt:') || trackRegistry.has(id)) continue
    tracks.push({ id, title: r.title ?? '', artist: r.artist ?? '', album: r.album, durationMs: r.durationMs ? Number(r.durationMs) : null, playbackRef: r.playbackRef || id.slice(3), artworkUrl: r.artworkUrl || `https://i.ytimg.com/vi/${id.slice(3)}/hqdefault.jpg`, genres: (r.genres ?? '').split('|').filter(Boolean), energy: r.energy ? Number(r.energy) : undefined, year: r.year ? Number(r.year) : null, channelId: r.channelId, credits: r.credits } as Track)
  }
  if (tracks.length) remember(tracks)

  // Listening history from before cloud sync (YouTube songs; never duplicates what's here).
  const have = new Set(lib().events.map((e) => `${e.trackId}|${Math.round(e.startedAt / 1000)}`))
  const add: LocalEvent[] = []
  for (const r of rows(a, 'play_events')) {
    const trackId = r.trackId ?? ''
    const startedAt = Number(r.startedAt)
    if (!trackId.startsWith('yt:') || !Number.isFinite(startedAt) || have.has(`${trackId}|${Math.round(startedAt / 1000)}`)) continue
    have.add(`${trackId}|${Math.round(startedAt / 1000)}`)
    add.push({
      trackId, artistKey: r.artistKey || artistKey(trackRegistry.get(trackId)?.artist ?? ''), startedAt, listenedMs: Number(r.listenedMs) || 0,
      durationMs: r.durationMs ? Number(r.durationMs) : null, completed: r.completed === '1' || r.completed === 'true', skipped: r.skipped === '1' || r.skipped === 'true',
      source: 'YOUTUBE', localId: `p${r.id ?? startedAt}`, dirty: false, device: 'phone-backup',
    })
  }
  result.history = add.length

  // Recent searches, feedback.
  const searches = rows(a, 'recent_searches').sort((x, y) => Number(y.searchedAt) - Number(x.searchedAt)).map((r) => r.display ?? '').filter(Boolean)
  const cur = lib()
  const recentSearches = [...new Set([...cur.recentSearches, ...searches])].slice(0, 30)
  result.searches = recentSearches.length - cur.recentSearches.length
  const fb = rows(a, 'rec_feedback')
  const notInterested = [...new Set([...cur.notInterested, ...fb.filter((r) => r.kind === 'track_not_interested').map((r) => r.subject ?? '').filter((s) => s.startsWith('yt:'))])]
  const blockedArtists = [...new Set([...cur.blockedArtists, ...fb.filter((r) => r.kind === 'artist_blocked').map((r) => r.subject ?? '').filter(Boolean)])]
  result.hidden = notInterested.length - cur.notInterested.length
  result.blocked = blockedArtists.length - cur.blockedArtists.length
  useLibrary.getState().applyRemote({
    events: [...cur.events, ...add].sort((x, y) => x.startedAt - y.startedAt),
    recentSearches, notInterested, blockedArtists,
  })

  // Lyrics you curated on the phone (pasted, AI-written, or LRCLIB lyrics you re-timed there).
  for (const r of rows(a, 'lyrics')) {
    const id = r.trackId ?? ''
    if (!id.startsWith('yt:') || !r.text || r.source === 'removed' || r.source === 'embedded' || r.source === 'file') continue
    const existing = await idbGet<{ raw: string }>(`lyr-own|${id}`, 'cache')
    if (existing) continue
    const source = r.source === 'ai' ? 'Arnav AI' : r.source === 'pasted' ? 'You' : 'Your phone'
    await idbSet(`lyr-own|${id}`, { raw: r.text, source }, 'cache')
    result.lyrics++
  }
  onProgress(1)
  return result
}
