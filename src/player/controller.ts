import { createPlayer, STATE, UNPLAYABLE_CODES, type YTPlayer } from './youtube'
import { currentTrack, player, usePlayer, useProgress, type QueueItem } from '../state/player'
import { lib } from '../state/library'
import { defaultAutomix, settings, type AutomixStyle } from '../state/settings'
import { prefs } from '../state/prefs'
import { ls } from '../lib/idb'
import { artistKey, type MediaVariant, type Track } from '../lib/types'
import { alternativeUpload, radioFor } from '../services/recs'
import { artworkFor } from '../lib/classify'
import { toast } from '../state/ui'
import { tuner } from '../lib/tuner'
import { setDeckView } from './VideoHost'

/** Two decks: the active one plays the current song; the other preloads the next for automix. */
const decks: (YTPlayer | null)[] = [null, null]
let activeDeck = 0
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

/** iOS plays one media element at a time: there, songs hand over on a single deck. */
const singleDeck = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

let duckLevel: number | null = null
const targetVolume = () => (usePlayer.getState().muted ? 0 : Math.round(usePlayer.getState().volume * (duckLevel ?? 1)))

/** Lowers the music under a voice (AI DJ); null restores it. */
export function setDuck(level: number | null) {
  duckLevel = level
  if (yt && !mix) void fade(targetVolume(), level == null ? 700 : 300)
}

function fade(to: number, ms: number): Promise<void> {
  const token = ++fadeToken
  if (!yt) return Promise.resolve()
  const p = yt
  const from = p.getVolume?.() ?? to
  const steps = Math.max(1, Math.round(ms / 30))
  return new Promise((resolve) => {
    let i = 0
    const tick = () => {
      if (token !== fadeToken || yt !== p) return resolve()
      i++
      const v = from + (to - from) * (1 - Math.pow(1 - i / steps, 2))
      p.setVolume(Math.round(v))
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

// ── Automix ─────────────────────────────────────────────────────────────────
interface Mix {
  key: string
  track: Track
  deck: number
  phase: 'preloading' | 'ready' | 'mixing'
  fadeMs: number
  /** Position in the outgoing song where the next one starts. */
  startAt: number
  token: number
}
let mix: Mix | null = null
let mixToken = 0
/** Queue key the engine already started on the other deck (so syncTrack doesn't reload it). */
let handoffKey: string | null = null

/** The style for what's playing: the playlist's own, else the default (app-synced). */
export function automixStyle(): AutomixStyle {
  const id = usePlayer.getState().contextId
  return (id && prefs().playlistAutomix[id]) || defaultAutomix()
}

function upcoming(): QueueItem | null {
  const p = usePlayer.getState()
  if (p.repeat === 'one') return null
  if (p.index < p.queue.length - 1) return p.queue[p.index + 1]
  return p.repeat === 'all' && p.queue.length > 1 ? p.queue[0] : null
}

/** When and how long the hand-over is, for this pair of songs. Exported for tests/UI. */
export function transitionPlan(cur: Track, next: Track, style: AutomixStyle, durationMs: number, crossfadeMs = settings().crossfadeMs || 6000): { fadeMs: number; startAt: number } {
  const micro = 250
  const gapless = { fadeMs: micro, startAt: durationMs - micro - 150 }
  if (style === 'gapless' || style === 'off') return gapless
  if (style === 'crossfade') {
    const f = Math.min(crossfadeMs, durationMs * 0.25)
    return { fadeMs: f, startAt: durationMs - f }
  }
  // Smart: songs of one album played in order run into each other (live albums, DJ mixes).
  if (cur.album && next.album && cur.album === next.album && !cur.compilation) return gapless
  const e1 = cur.energy ?? 0.5
  const e2 = next.energy ?? 0.5
  let f = crossfadeMs
  if (Math.abs(e1 - e2) > 0.35) f *= 0.6 // a big change of mood: get there quickly
  if (e1 > 0.7 && e2 > 0.7) f *= 0.75 // two bangers: keep the energy
  if (e1 < 0.35 && e2 < 0.45) f *= 1.3 // calm: a long, soft blend
  f = Math.max(1500, Math.min(12_000, f, durationMs * 0.25))
  // Music videos often end on a quiet outro or credits: start a little before them.
  const tail = cur.variant === 'VIDEO' ? Math.min(3000, durationMs * 0.03) : 0
  return { fadeMs: Math.round(f), startAt: Math.round(durationMs - f - tail) }
}

function cancelMix() {
  if (!mix) return
  const m = mix
  mix = null
  mixToken++
  const sb = decks[m.deck]
  if (sb && m.deck !== activeDeck) { try { sb.mute(); sb.pauseVideo() } catch { /* ignore */ } }
  setDeckView(activeDeck, null)
}

function preload(next: QueueItem, plan: { fadeMs: number; startAt: number }) {
  const deck = 1 - activeDeck
  const sb = decks[deck]
  if (!sb || failedRefs.has(next.track.playbackRef)) return
  mix = { key: next.key, track: next.track, deck, phase: 'preloading', fadeMs: plan.fadeMs, startAt: plan.startAt, token: ++mixToken }
  try {
    sb.mute()
    sb.setVolume(0)
    sb.setPlaybackRate(usePlayer.getState().rate)
    sb.loadVideoById({ videoId: next.track.playbackRef, startSeconds: 0 })
  } catch { mix = null }
}

/** Starts the next song on the other deck and blends the two (equal-power curve). */
function beginMix(instant = false) {
  const m = mix
  if (!m || m.phase !== 'ready') return
  const incoming = decks[m.deck]
  const outgoing = yt
  if (!incoming || !outgoing) { cancelMix(); return }
  m.phase = 'mixing'
  const fadeMs = instant ? 0 : m.fadeMs
  try {
    incoming.setVolume(fadeMs ? 0 : targetVolume())
    incoming.unMute()
    incoming.playVideo()
  } catch { cancelMix(); return }
  // Hand the queue over now (Apple-style: the new song is "now playing" as it fades in).
  activeDeck = m.deck
  yt = incoming
  handoffKey = m.key
  endedNaturally = true
  player().next({ auto: true })
  const token = m.token
  const t0 = performance.now()
  const step = () => {
    if (!mix || mix.token !== token) return
    const t = fadeMs ? Math.min(1, (performance.now() - t0) / fadeMs) : 1
    const vol = targetVolume()
    try {
      incoming.setVolume(Math.round(vol * Math.sin((t * Math.PI) / 2)))
      outgoing.setVolume(Math.round(vol * Math.cos((t * Math.PI) / 2)))
    } catch { /* deck went away */ }
    setDeckView(activeDeck, t < 1 ? t : null)
    if (t < 1) { setTimeout(step, 30); return }
    try { outgoing.mute(); outgoing.pauseVideo() } catch { /* ignore */ }
    mix = null
    setDeckView(activeDeck, null)
  }
  step()
}

function planAutomix(pos: number, d: number) {
  if (singleDeck || !decks[1] || preview) return
  const style = automixStyle()
  if (style === 'off') { if (mix && mix.phase !== 'mixing') cancelMix(); return }
  const cur = currentTrack()
  const next = upcoming()
  if (!cur || !next) { if (mix && mix.phase !== 'mixing') cancelMix(); return }
  if (mix?.phase === 'mixing') return
  const plan = transitionPlan(cur, next.track, style, d)
  if (mix && mix.key !== next.key) cancelMix() // the queue changed under us
  if (!mix && pos >= plan.startAt - 25_000 && pos < plan.startAt) preload(next, plan)
  if (mix) { mix.startAt = plan.startAt; mix.fadeMs = plan.fadeMs }
  if (mix?.phase === 'ready' && pos >= mix.startAt) beginMix()
}

// ── Loading ─────────────────────────────────────────────────────────────────
async function load(track: Track, startSec: number, autoplay: boolean, smooth: boolean) {
  if (!yt) return
  const p = player()
  if (smooth && p.isPlaying && settings().crossfadeOnSkip && settings().motion !== 'off') await fade(0, 180)
  if (!yt) return
  currentId = track.id
  if (autoplay) {
    yt.setVolume(smooth && settings().crossfadeOnSkip ? 0 : targetVolume())
    yt.unMute()
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
    if (currentKey) { cancelMix(); finishSession(true); currentKey = null; currentId = null; yt?.pauseVideo() }
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
    usePlayer.getState().patch({ duration: it.track.durationMs ?? 0, issue: null })
    if (handoffKey === it.key) {
      // Already playing on the other deck (automix).
      handoffKey = null
      currentId = it.track.id
      useProgress.getState().set(0, 0)
      updateMediaSession(it.track)
      return
    }
    handoffKey = null
    settleMix()
    void load(it.track, 0, usePlayer.getState().wantPlaying, prevPlaying)
  } else if (it.track.id !== currentId) {
    // Same queue slot, different upload (Song/Video switch or rescue): keep position and session.
    cancelMix()
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
  cancelMix()
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

/** States from the standby deck only matter while it preloads the next song. */
function onStandbyState(deck: number, state: number) {
  if (!mix || mix.deck !== deck || mix.phase !== 'preloading') return
  const sb = decks[deck]
  if (state === STATE.PLAYING && sb) {
    // Buffered and ready: hold at the start, silent, until the hand-over.
    try { sb.pauseVideo(); sb.seekTo(0, true) } catch { /* ignore */ }
    mix.phase = 'ready'
  }
}

function onState(deck: number, state: number) {
  if (deck !== activeDeck) { onStandbyState(deck, state); return }
  if (preview) { if (state === STATE.ENDED) endPreview(); return }
  const p = player()
  if (state === STATE.PLAYING) {
    p.patch({ isPlaying: true, isBuffering: false, issue: null })
    if (!p.wantPlaying) p.patch({ wantPlaying: true })
    const d = (yt?.getDuration() ?? 0) * 1000
    if (d > 0 && Math.abs(d - p.duration) > 1500) p.patch({ duration: d })
    if (mix?.phase === 'mixing') return // the blend sets the volume
    if (settings().crossfadeOnSkip) void fade(targetVolume(), 420)
    else yt?.setVolume(targetVolume())
  } else if (state === STATE.PAUSED) {
    if (mix?.phase === 'mixing') return
    p.patch({ isPlaying: false, isBuffering: false })
    if (p.wantPlaying) p.patch({ wantPlaying: false })
  } else if (state === STATE.BUFFERING) {
    p.patch({ isBuffering: true })
  } else if (state === STATE.ENDED) {
    // The next song is already buffered on the other deck: switch instantly (gapless).
    if (mix?.phase === 'ready' && mix.key === upcoming()?.key) { beginMix(true); return }
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

async function onError(deck: number, code: number) {
  if (deck !== activeDeck) {
    // The next song can't play here: forget the preload; the normal path will rescue it.
    if (mix && mix.deck === deck) { failedRefs.add(mix.track.playbackRef); cancelMix() }
    return
  }
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
  if (p.isPlaying && !p.isBuffering && d > 0) planAutomix(pos, d)
  if (p.sleep?.mode === 'time' && Date.now() >= p.sleep.endsAt) {
    p.patch({ sleep: null })
    cancelMix()
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

/** Finishes a running blend at once (pause / seek during a crossfade). */
function settleMix() {
  if (mix?.phase !== 'mixing') { if (mix) cancelMix(); return }
  const out = decks[1 - activeDeck]
  mix = null
  mixToken++
  try { out?.mute(); out?.pauseVideo(); yt?.setVolume(targetVolume()) } catch { /* ignore */ }
  setDeckView(activeDeck, null)
}

/** Mounts the official YouTube players into the two hosts and wires them to the store. Idempotent. */
export async function startController(hostA: HTMLElement, hostB: HTMLElement) {
  if (started) return
  started = true
  bindMediaSession()
  try {
    decks[0] = await createPlayer(hostA, {
      onReady: () => undefined,
      onState: (s) => onState(0, s),
      onError: (c) => void onError(0, c),
      onAutoplayBlocked: () => { player().patch({ wantPlaying: false, isPlaying: false }); toast('Press play to start — your browser blocked autoplay') },
    })
  } catch (e) {
    started = false
    toast(e instanceof Error ? e.message : 'The YouTube player couldn’t load.')
    return
  }
  yt = decks[0]
  activeDeck = 0
  player().patch({ engineReady: true })
  yt.setVolume(targetVolume())
  // The second deck loads in the background; automix waits for it.
  if (!singleDeck) {
    void createPlayer(hostB, {
      onReady: (p) => { try { p.mute() } catch { /* ignore */ } },
      onState: (s) => onState(1, s),
      onError: (c) => void onError(1, c),
    }).then((p) => { decks[1] = p }).catch(() => undefined)
  }

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
      } else { settleMix(); yt.pauseVideo() }
    }
    if (st.seekRequest && st.seekRequest !== prev.seekRequest && yt) {
      settleMix()
      yt.seekTo(st.seekRequest.ms / 1000, true)
      useProgress.getState().set(st.seekRequest.ms)
      if (st.wantPlaying) yt.playVideo()
    }
    if ((st.volume !== prev.volume || st.muted !== prev.muted) && yt && mix?.phase !== 'mixing') {
      fadeToken++
      yt.setVolume(targetVolume())
    }
    if (st.rate !== prev.rate) for (const d of decks) d?.setPlaybackRate(st.rate)
    if (st.isPlaying !== prev.isPlaying || st.index !== prev.index || st.wantPlaying !== prev.wantPlaying) updateTitle()
  })
  setInterval(tick, 250)
  // Read-only engine state for support/debugging (window.__arnavEngine()).
  ;(window as unknown as { __arnavEngine: () => unknown }).__arnavEngine = () => ({
    activeDeck, mix: mix && { phase: mix.phase, key: mix.key, fadeMs: mix.fadeMs, startAt: mix.startAt, deck: mix.deck }, style: automixStyle(), singleDeck,
    decks: decks.map((d) => { try { return d ? { state: d.getPlayerState(), t: Math.round(d.getCurrentTime()), vol: d.getVolume(), muted: d.isMuted(), id: d.getVideoData?.().video_id } : null } catch { return 'n/a' } }),
  })
  window.addEventListener('pagehide', () => finishSession(true))
}
