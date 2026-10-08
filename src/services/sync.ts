import { create } from 'zustand'
import {
  Timestamp, collection, deleteDoc, doc, getDocs, getDocsFromServer, limit, onSnapshot, orderBy, query, runTransaction,
  serverTimestamp, setDoc, startAfter, where, writeBatch, type DocumentData, type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { firestore, watchAuth } from '../lib/firebase'
import { idbGet, idbSet, ls } from '../lib/idb'
import { useUsage } from '../lib/usage'
import { artistKey, nativeId, sourceOf, type Track, type TrackId } from '../lib/types'
import { lib, useLibrary, type LocalEvent, type SyncedLike, type SyncedPlaylist } from '../state/library'
import { remember, trackRegistry } from '../state/tracks'
import { useAuth } from '../state/auth'
import { settings, useSettings } from '../state/settings'
import { player, usePlayer } from '../state/player'

export type SyncStatus = 'DISABLED' | 'IDLE' | 'SYNCING' | 'OFFLINE' | 'ERROR' | 'UP_TO_DATE' | 'ACCOUNT_BLOCKED'

export interface RemoteQueue { tracks: Track[]; index: number; updatedAt: number; fromThisDevice: boolean }

interface SyncState {
  status: SyncStatus
  error: string | null
  lastSyncedAt: number
  remoteQueue: RemoteQueue | null
  pulled: { likes: number; playlists: number; history: number }
}

export const useSync = create<SyncState>()(() => ({
  status: 'IDLE',
  error: null,
  lastSyncedAt: 0,
  remoteQueue: null,
  pulled: { likes: 0, playlists: 0, history: 0 },
}))

/** Stable per-browser device id (UUID — the format Firestore rules require). */
export const deviceId: string = (() => {
  let id = ls.get<string | null>('arnav.deviceId', null)
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    id = crypto.randomUUID?.() ?? '00000000-0000-4000-8000-000000000000'.replace(/0/g, () => Math.floor(Math.random() * 16).toString(16))
    ls.set('arnav.deviceId', id)
  }
  return id
})()

const reads = (n: number) => useUsage.getState().bump({ firestoreReads: Math.max(1, n) })
const writes = (n: number) => useUsage.getState().bump({ firestoreWrites: n })

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Track maps: identical to the Android app's trackToMap / trackFromMap ─────
function trackToMap(t: Track) {
  return {
    id: t.id, title: t.title.slice(0, 200), artist: t.artist.slice(0, 200), album: t.album?.slice(0, 200) ?? null,
    durationMs: t.durationMs != null ? Math.round(t.durationMs) : null, artworkUrl: t.artworkUrl?.slice(0, 500) ?? null,
    playbackRef: t.playbackRef.slice(0, 200), channelId: t.channelId?.slice(0, 64) ?? null, genres: (t.genres ?? []).join('|').slice(0, 200),
  }
}
function trackFromMap(id: string, m: Record<string, unknown> | null | undefined): Track | null {
  if (!m) return null
  const title = typeof m.title === 'string' ? m.title : null
  const artist = typeof m.artist === 'string' ? m.artist : null
  const ref = typeof m.playbackRef === 'string' ? m.playbackRef : null
  if (!title || !artist || !ref) return null
  const genres = typeof m.genres === 'string' && m.genres ? m.genres.split('|') : []
  return {
    id, title, artist, album: (m.album as string) ?? null, durationMs: typeof m.durationMs === 'number' ? m.durationMs : null,
    artworkUrl: (m.artworkUrl as string) ?? (sourceOf(id) === 'YOUTUBE' ? `https://i.ytimg.com/vi/${ref}/hqdefault.jpg` : null),
    playbackRef: ref, channelId: (m.channelId as string) ?? null, genres,
  }
}
/** Kotlin `Track` JSON (kotlinx.serialization, encodeDefaults) for the shared queue record. */
function kotlinTrack(t: Track) {
  return {
    id: t.id, title: t.title, artist: t.artist, album: t.album ?? null, durationMs: t.durationMs != null ? Math.round(t.durationMs) : null,
    artworkUrl: t.artworkUrl ?? null, playbackRef: t.playbackRef, channelId: t.channelId ?? null, genres: t.genres ?? [],
    energy: t.energy ?? null, year: t.year ?? null, variant: t.variant ?? null, credits: t.credits ?? null, compilation: !!t.compilation,
    trackNumber: null, discNumber: null, albumId: null, albumArtist: null,
  }
}
function fromKotlinTrack(o: Record<string, unknown>): Track | null {
  const id = typeof o.id === 'string' ? o.id : null
  if (!id || sourceOf(id) !== 'YOUTUBE') return null
  const t = trackFromMap(id, { ...o, genres: Array.isArray(o.genres) ? (o.genres as string[]).join('|') : '' })
  if (!t) return null
  return { ...t, energy: typeof o.energy === 'number' ? o.energy : null, year: typeof o.year === 'number' ? o.year : null, variant: o.variant === 'SONG' || o.variant === 'VIDEO' ? o.variant : null, credits: (o.credits as string) ?? null, compilation: !!o.compilation }
}

// ── Account binding: never merge two accounts' data on one browser ───────────
function owner(): string | null { return ls.get<string | null>('arnav.dataOwner', null) }
function hasLocalData() {
  const s = lib()
  return Object.keys(s.likes).length > 0 || Object.keys(s.playlists).length > 0 || s.events.length > 0
}
export async function adoptAccount(uid: string) {
  // Clears this browser's library so another account's data can't leak into it.
  useLibrary.getState().applyRemote({ likes: {}, playlists: {}, events: [], notInterested: [], blockedArtists: [] })
  ls.set('arnav.dataOwner', uid)
  for (const k of [`likes_pulled_${uid}`, `pl_pulled_${uid}`, `live_cursor_${uid}`]) ls.del(k)
  await idbSet(`journal_${uid}`, {})
  useSync.setState({ status: 'IDLE', error: null })
  void syncNow()
}

// ── Likes ─────────────────────────────────────────────────────────────────────
async function syncLikes(uid: string) {
  const db = firestore()
  const col = collection(db, 'users', uid, 'likes')
  const since = ls.get<number>(`likes_pulled_${uid}`, 0)
  const snap = await getDocsFromServer(query(col, where('updatedAt', '>', since)))
  reads(snap.size)
  const likes = { ...lib().likes }
  let maxRemote = since
  let applied = 0
  snap.forEach((d) => {
    const data = d.data()
    const updatedAt = Number(data.updatedAt ?? 0)
    maxRemote = Math.max(maxRemote, updatedAt)
    const local = likes[d.id]
    if (local && local.updatedAt >= updatedAt) return // local is newer (or equal) — wins / no-op
    const t = trackFromMap(d.id, data.track as Record<string, unknown>)
    if (t) remember(t)
    likes[d.id] = { trackId: d.id, likedAt: Number(data.likedAt ?? updatedAt), updatedAt, deleted: !!data.deleted, dirty: false }
    applied++
  })
  if (applied) useLibrary.getState().applyRemote({ likes })
  const dirty = Object.values(lib().likes).filter((l) => l.dirty)
  const toPush = dirty.filter((l) => sourceOf(l.trackId) === 'YOUTUBE')
  for (let i = 0; i < toPush.length; i += 400) {
    const batch = writeBatch(db)
    const chunk = toPush.slice(i, i + 400)
    for (const l of chunk) {
      const t = trackRegistry.get(l.trackId)
      batch.set(doc(col, l.trackId), {
        trackId: l.trackId, likedAt: l.likedAt, updatedAt: l.updatedAt, deleted: l.deleted, track: t ? trackToMap(t) : null,
      }, { merge: true })
    }
    await batch.commit()
    writes(chunk.length)
  }
  // Only clear rows that didn't change while the write was in flight.
  const pushed = new Map<TrackId, SyncedLike>(dirty.map((l) => [l.trackId, l]))
  useLibrary.getState().markClean({ likes: Object.values(lib().likes).filter((l) => pushed.get(l.trackId)?.updatedAt === l.updatedAt).map((l) => l.trackId) })
  ls.set(`likes_pulled_${uid}`, maxRemote)
  return applied
}

// ── Playlists ─────────────────────────────────────────────────────────────────
async function syncPlaylists(uid: string) {
  const db = firestore()
  const col = collection(db, 'users', uid, 'playlists')
  const since = ls.get<number>(`pl_pulled_${uid}`, 0)
  const snap = await getDocsFromServer(query(col, where('updatedAt', '>', since)))
  reads(snap.size)
  const playlists = { ...lib().playlists }
  let maxRemote = since
  let applied = 0
  snap.forEach((d) => {
    const m = d.data()
    const updatedAt = Number(m.updatedAt ?? 0)
    maxRemote = Math.max(maxRemote, updatedAt)
    const local = playlists[d.id]
    if (local && local.updatedAt >= updatedAt) return
    const tracks = (Array.isArray(m.tracks) ? m.tracks : []).map((t: Record<string, unknown>) => (typeof t?.id === 'string' ? trackFromMap(t.id, t) : null)).filter((t: Track | null): t is Track => !!t)
    remember(tracks)
    playlists[d.id] = {
      id: d.id, name: String(m.name || 'Playlist'), description: String(m.description ?? ''), kind: 'ARNAV',
      artworkUrl: (m.artworkUrl as string) ?? null, pinned: !!m.pinned, createdAt: Number(m.createdAt ?? updatedAt), updatedAt,
      deleted: !!m.deleted, trackIds: tracks.map((t: Track) => t.id), dirty: false, remoteRef: local?.remoteRef ?? null,
    }
    applied++
  })
  if (applied) useLibrary.getState().applyRemote({ playlists })
  const dirty = Object.values(lib().playlists).filter((p) => p.dirty && p.kind === 'ARNAV')
  for (const p of dirty) {
    const ids = p.trackIds.filter((id) => sourceOf(id) === 'YOUTUBE').slice(0, 500)
    const tracks = trackRegistry.many(ids).map(trackToMap)
    await setDoc(doc(col, p.id), {
      name: p.name.slice(0, 100), description: p.description.slice(0, 500), kind: 'ARNAV', artworkUrl: p.artworkUrl ?? null,
      pinned: p.pinned, createdAt: p.createdAt, updatedAt: p.updatedAt, deleted: !!p.deleted, tracks,
    })
    writes(1)
  }
  const pushed = new Map<string, SyncedPlaylist>(dirty.map((p) => [p.id, p]))
  useLibrary.getState().markClean({ playlists: Object.values(lib().playlists).filter((p) => pushed.get(p.id)?.updatedAt === p.updatedAt).map((p) => p.id) })
  ls.set(`pl_pulled_${uid}`, maxRemote)
  return applied
}

// ── Live records: listening history + shared queue ──────────────────────────
interface Journal { [recordId: string]: { rev: number; value?: string } }

interface SharedListen {
  trackId: string; artistKey: string; startedAt: number; listenedMs: number; durationMs: number | null
  completed: boolean; skipped: boolean; source: string; title: string; artist: string; album: string | null
}

async function pullLive(uid: string, journal: Journal): Promise<number> {
  const db = firestore()
  const col = collection(db, 'users', uid, 'liveRecords')
  const since = ls.get<number>(`live_cursor_${uid}`, 0)
  let q = query(col, where('updatedAt', '>=', Timestamp.fromMillis(since)), orderBy('updatedAt'), limit(300))
  let newest = since
  let added = 0
  const newEvents: LocalEvent[] = []
  const deletedIds = new Set<string>()
  for (let page = 0; page < 40; page++) {
    const snap = await getDocsFromServer(q)
    reads(snap.size)
    snap.forEach((d: QueryDocumentSnapshot<DocumentData>) => {
      const data = d.data()
      const rev = Number(data.revision ?? 0)
      const ts = (data.updatedAt as Timestamp | undefined)?.toMillis?.() ?? 0
      newest = Math.max(newest, ts)
      if ((journal[d.id]?.rev ?? 0) >= rev) return
      const kind = data.kind as string
      const value = typeof data.value === 'string' ? data.value : ''
      journal[d.id] = { rev }
      if (kind === 'history') {
        if (data.deleted) { deletedIds.add(d.id); return }
        try {
          const ev = JSON.parse(value) as SharedListen
          const isOwnDevice = data.deviceId === deviceId
          if (isOwnDevice && lib().events.some((e) => e.cloudId === d.id)) return
          const src = sourceOf(ev.trackId)
          const trackId = src === 'LOCAL' ? `local:cloud_${d.id.slice(2, 18)}` : ev.trackId
          if (src === 'YOUTUBE' && ev.title && !trackRegistry.has(trackId)) {
            remember({ id: trackId, title: ev.title, artist: ev.artist, album: ev.album, durationMs: ev.durationMs, playbackRef: nativeId(trackId), genres: [], artworkUrl: `https://i.ytimg.com/vi/${nativeId(trackId)}/hqdefault.jpg` })
          }
          newEvents.push({
            trackId, artistKey: ev.artistKey || artistKey(ev.artist ?? ''), startedAt: ev.startedAt, listenedMs: ev.listenedMs,
            durationMs: ev.durationMs ?? null, completed: !!ev.completed, skipped: !!ev.skipped, source: src,
            cloudId: d.id, localId: `c${d.id.slice(2, 17)}`, dirty: false,
          })
        } catch { /* malformed record — ignore */ }
      } else if (kind === 'queue' && value) {
        try {
          const q2 = JSON.parse(value) as { tracks?: Record<string, unknown>[]; index?: number }
          const tracks = (q2.tracks ?? []).map(fromKotlinTrack).filter((t): t is Track => !!t)
          if (tracks.length) {
            remember(tracks)
            useSync.setState({ remoteQueue: { tracks, index: Math.min(tracks.length - 1, Math.max(0, q2.index ?? 0)), updatedAt: ts, fromThisDevice: data.deviceId === deviceId } })
          }
          journal[d.id] = { rev, value }
        } catch { /* ignore */ }
      }
    })
    if (snap.size < 300) break
    q = query(col, where('updatedAt', '>=', Timestamp.fromMillis(since)), orderBy('updatedAt'), startAfter(snap.docs[snap.docs.length - 1]), limit(300))
  }
  if (newEvents.length || deletedIds.size) {
    const known = new Set(lib().events.map((e) => e.cloudId).filter(Boolean))
    const merged = [...lib().events.map((e) => (e.cloudId && deletedIds.has(e.cloudId) ? { ...e, deleted: true, dirty: false } : e)), ...newEvents.filter((e) => !known.has(e.cloudId))]
      .sort((a, b) => a.startedAt - b.startedAt)
    added = newEvents.length
    useLibrary.getState().applyRemote({ events: merged })
  }
  ls.set(`live_cursor_${uid}`, newest)
  return added
}

async function pushLive(uid: string, journal: Journal) {
  const db = firestore()
  const col = collection(db, 'users', uid, 'liveRecords')
  const dirty = lib().events.filter((e) => e.dirty).slice(0, 200)
  const cleaned: string[] = []
  const ids = new Map<string, string>()
  for (const e of dirty) {
    if (e.deleted && !e.cloudId) { cleaned.push(e.localId); continue }
    if (sourceOf(e.trackId) !== 'YOUTUBE' && !e.cloudId) { cleaned.push(e.localId); continue }
    const id = e.cloudId ?? `h_${await sha256(`${deviceId}:${e.localId}:${e.startedAt}:${e.trackId}`)}`
    const t = trackRegistry.get(e.trackId)
    const listen: SharedListen = {
      trackId: e.trackId, artistKey: e.artistKey, startedAt: e.startedAt, listenedMs: Math.round(e.listenedMs), durationMs: e.durationMs != null ? Math.round(e.durationMs) : null,
      completed: e.completed, skipped: e.skipped, source: 'YOUTUBE', title: (t?.title ?? '').slice(0, 200), artist: (t?.artist ?? '').slice(0, 200), album: t?.album?.slice(0, 200) ?? null,
    }
    const value = JSON.stringify(listen).slice(0, 4000)
    const rev = await runTransaction(db, async (tx) => {
      const ref = doc(col, id)
      const existing = await tx.get(ref)
      const ex = existing.exists() ? existing.data() : null
      const next = Number(ex?.revision ?? 0) + 1
      tx.set(ref, {
        kind: 'history', value: ex?.value ?? value, revision: next, deleted: !!ex?.deleted || !!e.deleted,
        deviceId: ex?.deviceId ?? deviceId, updatedAt: serverTimestamp(), schema: 1,
      })
      return next
    })
    reads(1); writes(1)
    journal[id] = { rev }
    ids.set(e.localId, id)
    cleaned.push(e.localId)
  }
  if (ids.size) {
    useLibrary.getState().applyRemote({ events: lib().events.map((e) => (ids.has(e.localId) ? { ...e, cloudId: ids.get(e.localId) } : e)) })
  }
  if (cleaned.length) useLibrary.getState().markClean({ events: cleaned })
}

/** Shares an idle, YouTube-only queue (≤100 songs) — the same record the phone hands off. */
async function pushQueue(uid: string, journal: Journal) {
  const p = player()
  if (p.isPlaying || !p.queue.length || p.queue.length > 100) return
  const tracks = p.queue.map((q) => q.track)
  if (!tracks.every((t) => sourceOf(t.id) === 'YOUTUBE')) return
  const value = JSON.stringify({ tracks: tracks.map(kotlinTrack), index: p.index })
  if (value.length > 200_000 || ls.get<string | null>(`queue_seen_${uid}`, null) === value) return
  const db = firestore()
  const ref = doc(collection(db, 'users', uid, 'liveRecords'), 'q_shared')
  const rev = await runTransaction(db, async (tx) => {
    const existing = await tx.get(ref)
    const next = Number(existing.exists() ? existing.data().revision ?? 0 : 0) + 1
    tx.set(ref, { kind: 'queue', value, revision: next, deleted: false, deviceId, updatedAt: serverTimestamp(), schema: 1 })
    return next
  })
  reads(1); writes(1)
  journal.q_shared = { rev, value }
  ls.set(`queue_seen_${uid}`, value)
}

// ── Orchestration ────────────────────────────────────────────────────────────
let running: Promise<void> | null = null
let again = false
let debounce: ReturnType<typeof setTimeout> | null = null
let unsubLive: (() => void) | null = null
let liveUid: string | null = null

export function requestSync(delayMs = 4000) {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => { void syncNow() }, delayMs)
}

export async function syncNow(): Promise<void> {
  if (running) { again = true; return running }
  running = (async () => {
    do {
      again = false
      await syncOnce()
    } while (again)
  })().finally(() => { running = null })
  return running
}

async function syncOnce() {
  const user = useAuth.getState().user
  if (!user || !settings().cloudSync) {
    stopLive()
    useSync.setState({ status: 'DISABLED' })
    return
  }
  const uid = user.uid
  const o = owner()
  if (o && o !== uid && hasLocalData()) {
    useSync.setState({ status: 'ACCOUNT_BLOCKED', error: 'This browser holds another account’s library. Load this account’s library instead, or sign back in to the other one.' })
    return
  }
  if (!o) ls.set('arnav.dataOwner', uid)
  useSync.setState({ status: 'SYNCING', error: null })
  try {
    const journal = (await idbGet<Journal>(`journal_${uid}`)) ?? {}
    const history = await pullLive(uid, journal)
    const likes = await syncLikes(uid)
    const playlists = await syncPlaylists(uid)
    await pushLive(uid, journal)
    await pushQueue(uid, journal).catch(() => undefined)
    await idbSet(`journal_${uid}`, journal)
    if (useAuth.getState().user?.uid !== uid) return
    observeLive(uid)
    const prev = useSync.getState().pulled
    useSync.setState({ status: 'UP_TO_DATE', lastSyncedAt: Date.now(), pulled: { likes: prev.likes + likes, playlists: prev.playlists + playlists, history: prev.history + history } })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const offline = /offline|network|unavailable/i.test(msg) || navigator.onLine === false
    useSync.setState({
      status: offline ? 'OFFLINE' : 'ERROR',
      error: /permission/i.test(msg) ? 'Firestore refused the write (permission denied). The account’s security rules may need deploying.' : msg.slice(0, 200),
    })
  }
}

function observeLive(uid: string) {
  if (liveUid === uid) return
  stopLive()
  liveUid = uid
  const col = collection(firestore(), 'users', uid, 'liveRecords')
  unsubLive = onSnapshot(query(col, orderBy('updatedAt', 'desc'), limit(1)), { includeMetadataChanges: false }, (snap) => {
    if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return
    reads(snap.size)
    requestSync(2000)
  }, () => undefined)
}
function stopLive() {
  unsubLive?.()
  unsubLive = null
  liveUid = null
}

/** Deletes everything Arnav Music stored in the cloud for this account (local data stays). */
export async function deleteCloudData() {
  const user = useAuth.getState().user
  if (!user) throw new Error('Sign in first')
  useSettings.getState().update({ cloudSync: false })
  stopLive()
  const db = firestore()
  for (const sub of ['likes', 'playlists', 'backups', 'vaultChunks', 'devices', 'liveRecords']) {
    for (;;) {
      const snap = await getDocs(query(collection(db, 'users', user.uid, sub), limit(400)))
      if (snap.empty) break
      const batch = writeBatch(db)
      snap.forEach((d) => batch.delete(d.ref))
      await batch.commit()
      reads(snap.size); writes(snap.size)
    }
  }
  await deleteDoc(doc(db, 'users', user.uid))
  for (const k of [`likes_pulled_${user.uid}`, `pl_pulled_${user.uid}`, `live_cursor_${user.uid}`, `queue_seen_${user.uid}`]) ls.del(k)
  await idbSet(`journal_${user.uid}`, {})
  useSync.setState({ status: 'DISABLED', remoteQueue: null })
}

let started = false
export function startSync() {
  if (started) return
  started = true
  watchAuth((u) => {
    useAuth.getState().set({
      status: u ? 'signedIn' : 'signedOut',
      user: u ? { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL, providers: u.providerData.map((p) => p.providerId) } : null,
    })
    stopLive()
    useSync.setState({ remoteQueue: null })
    requestSync(u ? 300 : 0)
  })
  let rev = lib().revision
  useLibrary.subscribe((s) => {
    if (s.revision === rev) return
    rev = s.revision
    if (useSync.getState().status !== 'SYNCING') requestSync(s.events.some((e) => e.dirty) ? 8000 : 4000)
  })
  usePlayer.subscribe((s, prev) => {
    if (prev.isPlaying && !s.isPlaying) requestSync(6000)
  })
  useSettings.subscribe((s, prev) => { if (s.cloudSync !== prev.cloudSync) requestSync(500) })
  window.addEventListener('online', () => requestSync(1000))
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestSync(1500) })
}
