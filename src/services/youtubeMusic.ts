/**
 * YouTube Music sync (while Arnav is open). Linked playlists and your likes stay the same in both
 * apps: edits on either side are merged three ways (see lib/ytsync.ts) and written to the other.
 *
 * - YouTube Music playlists are YouTube playlists, so the YouTube Data API edits them; YouTube
 *   Music's Liked Songs follow your liked videos (rated through the API, music only).
 * - Google gives a browser a one-hour pass. When it runs out, edits wait and a Reconnect button
 *   appears; nothing is lost.
 * - Every write costs 50 of the project's 10,000 daily quota units, so writes are budgeted; a sync
 *   cut short finishes next time from the same agreed state.
 * - Arnav's own playlists then sync with the Android app as usual (Firestore).
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { idbGet, idbSet } from '../lib/idb'
import { youtubeManageToken } from '../lib/firebase'
import { mergeLikes, mergeLists, planRemote, type FirstLink, type RemoteItem, type RemoteOp, type SyncMode } from '../lib/ytsync'
import { videoToTrack, bestThumb, type YtVideo, type YtSnippet } from '../lib/classify'
import { decodeEntities } from '../lib/format'
import { lib, likedIds, useLibrary } from '../state/library'
import { remember, trackRegistry } from '../state/tracks'
import { toast } from '../state/ui'
import { nativeId, sourceOf, type Track } from '../lib/types'

export interface YtLink {
  arnavId: string
  ytId: string
  mode: SyncMode
  /** The title both sides agreed on (to tell which side renamed). */
  title: string
  /** How the very first sync combines the two sides. */
  first: FirstLink
  etag: string | null
  syncedAt: number
  /** The last sync of this playlist didn't finish (quota, pass ran out) — retried next time. */
  pending: boolean
  error: string | null
}
export interface RemoteList { id: string; title: string; count: number; art: string | null; etag: string }
export type YtStatus = 'off' | 'idle' | 'syncing' | 'needs-pass' | 'quota' | 'error'

interface YtState {
  connected: boolean
  account: string | null
  links: Record<string, YtLink>
  likesSync: boolean
  autoLinkNew: boolean
  /** YouTube playlists that existed at connect time or were seen since (new ones get auto-linked). */
  known: string[]
  likes: { linked: boolean; count: number; firstItem: string | null; syncedAt: number }
  units: { day: string; used: number }
  log: { at: number; text: string }[]
  lastSyncAt: number
  // Not saved:
  status: YtStatus
  message: string | null
  remote: RemoteList[] | null
  reviewOpen: boolean
  /** Songs that just arrived from YouTube Music, per Arnav playlist (they glow briefly). */
  arrivals: Record<string, { ids: string[]; at: number }>
}

export const useYtMusic = create<YtState>()(persist((): YtState => ({
  connected: false, account: null, links: {}, likesSync: true, autoLinkNew: true, known: [],
  likes: { linked: false, count: -1, firstItem: null, syncedAt: 0 }, units: { day: '', used: 0 }, log: [], lastSyncAt: 0,
  status: 'off' as YtStatus, message: null, remote: null, reviewOpen: false, arrivals: {},
}), {
  name: 'arnav.ytmusic',
  version: 1,
  storage: createJSONStorage(() => localStorage),
  partialize: (s) => ({ connected: s.connected, account: s.account, links: s.links, likesSync: s.likesSync, autoLinkNew: s.autoLinkNew, known: s.known, likes: s.likes, units: s.units, log: s.log, lastSyncAt: s.lastSyncAt }),
}))
const st = () => useYtMusic.getState()
const patch = (p: Partial<YtState>) => useYtMusic.setState(p)
const setLink = (id: string, p: Partial<YtLink>) => { const l = st().links[id]; if (l) patch({ links: { ...st().links, [id]: { ...l, ...p } } }) }

function note(text: string) {
  patch({ log: [{ at: Date.now(), text }, ...st().log].slice(0, 40) })
}

// ── The pass (one hour, this tab) ───────────────────────────────────────────
let pass: { token: string; expiresAt: number } | null = null
const PASS_KEY = 'arnav.ytPass'
try { const s = JSON.parse(sessionStorage.getItem(PASS_KEY) ?? 'null'); if (s?.token && s.expiresAt > Date.now()) pass = s } catch { /* storage blocked */ }
const passValid = () => !!pass && pass.expiresAt - Date.now() > 60_000
export const hasPass = passValid

/** Opens Google's window for a pass. `consent` the first time; afterwards it's one quick tap. */
export async function getPass(mode: 'consent' | 'quick' = st().connected ? 'quick' : 'consent'): Promise<boolean> {
  try {
    const r = await youtubeManageToken(mode)
    pass = { token: r.token, expiresAt: r.expiresAt }
    try { sessionStorage.setItem(PASS_KEY, JSON.stringify(pass)) } catch { /* storage blocked */ }
    patch({ connected: true, account: r.email, status: 'idle', message: null })
    return true
  } catch (e) {
    patch({ message: e instanceof Error ? e.message.replace(/^Firebase: /, '') : 'Couldn’t connect to YouTube' })
    return false
  }
}

// ── YouTube Data API (your quota) ───────────────────────────────────────────
const DAILY_BUDGET = 9000
const pacificDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
function spend(units: number) {
  const u = st().units
  const day = pacificDay()
  patch({ units: { day, used: (u.day === day ? u.used : 0) + units } })
}
export const unitsLeft = () => { const u = st().units; return DAILY_BUDGET - (u.day === pacificDay() ? u.used : 0) }

class NeedsPass extends Error { constructor() { super('needs-pass') } }
class OutOfQuota extends Error { constructor() { super('quota') } }

async function yt<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, params: Record<string, string>, body?: unknown, cost = 1): Promise<T> {
  if (!passValid()) throw new NeedsPass()
  if (unitsLeft() < cost) throw new OutOfQuota()
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams(params)}`, {
    method,
    headers: { Authorization: `Bearer ${pass!.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  spend(cost)
  if (r.status === 401) { pass = null; try { sessionStorage.removeItem(PASS_KEY) } catch { /* blocked */ } throw new NeedsPass() }
  if (r.status === 204) return undefined as T
  const data = await r.json().catch(() => null) as { error?: { message?: string; errors?: { reason?: string }[] } } | null
  if (!r.ok) {
    const reason = data?.error?.errors?.[0]?.reason ?? ''
    if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/.test(reason)) { patch({ units: { day: pacificDay(), used: DAILY_BUDGET } }); throw new OutOfQuota() }
    throw new Error(data?.error?.message ?? `YouTube error ${r.status}`)
  }
  return data as T
}

async function myPlaylists(): Promise<RemoteList[]> {
  const out: RemoteList[] = []
  let page: string | undefined
  for (let i = 0; i < 10; i++) {
    const r = await yt<{ items?: { id: string; etag: string; snippet?: YtSnippet; contentDetails?: { itemCount?: number } }[]; nextPageToken?: string }>('GET', 'playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(page ? { pageToken: page } : {}) })
    out.push(...(r.items ?? []).map((p) => ({ id: p.id, title: decodeEntities(p.snippet?.title ?? 'Playlist'), count: p.contentDetails?.itemCount ?? 0, art: bestThumb(p.snippet?.thumbnails) ?? null, etag: p.etag })))
    page = r.nextPageToken
    if (!page) break
  }
  return out
}

async function playlistItems(ytId: string, maxPages = 100): Promise<{ items: RemoteItem[]; total: number }> {
  const items: RemoteItem[] = []
  let total = 0
  let page: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const r = await yt<{ items?: { id: string; contentDetails?: { videoId?: string } }[]; nextPageToken?: string; pageInfo?: { totalResults?: number } }>('GET', 'playlistItems', { part: 'contentDetails', playlistId: ytId, maxResults: '50', ...(page ? { pageToken: page } : {}) })
    total = r.pageInfo?.totalResults ?? total
    for (const it of r.items ?? []) if (it.contentDetails?.videoId) items.push({ itemId: it.id, videoId: it.contentDetails.videoId })
    page = r.nextPageToken
    if (!page) break
  }
  return { items, total }
}

/** Song details for videos Arnav hasn't seen yet (1 unit per 50). */
async function ensureTracks(videoIds: string[]): Promise<Map<string, YtVideo>> {
  const missing = videoIds.filter((v) => !trackRegistry.has(`yt:${v}`))
  const raw = new Map<string, YtVideo>()
  for (let i = 0; i < missing.length; i += 50) {
    const r = await yt<{ items?: YtVideo[] }>('GET', 'videos', { part: 'snippet,contentDetails,status', id: missing.slice(i, i + 50).join(',') })
    const vids = r.items ?? []
    remember(vids.map((v) => videoToTrack(v)))
    for (const v of vids) raw.set(typeof v.id === 'string' ? v.id : '', v)
  }
  return raw
}

async function runOps(ytId: string, ops: RemoteOp[], done: { inserts: number; deletes: number }): Promise<number> {
  let n = 0
  for (const op of ops) {
    if (op.kind === 'delete') await yt('DELETE', 'playlistItems', { id: op.itemId }, undefined, 50)
    else if (op.kind === 'insert') await yt('POST', 'playlistItems', { part: 'snippet' }, { snippet: { playlistId: ytId, position: op.position, resourceId: { kind: 'youtube#video', videoId: op.videoId } } }, 50)
    else await yt('PUT', 'playlistItems', { part: 'snippet' }, { id: op.itemId, snippet: { playlistId: ytId, position: op.position, resourceId: { kind: 'youtube#video', videoId: op.videoId } } }, 50)
    if (op.kind === 'insert') done.inserts++
    if (op.kind === 'delete') done.deletes++
    n++
  }
  return n
}

const baseKey = (id: string) => `ytbase|${id}`
const ytVideoIds = (trackIds: string[]) => trackIds.filter((t) => sourceOf(t) === 'YOUTUBE').map(nativeId)

// ── Syncing one playlist ────────────────────────────────────────────────────
let applying = false

async function syncPlaylist(link: YtLink, remote: RemoteList | undefined): Promise<void> {
  const pl = lib().playlists[link.arnavId]
  if (!pl || pl.deleted) { unlink(link.arnavId); return }
  if (!remote) {
    // Deleted on YouTube Music: the Arnav copy stays, unlinked.
    unlink(link.arnavId)
    note(`“${pl.name}” was deleted on YouTube Music — kept here, no longer linked`)
    toast(`“${pl.name}” was deleted on YouTube Music. It’s still here.`)
    return
  }
  const base = await idbGet<string[]>(baseKey(link.arnavId)) ?? null
  const localChanged = pl.updatedAt > link.syncedAt
  if (base && !link.pending && !localChanged && remote.etag === link.etag && pl.name === link.title) return

  const { items } = await playlistItems(link.ytId)
  const remoteIds = items.map((i) => i.videoId)
  const local = ytVideoIds(pl.trackIds)
  const m = mergeLists(base, local, remoteIds, link.mode, link.first)

  // Titles: whoever renamed wins (YouTube when both did).
  let title = link.title
  if (link.mode !== 'to-youtube' && remote.title !== link.title) title = remote.title
  else if (link.mode !== 'from-youtube' && pl.name !== link.title) title = pl.name

  // Arnav side first (free): the merged list, plus any non-YouTube songs it had.
  const others = pl.trackIds.filter((t) => sourceOf(t) !== 'YOUTUBE')
  const nextIds = [...m.merged.map((v) => `yt:${v}`), ...others]
  if (m.addedFromYouTube.length) await ensureTracks(m.addedFromYouTube)
  applying = true
  try {
    if (nextIds.join('|') !== pl.trackIds.join('|')) lib().reorderPlaylist(link.arnavId, nextIds)
    if (title !== pl.name) lib().updatePlaylist(link.arnavId, { name: title })
  } finally { applying = false }
  if (m.addedFromYouTube.length) patch({ arrivals: { ...st().arrivals, [link.arnavId]: { ids: m.addedFromYouTube.map((v) => `yt:${v}`), at: Date.now() } } })

  // Then YouTube (50 units a write). If it stops part-way, the base stays and it finishes next time.
  let ok = true
  const sent = { inserts: 0, deletes: 0 }
  try {
    if (link.mode !== 'from-youtube') {
      const ops = planRemote(items, m.merged)
      if (ops.length) await runOps(link.ytId, ops, sent)
    }
    if (link.mode !== 'from-youtube' && title !== remote.title) await yt('PUT', 'playlists', { part: 'snippet' }, { id: link.ytId, snippet: { title } }, 50)
  } catch (e) {
    ok = false
    if (e instanceof NeedsPass || e instanceof OutOfQuota) setLink(link.arnavId, { pending: true })
    throw e
  } finally {
    const words: string[] = []
    if (m.addedFromYouTube.length) words.push(`+${m.addedFromYouTube.length} from YouTube Music`)
    if (m.removedByYouTube.length) words.push(`−${m.removedByYouTube.length} removed on YouTube Music`)
    // Only what actually reached YouTube.
    if (sent.inserts) words.push(`+${sent.inserts} to YouTube Music`)
    if (sent.deletes) words.push(`−${sent.deletes} removed there`)
    if (words.length) note(`${title}: ${words.join(', ')}`)
  }
  if (ok) {
    await idbSet(baseKey(link.arnavId), m.merged)
    // The etag changes with our own writes; the next check reads the list once and finds nothing new.
    setLink(link.arnavId, { title, etag: remote.etag, syncedAt: Date.now(), pending: false, error: null, first: 'both' })
    if (m.addedFromYouTube.length && document.visibilityState === 'visible') toast(`${title}: ${m.addedFromYouTube.length} new from YouTube Music`)
  }
}

// ── Likes ↔ YouTube Music's Liked Songs ─────────────────────────────────────
const MUSIC_CATEGORY = '10'
async function syncLikes(): Promise<void> {
  const likesState = st().likes
  // A cheap look first: the newest liked item and the count tell whether anything changed there.
  const head = await yt<{ items?: { id: string; contentDetails?: { videoId?: string } }[]; pageInfo?: { totalResults?: number } }>('GET', 'playlistItems', { part: 'contentDetails', playlistId: 'LL', maxResults: '1' })
  const total = head.pageInfo?.totalResults ?? 0
  const firstItem = head.items?.[0]?.id ?? null
  const local = [...likedIds()].filter((t) => sourceOf(t) === 'YOUTUBE').map(nativeId)
  const base = await idbGet<string[]>('ytbase|likes') ?? null
  const localKey = local.slice().sort().join(',')
  const lastLocal = await idbGet<string>('ytbase|likesLocal')
  if (base && likesState.linked && total === likesState.count && firstItem === likesState.firstItem && lastLocal === localKey) return

  const { items } = await playlistItems('LL', 60)
  // YouTube's liked videos include non-music: only songs take part.
  const nonMusic = new Set(await idbGet<string[]>('ytbase|nonMusic') ?? [])
  const unknown = items.map((i) => i.videoId).filter((v) => !trackRegistry.has(`yt:${v}`) && !nonMusic.has(v))
  const raw = await ensureTracks(unknown)
  for (const [id, v] of raw) {
    const isMusic = (v.snippet as { categoryId?: string } | undefined)?.categoryId === MUSIC_CATEGORY || /- Topic$/.test(v.snippet?.channelTitle ?? '')
    if (!isMusic) nonMusic.add(id)
  }
  for (const v of unknown) if (!raw.has(v)) nonMusic.add(v) // private or deleted videos
  await idbSet('ytbase|nonMusic', [...nonMusic].slice(-5000))
  const remote = items.map((i) => i.videoId).filter((v) => !nonMusic.has(v))
  const m = mergeLikes(base, local, remote)

  applying = true
  try {
    for (const v of m.likeHere) { const t = trackRegistry.get(`yt:${v}`); if (t) lib().setLiked(t, true) }
    for (const v of m.unlikeHere) { const t = trackRegistry.get(`yt:${v}`); if (t) lib().setLiked(t, false) }
  } finally { applying = false }
  let ok = true
  try {
    for (const v of m.likeOnYouTube) await yt('POST', 'videos/rate', { id: v, rating: 'like' }, undefined, 50)
    for (const v of m.unlikeOnYouTube) await yt('POST', 'videos/rate', { id: v, rating: 'none' }, undefined, 50)
  } catch (e) { ok = false; throw e } finally {
    const words: string[] = []
    if (m.likeHere.length) words.push(`+${m.likeHere.length} liked on YouTube Music`)
    if (m.unlikeHere.length) words.push(`−${m.unlikeHere.length} un-liked there`)
    if (ok && m.likeOnYouTube.length) words.push(`+${m.likeOnYouTube.length} liked here`)
    if (words.length) note(`Liked Songs: ${words.join(', ')}`)
  }
  await idbSet('ytbase|likes', m.liked)
  await idbSet('ytbase|likesLocal', [...likedIds()].filter((t) => sourceOf(t) === 'YOUTUBE').map(nativeId).sort().join(','))
  // Our own likes changed YouTube's list: read the head again next time rather than trusting this one.
  patch({ likes: { linked: true, count: m.likeOnYouTube.length || m.unlikeOnYouTube.length ? -1 : total, firstItem, syncedAt: Date.now() } })
}

// ── The whole sync ─────────────────────────────────────────────────────────
let running: Promise<void> | null = null
let again = false

export function syncNow(): Promise<void> {
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
  const s = st()
  if (!s.connected) return
  if (!passValid()) { if (Object.keys(s.links).length || s.likesSync) patch({ status: 'needs-pass' }); return }
  if (unitsLeft() < 60) { patch({ status: 'quota' }); return }
  patch({ status: 'syncing', message: null })
  try {
    const remote = await myPlaylists()
    patch({ remote })
    const byId = new Map(remote.map((r) => [r.id, r]))
    // New playlists made in YouTube Music since you connected: linked and brought here.
    if (st().autoLinkNew && st().known.length) {
      const known = new Set(st().known)
      const linkedYt = new Set(Object.values(st().links).map((l) => l.ytId))
      for (const r of remote) if (!known.has(r.id) && !linkedYt.has(r.id)) { link(r.id, null, 'youtube', 'two-way'); note(`New on YouTube Music: “${r.title}” — added here`) }
    }
    patch({ known: [...new Set([...st().known, ...remote.map((r) => r.id)])] })
    for (const l of Object.values(st().links)) {
      try { await syncPlaylist(l, byId.get(l.ytId)) } catch (e) {
        if (e instanceof NeedsPass || e instanceof OutOfQuota) throw e
        setLink(l.arnavId, { error: e instanceof Error ? e.message : 'Sync failed' })
      }
    }
    if (st().likesSync) await syncLikes()
    patch({ status: 'idle', lastSyncAt: Date.now() })
  } catch (e) {
    if (e instanceof NeedsPass) patch({ status: 'needs-pass' })
    else if (e instanceof OutOfQuota) { patch({ status: 'quota' }); note('YouTube’s daily limit reached — the rest syncs tomorrow') }
    else patch({ status: 'error', message: e instanceof Error ? e.message : 'Sync failed' })
  }
}

// ── Linking ────────────────────────────────────────────────────────────────
/** Connects (first time: Google's consent screen) and opens the review of what to link. */
export async function connect() {
  if (!(await getPass('consent'))) return
  try {
    const remote = await myPlaylists()
    patch({ remote, reviewOpen: true, known: st().known.length ? st().known : remote.map((r) => r.id) })
  } catch (e) {
    patch({ message: e instanceof Error ? e.message : 'Couldn’t read your YouTube playlists' })
  }
}

/** Links a YouTube playlist to an Arnav one (null: a new Arnav playlist named after it). */
export function link(ytId: string, arnavId: string | null, first: FirstLink = 'both', mode: SyncMode = 'two-way') {
  const r = st().remote?.find((x) => x.id === ytId)
  const id = arnavId ?? lib().createPlaylist(r?.title ?? 'YouTube Music playlist', [], 'Synced with YouTube Music')
  const name = lib().playlists[id]?.name ?? r?.title ?? ''
  patch({ links: { ...st().links, [id]: { arnavId: id, ytId, mode, title: r?.title ?? name, first, etag: null, syncedAt: 0, pending: true, error: null } } })
  return id
}

export function unlink(arnavId: string) {
  const links = { ...st().links }
  delete links[arnavId]
  patch({ links })
  void idbSet(baseKey(arnavId), null)
}

export function setMode(arnavId: string, mode: SyncMode) { setLink(arnavId, { mode, etag: null }) }

/** Creates the playlist on YouTube Music (private) and links it; the songs follow on the next sync. */
export async function addToYouTube(arnavId: string): Promise<boolean> {
  const pl = lib().playlists[arnavId]
  if (!pl) return false
  if (!passValid() && !(await getPass())) return false
  try {
    const r = await yt<{ id: string }>('POST', 'playlists', { part: 'snippet,status' }, { snippet: { title: pl.name.slice(0, 150), description: (pl.description || 'Made in Arnav Music').slice(0, 4000) }, status: { privacyStatus: 'private' } }, 50)
    patch({ links: { ...st().links, [arnavId]: { arnavId, ytId: r.id, mode: 'two-way', title: pl.name, first: 'arnav', etag: null, syncedAt: 0, pending: true, error: null } }, known: [...st().known, r.id] })
    note(`“${pl.name}” created on YouTube Music`)
    void syncNow()
    return true
  } catch (e) {
    toast(e instanceof OutOfQuota ? 'YouTube’s daily limit is reached — try again tomorrow' : e instanceof Error ? e.message : 'Couldn’t create it on YouTube Music')
    return false
  }
}

/** Deletes the linked YouTube playlist too (only when you ask, from Arnav's delete sheet). */
export async function deleteOnYouTube(arnavId: string) {
  const l = st().links[arnavId]
  if (!l) return
  unlink(arnavId)
  try { await yt('DELETE', 'playlists', { id: l.ytId }, undefined, 50); note('Deleted on YouTube Music too') } catch (e) { toast(e instanceof Error && e.message !== 'needs-pass' ? e.message : 'Reconnect YouTube Music to delete it there') }
}

/** Imports from an earlier one-way copy ("ytimp_<id>") can become linked without re-importing. */
export const importedYtId = (arnavId: string) => (arnavId.startsWith('ytimp_') ? arnavId.slice(6) : null)

/** Stops syncing; the pass is revoked with Google. Links are kept for when you reconnect. */
export async function disconnect() {
  const t = pass?.token
  pass = null
  try { sessionStorage.removeItem(PASS_KEY) } catch { /* blocked */ }
  if (t) void fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => undefined)
  patch({ connected: false, status: 'off', account: null })
}

/** Your old "Liked videos" copy goes into Liked Songs (which then stays in sync). */
export function moveImportedLikes(arnavId: string) {
  const pl = lib().playlists[arnavId]
  if (!pl) return 0
  let n = 0
  for (const id of pl.trackIds) { const t = trackRegistry.get(id) as Track | undefined; if (t && !useLibrary.getState().isLiked(id)) { lib().setLiked(t, true); n++ } }
  lib().deletePlaylist(arnavId)
  return n
}

// ── Running while the app is open ───────────────────────────────────────────
let timer: ReturnType<typeof setTimeout> | null = null
const soon = (ms = 5000) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void syncNow() }, ms) }

export function startYtMusic() {
  if (st().connected) patch({ status: passValid() ? 'idle' : 'needs-pass' })
  // Your edits to linked playlists (and likes) go to YouTube Music a few seconds later.
  useLibrary.subscribe((s, p) => {
    if (applying || !st().connected) return
    const links = st().links
    const touched = Object.keys(links).some((id) => s.playlists[id] !== p.playlists[id])
    if (touched || (st().likesSync && s.likes !== p.likes)) {
      for (const id of Object.keys(links)) if (s.playlists[id] !== p.playlists[id]) setLink(id, { pending: true })
      if (passValid()) soon(5000); else patch({ status: 'needs-pass' })
    }
  })
  // And YouTube Music's changes come here: on open, every few minutes, and when you come back.
  if (passValid()) soon(1500)
  setInterval(() => { if (document.visibilityState === 'visible' && passValid() && st().connected) void syncNow() }, 5 * 60_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && passValid() && st().connected && Date.now() - st().lastSyncAt > 2 * 60_000) soon(800)
  })
}

/** Reconnect (one tap) and sync what's waiting. */
export async function reconnect() { if (await getPass('quick')) await syncNow() }
