import { createPlayer, STATE, UNPLAYABLE_CODES, type YTPlayer } from './youtube'
import { currentTrack, player, usePlayer, useProgress } from '../state/player'
import { lib } from '../state/library'
import { settings } from '../state/settings'
import { ls } from '../lib/idb'
import { artistKey, type MediaVariant, type Track } from '../lib/types'
import { alternativeUpload, radioFor } from '../services/recs'
import { artworkFor } from '../lib/classify'
import { toast } from '../state/ui'
import { tuner } from '../lib/tuner'

let yt: YTPlayer | null = null
let currentKey: string | null = null
let currentId: string | null = null
let endedNaturally = false
let session: { track: Track; startedAt: number; listened: number } | null = null
let lastTick = performance.now()
let fadeToken = 0
let radioTried = new Set<string>()
const failedRefs = new Set<string>()
/** Song ↔ Video pairs found by the resolver, so switching back is free. */
const altPairs = new Map<string, Track>()
let positionSavedAt = 0
let started = false

let duckLevel: number | null = null
const targetVolume = () => (usePlayer.getState().muted ? 0 : Math.round(usePlayer.getState().volume * (duckLevel ?? 1)))

/** Lowers the music under a voice (AI DJ); null restores it. */
export function setDuck(level: number | null) {
  duckLevel = level
  if (yt) void fade(targetVolume(), level == null ? 700 : 300)
}

function fade(to: number, ms: number): Promise<void> {
  const token = ++fadeToken
  if (!yt) return Promise.resolve()
  const from = yt.getVolume?.() ?? to
  const steps = Math.max(1, Math.round(ms / 30))
  return new Promise((resolve) => {
    let i = 0
    const tick = () => {
      if (token !== fadeToken || !yt) return resolve()
      i++
      const v = from + (to - from) * (1 - Math.pow(1 - i / steps, 2))
      yt.setVolume(Math.round(v))
      if (i >= steps) return resolve()
      setTimeout(tick, 30)
    }
    tick()
  })
}

function finishSession(skipped: boolean) {
  const s = session
  session = null
  if (!s) return
  const listened = Math.round(s.listened)
  if (listened < 5000) return
  const duration = s.track.durationMs ?? (usePlayer.getState().duration || null)
  const completed = endedNaturally || (duration != null && listened >= duration * 0.8)
  tuner.observe(s.track.id, completed, skipped && !completed && listened < 30_000 + (duration ?? 0) / 3)
  lib().recordPlay({
    trackId: s.track.id,
    artistKey: artistKey(s.track.artist),
    startedAt: s.startedAt,
    listenedMs: listened,
    durationMs: duration,
    completed,
    skipped: skipped && !completed && listened < 30_000 + (duration ?? 0) / 3,
    source: 'YOUTUBE',
  })
}

function beginSession(track: Track) {
  session = { track, startedAt: Date.now(), listened: 0 }
  lastTick = performance.now()
}

async function load(track: Track, startSec: number, autoplay: boolean, smooth: boolean) {
  if (!yt) return
  const p = player()
  if (smooth && p.isPlaying && settings().crossfadeOnSkip && settings().motion !== 'off') await fade(0, 180)
  if (!yt) return
  currentId = track.id
  if (autoplay) {
    yt.setVolume(smooth && settings().crossfadeOnSkip ? 0 : targetVolume())
    yt.loadVideoById({ videoId: track.playbackRef, startSeconds: startSec })
  } else {
    yt.cueVideoById({ videoId: track.playbackRef, startSeconds: startSec })
  }
  useProgress.getState().set(startSec * 1000, 0)
  updateMediaSession(track)
}

function syncTrack(prevPlaying: boolean) {
  const s = usePlayer.getState()
  const it = s.queue[s.index]
  if (!it) {
    if (currentKey) { finishSession(true); currentKey = null; currentId = null; yt?.pauseVideo() }
    return
  }
  if (it.key !== currentKey) {
    finishSession(!endedNaturally)
    const sleep = s.sleep
    if (sleep?.mode === 'track' && currentKey) {
      usePlayer.getState().patch({ sleep: null, wantPlaying: false })
      toast('Sleep timer — paused at the end of the song')
    }
    endedNaturally = false
    currentKey = it.key
    beginSession(it.track)
    void load(it.track, 0, usePlayer.getState().wantPlaying, prevPlaying)
    usePlayer.getState().patch({ duration: it.track.durationMs ?? 0, issue: null })
  } else if (it.track.id !== currentId) {
    // Same queue slot, different upload (Song/Video switch or rescue): keep position and session.
    const pos = useProgress.getState().position / 1000
    if (session) session.track = it.track
    void load(it.track, Math.max(0, pos - 0.3), s.wantPlaying, false)
  }
}

// ── Hold-to-preview: ~15 s from a third of the way in; the queue and position come back after ──
let preview: { track: Track | null; posSec: number; wasPlaying: boolean; timer: ReturnType<typeof setTimeout> } | null = null

export function startPreview(t: Track) {
  if (!yt || preview) return
  const p = player()
  const cur = currentTrack()
  if (cur?.id === t.id) return
  preview = { track: cur, posSec: useProgress.getState().position / 1000, wasPlaying: p.isPlaying, timer: setTimeout(() => endPreview(), 15_000) }
  p.patch({ previewing: t })
  const start = Math.max(0, Math.floor((t.durationMs ?? 180_000) / 3000))
  void fade(0, 140).then(() => {
    if (!preview || !yt) return
    yt.loadVideoById({ videoId: t.playbackRef, startSeconds: start })
    yt.setVolume(0)
    void fade(targetVolume(), 500)
  })
}

export function endPreview() {
  const s = preview
  if (!s || !yt) return
  preview = null
  clearTimeout(s.timer)
  player().patch({ previewing: null })
  void fade(0, 160).then(() => {
    if (!yt) return
    if (s.track) void load(s.track, s.posSec, s.wasPlaying, false)
    else yt.stopVideo?.()
    if (!s.wasPlaying) player().patch({ isPlaying: false, wantPlaying: false })
    yt.setVolume(targetVolume())
  })
}
export const isPreviewing = () => preview != null

function onState(state: number) {
  if (preview) { if (state === STATE.ENDED) endPreview(); return }
  const p = player()
  if (state === STATE.PLAYING) {
    p.patch({ isPlaying: true, isBuffering: false, issue: null })
    if (!p.wantPlaying) p.patch({ wantPlaying: true })
    const d = (yt?.getDuration() ?? 0) * 1000
    if (d > 0 && Math.abs(d - p.duration) > 1500) p.patch({ duration: d })
    if (settings().crossfadeOnSkip) void fade(targetVolume(), 420)
    else yt?.setVolume(targetVolume())
  } else if (state === STATE.PAUSED) {
    p.patch({ isPlaying: false, isBuffering: false })
    if (p.wantPlaying) p.patch({ wantPlaying: false })
  } else if (state === STATE.BUFFERING) {
    p.patch({ isBuffering: true })
  } else if (state === STATE.ENDED) {
    endedNaturally = true
    p.patch({ isPlaying: false, isBuffering: false })
    const atEnd = p.index >= p.queue.length - 1 && p.repeat === 'off'
    if (atEnd && p.sleep?.mode === 'queue') p.patch({ sleep: null })
    p.next({ auto: true })
    // repeat-one or a single-item repeat-all keeps the same key: restart in place.
    const after = player()
    if (after.queue[after.index]?.key === currentKey && after.wantPlaying) {
      finishSession(false)
      endedNaturally = false
      if (after.queue[after.index]) beginSession(after.queue[after.index].track)
      yt?.seekTo(0, true)
      yt?.playVideo()
    }
  } else if (state === STATE.CUED) {
    p.patch({ isPlaying: false, isBuffering: false })
  }
}

const retried = new Set<string>()

async function onError(code: number) {
  const p = player()
  const t = currentTrack()
  if (!t) return
  console.warn('[Arnav Music] YouTube player error', code, t.playbackRef)
  // Already playing fine (a stale error from an earlier request): ignore.
  let state = -1
  try { state = yt?.getPlayerState() ?? -1 } catch { /* not ready */ }
  if (state === STATE.PLAYING || state === STATE.BUFFERING) return
  // Codes 2/5 are often transient (bad timing / HTML5 hiccup): retry the same video once.
  if ((code === 2 || code === 5) && !retried.has(t.playbackRef)) {
    retried.add(t.playbackRef)
    const pos = useProgress.getState().position / 1000
    setTimeout(() => { if (currentTrack()?.id === t.id) void load(t, pos, p.wantPlaying, false) }, 600)
    return
  }
  failedRefs.add(t.playbackRef)
  p.patch({ isPlaying: false, isBuffering: false, issue: { kind: 'unavailable', code, trackId: t.id, resolving: UNPLAYABLE_CODES.has(code) && settings().autoReplaceUnavailable } })
  if (UNPLAYABLE_CODES.has(code) && settings().autoReplaceUnavailable) await rescue(true)
}

/** "Find another upload" — one cached search, Topic channels preferred. */
export async function rescue(auto = false): Promise<boolean> {
  const p = player()
  const t = currentTrack()
  if (!t) return false
  p.patch({ issue: p.issue ? { ...p.issue, resolving: true } : { kind: 'unavailable', code: 150, trackId: t.id, resolving: true } })
  const alt = await alternativeUpload(t, t.variant ?? null, failedRefs).catch(() => null)
  const now = player()
  if (currentTrack()?.id !== t.id) return false
  if (alt) {
    now.patch({ issue: null, wantPlaying: true })
    now.replaceCurrent({ ...alt, title: t.title, artist: t.artist, album: t.album ?? alt.album })
    toast(auto ? 'Playing another upload of this song' : 'Found another upload')
    return true
  }
  now.patch({ issue: now.issue ? { ...now.issue, resolving: false } : null })
  return false
}

/** Song/Video switch (like YouTube Music). Keeps your position. */
export async function setMode(mode: MediaVariant) {
  const p = player()
  if (p.mode === mode) return
  p.patch({ mode })
  const t = currentTrack()
  if (!t || t.variant == null || t.variant === mode) return
  const paired = altPairs.get(t.id)
  if (paired) {
    p.replaceCurrent(paired)
    return
  }
  p.patch({ resolvingMode: true })
  try {
    const alt = await alternativeUpload(t, mode, failedRefs)
    if (alt && currentTrack()?.id === t.id && alt.variant === mode) {
      altPairs.set(t.id, alt)
      altPairs.set(alt.id, t)
      player().replaceCurrent(alt)
    } else if (!alt) {
      toast(mode === 'SONG' ? 'No audio-only upload found — showing artwork' : 'No music video found for this song')
    }
  } finally {
    player().patch({ resolvingMode: false })
  }
}

async function maybeRadio() {
  const p = player()
  const it = p.queue[p.index]
  if (!it || !settings().endlessRadio || p.repeat !== 'off' || p.radioLoading) return
  if (p.index < p.queue.length - 1 || radioTried.has(it.key)) return
  radioTried.add(it.key)
  p.patch({ radioLoading: true })
  try {
    const exclude = new Set(p.queue.map((q) => q.track.id))
    const recs = await radioFor(it.track, { exclude, limit: 15 })
    if (recs.length && player().queue[player().index]?.key === it.key) {
      player().addToQueue(recs.map((r) => r.track))
      if (!player().context?.includes('radio')) player().patch({ context: `${it.track.artist} radio` })
    }
  } finally {
    player().patch({ radioLoading: false })
  }
}

function tick() {
  if (!yt || preview) return
  const p = player()
  const now = performance.now()
  const dt = Math.min(1000, now - lastTick)
  lastTick = now
  let pos = 0
  try { pos = (yt.getCurrentTime?.() ?? 0) * 1000 } catch { /* player not ready */ }
  const frac = yt.getVideoLoadedFraction?.() ?? 0
  if (p.isPlaying) useProgress.getState().set(pos, frac)
  else if (Math.abs(useProgress.getState().position - pos) > 400 && pos > 0) useProgress.getState().set(pos, frac)
  if (p.isPlaying && !p.isBuffering && session) session.listened += dt * p.rate
  if (p.isPlaying && p.issue && pos > 0) p.patch({ issue: null })
  let yd = 0
  try { yd = (yt.getDuration?.() ?? 0) * 1000 } catch { /* not ready */ }
  if (yd > 0 && Math.abs(yd - p.duration) > 1500) p.patch({ duration: yd })
  const d = yd || p.duration
  if (p.isPlaying && d > 0 && pos > d * 0.5) void maybeRadio()
  if (p.sleep?.mode === 'time' && Date.now() >= p.sleep.endsAt) {
    p.patch({ sleep: null })
    void fade(0, 2500).then(() => { player().setPlaying(false); setTimeout(() => yt?.setVolume(targetVolume()), 400) })
    toast('Sleep timer — good night')
  }
  if (Date.now() - positionSavedAt > 4000 && currentKey) {
    positionSavedAt = Date.now()
    ls.set('arnav.position', { id: currentId, ms: pos })
  }
  if (navigator.mediaSession && 'setPositionState' in navigator.mediaSession && d > 0 && pos <= d) {
    try { navigator.mediaSession.setPositionState({ duration: d / 1000, position: Math.max(0, pos / 1000), playbackRate: p.rate }) } catch { /* ignore */ }
  }
}

function updateMediaSession(t: Track) {
  if (!('mediaSession' in navigator)) return
  const art = artworkFor(t)
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    album: t.album ?? 'Arnav Music',
    artwork: [
      { src: `https://i.ytimg.com/vi/${t.playbackRef}/mqdefault.jpg`, sizes: '320x180', type: 'image/jpeg' },
      { src: art, sizes: '1280x720', type: 'image/jpeg' },
    ],
  })
}

function bindMediaSession() {
  if (!('mediaSession' in navigator)) return
  const ms = navigator.mediaSession
  const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h) } catch { /* unsupported */ } }
  set('play', () => player().setPlaying(true))
  set('pause', () => player().setPlaying(false))
  set('nexttrack', () => player().next())
  set('previoustrack', () => player().prev(useProgress.getState().position))
  set('seekto', (d) => { if (d.seekTime != null) player().seek(d.seekTime * 1000) })
  set('seekforward', (d) => player().seek(useProgress.getState().position + (d.seekOffset ?? 10) * 1000))
  set('seekbackward', (d) => player().seek(useProgress.getState().position - (d.seekOffset ?? 10) * 1000))
}

function updateTitle() {
  const t = currentTrack()
  const p = player()
  document.title = t && (p.isPlaying || p.wantPlaying) ? `${t.title} · ${t.artist}` : 'Arnav Music'
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p.isPlaying ? 'playing' : 'paused'
}

/** Mounts the official YouTube player into [host] and wires it to the store. Idempotent. */
export async function startController(host: HTMLElement) {
  if (started) return
  started = true
  bindMediaSession()
  try {
    yt = await createPlayer(host, {
      onReady: () => undefined,
      onState,
      onError: (c) => void onError(c),
      onAutoplayBlocked: () => { player().patch({ wantPlaying: false, isPlaying: false }); toast('Press play to start — your browser blocked autoplay') },
    })
  } catch (e) {
    started = false
    toast(e instanceof Error ? e.message : 'The YouTube player couldn’t load.')
    return
  }
  player().patch({ engineReady: true })
  yt.setVolume(targetVolume())

  // Restore the last queue position without autoplaying.
  const s = usePlayer.getState()
  const it = s.queue[s.index]
  if (it) {
    const saved = ls.get<{ id: string; ms: number } | null>('arnav.position', null)
    const startSec = saved && saved.id === it.track.id ? Math.max(0, saved.ms / 1000 - 1) : 0
    currentKey = it.key
    beginSession(it.track)
    void load(it.track, startSec, false, false)
    usePlayer.getState().patch({ duration: it.track.durationMs ?? 0 })
  }

  usePlayer.subscribe((st, prev) => {
    if (st.queue !== prev.queue || st.index !== prev.index) {
      if (st.queue[st.index]?.key !== prev.queue[prev.index]?.key) radioTried = new Set([...radioTried].slice(-50))
      syncTrack(prev.isPlaying)
    }
    if (st.wantPlaying !== prev.wantPlaying && yt) {
      if (st.wantPlaying) {
        if (!currentKey && st.queue[st.index]) syncTrack(false)
        yt.playVideo()
      } else yt.pauseVideo()
    }
    if (st.seekRequest && st.seekRequest !== prev.seekRequest && yt) {
      yt.seekTo(st.seekRequest.ms / 1000, true)
      useProgress.getState().set(st.seekRequest.ms)
      if (st.wantPlaying) yt.playVideo()
    }
    if ((st.volume !== prev.volume || st.muted !== prev.muted) && yt) {
      fadeToken++
      yt.setVolume(targetVolume())
    }
    if (st.rate !== prev.rate && yt) yt.setPlaybackRate(st.rate)
    if (st.isPlaying !== prev.isPlaying || st.index !== prev.index || st.wantPlaying !== prev.wantPlaying) updateTitle()
  })
  setInterval(tick, 250)
  window.addEventListener('pagehide', () => finishSession(true))
}
