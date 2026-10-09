/**
 * Music videos for your library, automatically: songs in your playlists and Liked Songs get their
 * official music video looked up in the background (GET /api/mv, shared by every listener), so
 * Video mode switches to the real video straight away — no search, no wait.
 *
 * Answers are saved where Video mode looks first (`alt|v2|<id>|VIDEO`). The server finds a couple
 * of new songs per request within a daily budget, so a big library fills in over a few days.
 */
import { create } from 'zustand'
import { idbGet, idbSet } from '../lib/idb'
import type { Track } from '../lib/types'
import { likedIds, useLibrary } from '../state/library'
import { remember, trackRegistry } from '../state/tracks'
import { settings, useSettings } from '../state/settings'

const INDEX = 'mv|index|v1'
/** Songs without a video are asked about again after this long (a video may have been posted). */
const RECHECK_NONE = 14 * 86_400_000

/** id → [has a video, when we learned it]. */
type Index = Record<string, [0 | 1, number]>

export const useMusicVideos = create<{ index: Index; loaded: boolean; working: boolean }>()(() => ({ index: {}, loaded: false, working: false }))
const st = () => useMusicVideos.getState()

/** How many of these songs have their music video ready. */
export function videosReady(tracks: Track[]): { ready: number; total: number } {
  const idx = st().index
  let ready = 0
  let total = 0
  for (const t of tracks) {
    if (t.variant === 'VIDEO') { ready++; total++; continue }
    total++
    if (idx[t.id]?.[0] === 1) ready++
  }
  return { ready, total }
}

/** Songs in your playlists and likes that still need a music-video answer, playlists you edited most recently first. */
function wanted(): string[] {
  const { playlists } = useLibrary.getState()
  const idx = st().index
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    const t = trackRegistry.get(id)
    if (!t || t.variant === 'VIDEO' || !/^yt:/.test(id)) return
    const known = idx[id]
    if (known && (known[0] === 1 || Date.now() - known[1] < RECHECK_NONE)) return
    ids.push(id)
  }
  const lists = Object.values(playlists).filter((p) => !p.deleted).sort((a, b) => b.updatedAt - a.updatedAt)
  for (const p of lists) p.trackIds.forEach(add)
  likedIds().forEach(add)
  return ids
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveIndex() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void idbSet(INDEX, st().index, 'cache'), 1500)
}

/** One round: up to 50 songs. Returns whether the server still has more to find right now. */
async function round(): Promise<boolean> {
  const ids = wanted().slice(0, 50)
  if (!ids.length) return false
  const r = await fetch(`/api/mv?ids=${ids.map((id) => id.slice(3)).join(',')}`).catch(() => null)
  if (!r || !r.ok) return false
  const body = (await r.json().catch(() => null)) as { items?: Record<string, { alt: Track | null }>; pending?: string[] } | null
  if (!body?.items) return false
  const index = { ...st().index }
  const now = Date.now()
  let learned = 0
  for (const [ref, { alt }] of Object.entries(body.items)) {
    const id = `yt:${ref}`
    const song = trackRegistry.get(id)
    learned++
    if (alt && alt.playbackRef !== ref) {
      const video = { ...alt, genres: alt.genres ?? [], variant: 'VIDEO' } as Track
      remember(video)
      index[id] = [1, now]
      void idbSet(`alt|v2|${id}|VIDEO`, { alt: video, at: now }, 'cache')
      // And back again: Song mode on the video returns to this exact upload.
      if (song) void idbSet(`alt|v2|${video.id}|SONG`, { alt: song, at: now }, 'cache')
    } else if (alt) {
      index[id] = [1, now] // it is the music video already
    } else {
      index[id] = [0, now]
      void idbSet(`alt|v2|${id}|VIDEO`, { alt: null, at: now }, 'cache')
    }
  }
  useMusicVideos.setState({ index })
  saveIndex()
  return learned > 0 && (body.pending?.length ?? 0) > 0
}

let timer: ReturnType<typeof setTimeout> | null = null
function schedule(ms: number) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void run(), ms)
}

async function run() {
  timer = null
  if (!settings().autoVideos || document.hidden || navigator.onLine === false || st().working) { schedule(5 * 60_000); return }
  useMusicVideos.setState({ working: true })
  try {
    // While the server keeps finding new ones, keep going (gently); otherwise check back later.
    const more = await round()
    schedule(more ? 20_000 : 15 * 60_000)
  } catch {
    schedule(10 * 60_000)
  } finally {
    useMusicVideos.setState({ working: false })
  }
}

let started = false
export function startMusicVideos() {
  if (started) return
  started = true
  void idbGet<Index>(INDEX, 'cache').then((index) => { useMusicVideos.setState({ index: index ?? {}, loaded: true }); schedule(20_000) })
  // New songs in a playlist or new likes: look them up soon.
  let pending: ReturnType<typeof setTimeout> | null = null
  useLibrary.subscribe((s, p) => {
    if (s.playlists === p.playlists && s.likes === p.likes) return
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => { if (!st().working) schedule(1000) }, 8000)
  })
  useSettings.subscribe((s, p) => { if (s.autoVideos && !p.autoVideos) schedule(1000) })
}
