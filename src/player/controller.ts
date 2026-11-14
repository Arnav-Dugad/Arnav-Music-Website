import { createPlayer, STATE, UNPLAYABLE_CODES, type YTPlayer } from './youtube'
import { currentTrack, player, usePlayer, useProgress, type QueueItem } from '../state/player'
import { lib } from '../state/library'
import { defaultAutomix, settings, type AutomixStyle } from '../state/settings'
import { prefs } from '../state/prefs'
import { idbGet, idbSet, ls } from '../lib/idb'
import { ytQuotaState } from '../lib/youtube'
import { remember } from '../state/tracks'
import { artistKey, type MediaVariant, type Track } from '../lib/types'
import { alternativeUpload, radioFor } from '../services/recs'
import { artworkFor } from '../lib/classify'
import { toast } from '../state/ui'
import { tuner } from '../lib/tuner'
import { setDeckView, setVideoVeil } from './VideoHost'
import { glassCrossfade } from '../lib/liquidGlass'
import { recordHeard, recordPlay, recordRewind, recordSkip } from '../lib/replayMap'
import { maybePickNext } from '../services/moodAutomix'

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
/** Last known position of the current song (replay map). */
let lastPos = 0
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
  if (skipped && !completed && duration) recordSkip(s.track.id, lastPos, duration)
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
  lastPos = 0
  recordPlay(track.id)
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
const SLEEP_FADE_MS = 30_000
let sleepFading = false
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
  const track = videoFirst(next.track) ?? next.track
  mix = { key: next.key, track, deck, phase: 'preloading', fadeMs: plan.fadeMs, startAt: plan.startAt, token: ++mixToken }
  try {
    sb.mute()
    sb.setVolume(0)
    sb.setPlaybackRate(usePlayer.getState().rate)
    sb.loadVideoById({ videoId: track.playbackRef, startSeconds: 0 })
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
  glassCrossfade(fadeMs)
  // Hand the queue over now (Apple-style: the new song is "now playing" as it fades in).
  activeDeck = m.deck
  yt = incoming
  handoffKey = m.key
  endedNaturally = true
  player().next({ auto: true })
  // The deck may be playing the music video of the queued song (Video mode).
  if (currentTrack()?.id !== m.track.id && player().queue[player().index]?.key === m.key) {
    currentId = m.track.id
    if (session) session.track = m.track
    player().replaceCurrent(m.track)
    updateMediaSession(m.track)
  }
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
  if (singleDeck || !decks[1] || preview || swap || swapFading) return
  const style = automixStyle()
  if (style === 'off') { if (mix && mix.phase !== 'mixing') cancelMix(); return }
  const cur = currentTrack()
  const next = upcoming()
  if (!cur || !next) { if (mix && mix.phase !== 'mixing') cancelMix(); return }
  if (mix?.phase === 'mixing') return
  const plan = transitionPlan(cur, next.track, style, d)
  // Smart: before preloading, let mood-matching choose which song comes next.
  if (style === 'smart' && !mix && pos >= plan.startAt - 38_000 && pos < plan.startAt - 26_000) { void maybePickNext(); return }
  if (mix && mix.key !== next.key) cancelMix() // the queue changed under us
  if (!mix && pos >= plan.startAt - 25_000 && pos < plan.startAt) preload(next, plan)
  if (mix) { mix.startAt = plan.startAt; mix.fadeMs = plan.fadeMs }
  if (mix?.phase === 'ready' && pos >= mix.startAt) beginMix()
}

/**
 * Now and then a freshly loaded video sits unstarted (a slow embed, a dropped play request).
 * If the song that should be playing hasn't started after a few seconds, ask again.
 */
let startWatch: ReturnType<typeof setTimeout> | null = null
/** When the active deck was asked to load and play a video (0 once it plays). */
let loadingSince = 0
function watchStart(id: string, tries = 2) {
  if (startWatch) clearTimeout(startWatch)
  startWatch = setTimeout(() => {
    if (currentId !== id || !yt || preview || !player().wantPlaying) return
    let st = -2
    try { st = yt.getPlayerState() } catch { /* not ready */ }
    if (st !== STATE.UNSTARTED && st !== STATE.CUED) return
    try { yt.playVideo() } catch { /* ignore */ }
    if (tries > 1) watchStart(id, tries - 1)
  }, 3000)
}

/**
 * YouTube draws its own title, "More videos" and pause overlays over a video that's starting or
 * paused. Until they're gone the frame shows the song's artwork instead (VideoHost fades between).
 */
let veilRef: string | null = null
let videoStartedAt = 0
const VEIL_START_MS = 3500
function updateVeil() {
  if (!yt) return
  let st = -1
  try { st = yt.getPlayerState() } catch { /* not ready */ }
  const ref = currentTrack()?.playbackRef ?? null
  if (st === STATE.PLAYING && ref !== veilRef) { veilRef = ref; videoStartedAt = performance.now() }
  const playing = st === STATE.PLAYING || st === STATE.BUFFERING
  setVideoVeil(!playing || ref !== veilRef || performance.now() - videoStartedAt < VEIL_START_MS)
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
    loadingSince = performance.now()
    watchStart(track.id)
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
    const v = videoFirst(it.track)
    if (v) {
      currentId = v.id
      if (session) session.track = v
      usePlayer.getState().replaceCurrent(v)
    }
    void load(v ?? it.track, 0, usePlayer.getState().wantPlaying, prevPlaying)
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

/**
 * Plays a short clip of [t] from a third of the way in; what was playing comes back after.
 * Called again while a clip plays, it switches to the new song and keeps the original to return
 * to (Samples swipes from clip to clip). [ms] is how long the clip lasts.
 */
export function startPreview(t: Track, ms = 15_000) {
  if (!yt) return
  const p = player()
  const cur = currentTrack()
  if (cur?.id === t.id && !preview) return
  cancelMix()
  if (preview) { clearTimeout(preview.timer); preview.timer = setTimeout(() => endPreview(), ms) }
  else preview = { track: cur, posSec: useProgress.getState().position / 1000, wasPlaying: p.isPlaying, timer: setTimeout(() => endPreview(), ms) }
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
  if (swap?.deck === deck) return // a Song/Video switch is syncing there (polled)
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
    loadingSince = 0
    p.patch({ isPlaying: true, isBuffering: false, issue: null })
    if (!p.wantPlaying) p.patch({ wantPlaying: true })
    const d = (yt?.getDuration() ?? 0) * 1000
    if (d > 0 && Math.abs(d - p.duration) > 1500) p.patch({ duration: d })
    if (mix?.phase === 'mixing' || swapFading) return // the blend sets the volume
    if (settings().crossfadeOnSkip) void fade(targetVolume(), 420)
    else yt?.setVolume(targetVolume())
  } else if (state === STATE.PAUSED) {
    if (mix?.phase === 'mixing') return
    // A video on its way in can report "paused" before it starts; that isn't you pausing.
    if (loadingSince && performance.now() - loadingSince < 10_000 && p.wantPlaying) { try { yt?.playVideo() } catch { /* ignore */ } return }
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
/**
 * Song / Video, like YouTube Music: Song shows the artwork, Video plays the song's real music
 * video. An audio upload (a Topic "art track" is just the cover as a video) is swapped for the
 * official music video; a music video is swapped for the audio release in Song mode when one
 * exists. Each pair is found once per browser (and the edge cache shares the search).
 */
export async function setMode(mode: MediaVariant, quiet = false) {
  const p = player()
  if (p.mode !== mode) p.patch({ mode })
  // Changed your mind mid-switch: drop the switch that's still lining up.
  if (swap && swap.track.variant !== mode) cancelSwap()
  const t = currentTrack()
  if (!t) return
  // Already the right kind of upload (an unknown kind counts as a video only when it isn't an art track).
  if (t.variant === mode || (mode === 'VIDEO' && t.variant == null && !/- Topic$/i.test(t.channelTitle ?? ''))) return
  if (mode === 'SONG' && t.variant == null) return
  const alt = await counterpart(t, mode)
  if (currentTrack()?.id !== t.id || player().mode !== mode) return
  if (alt) { switchUpload(alt); return }
  if (mode === 'VIDEO') {
    noVideo.add(t.id)
    // You asked for the video: say so and go back to Song. Automatic switches just show the artwork.
    if (!quiet) { player().patch({ mode: 'SONG' }); toast('This song has no music video — showing the artwork') }
  } else if (!quiet) toast('No audio-only upload found — showing the artwork over the video’s sound')
}

// ── Seamless Song ↔ Video ───────────────────────────────────────────────────
/**
 * The other upload starts silently on the standby deck, is brought to exactly the same moment
 * (seeks that learn how long a seek takes), and then the two are blended in ~0.6 s: no gap, no
 * jump. Paused, on iOS (one media element) or before the second deck exists, it simply reloads.
 */
interface Swap { track: Track; deck: number; token: number; tries: number; lead: number; seekedAt: number; seekTarget: number; best: number; started: number; firstPlaying: number; poll: ReturnType<typeof setInterval> | null }
let swap: Swap | null = null
let swapToken = 0
/** True while a swap blend runs (the blend owns the volume). */
let swapFading = false
let blendToken = 0
/** How the last switch landed (debug: window.__arnavEngine()). */
let lastSwap: { drift: number; tries: number; ms: number } | null = null
let blendOut: YTPlayer | null = null
const SWAP_FADE_MS = 600
const SWAP_TOLERANCE = 0.07

/**
 * The IFrame API reports the time only every so often; between reports it is extrapolated from the
 * moment the value last changed, so two decks can be compared to a few hundredths of a second.
 */
const clocks = new WeakMap<YTPlayer, { v: number; at: number }>()
function clock(p: YTPlayer): number {
  let v = 0
  try { v = p.getCurrentTime() } catch { return 0 }
  const now = performance.now()
  const c = clocks.get(p)
  if (!c || c.v !== v) { clocks.set(p, { v, at: now }); return v }
  let playing = false
  try { playing = p.getPlayerState() === STATE.PLAYING } catch { /* not ready */ }
  return playing ? v + Math.min(0.6, (now - c.at) / 1000) * usePlayer.getState().rate : v
}

function switchUpload(alt: Track) {
  const p = player()
  const deck = 1 - activeDeck
  const sb = decks[deck]
  cancelSwap()
  settleSwap()
  if (singleDeck || !sb || !yt || preview || !p.isPlaying) { p.replaceCurrent(alt); return }
  settleMix()
  const pos = clock(yt)
  const s: Swap = { track: alt, deck, token: ++swapToken, tries: 0, lead: 0.25, seekedAt: 0, seekTarget: 0, best: Infinity, started: performance.now(), firstPlaying: 0, poll: null }
  swap = s
  p.patch({ resolvingMode: true })
  try {
    sb.mute()
    sb.setVolume(0)
    sb.setPlaybackRate(p.rate)
    // It takes a moment to start: begin a little ahead of where the song will be by then.
    sb.loadVideoById({ videoId: alt.playbackRef, startSeconds: pos + 0.9 })
  } catch { cancelSwap(); p.replaceCurrent(alt); return }
  s.poll = setInterval(() => syncSwap(s), 40)
}

/** Ends a swap that hasn't blended yet. [fallback] finishes the switch the plain way. */
function cancelSwap(fallback = false) {
  const s = swap
  if (!s) return
  swap = null
  swapToken++
  if (s.poll) clearInterval(s.poll)
  const sb = decks[s.deck]
  if (sb && s.deck !== activeDeck) { try { sb.mute(); sb.pauseVideo() } catch { /* ignore */ } }
  player().patch({ resolvingMode: false })
  if (fallback && currentTrack() && player().mode === (s.track.variant ?? player().mode)) player().replaceCurrent(s.track)
}

function syncSwap(s: Swap) {
  if (swap !== s || !yt) return
  const sb = decks[s.deck]
  if (!sb) { cancelSwap(true); return }
  if (s.track.variant && player().mode !== s.track.variant) { cancelSwap(); return }
  // Taking too long (a slow network): switch the plain way rather than keep you waiting.
  if (performance.now() - s.started > 9000) { cancelSwap(true); return }
  let state = -1
  try { state = sb.getPlayerState() } catch { /* not ready */ }
  if (state !== STATE.PLAYING) return
  const now = performance.now()
  if (!s.firstPlaying) s.firstPlaying = now
  if (s.seekedAt && now - s.seekedAt < 260) return // let the seek land
  const target = clock(yt)
  const at = clock(sb)
  const drift = at - target
  if (s.seekedAt) {
    // Learn how far behind a seek lands, and aim that much further ahead next time.
    s.lead = Math.max(0, Math.min(1.5, s.lead - drift))
    s.seekedAt = 0
  }
  s.best = Math.min(s.best, Math.abs(drift))
  const longer = (sb.getDuration?.() ?? 0) > 0 && target > sb.getDuration() - 2
  if (Math.abs(drift) <= SWAP_TOLERANCE || s.tries >= 5 || longer) { lastSwap = { drift: Math.round(drift * 1000), tries: s.tries, ms: Math.round(now - s.started) }; blendSwap(s); return }
  // Ahead by a little: wait for the song to catch up rather than seeking (seeks can stall).
  if (drift > 0 && drift < 0.5 && s.tries > 0) {
    s.tries++
    try { sb.pauseVideo() } catch { /* ignore */ }
    s.seekedAt = now
    setTimeout(() => { if (swap === s) { try { sb.playVideo() } catch { /* ignore */ } } }, Math.round((drift / usePlayer.getState().rate) * 1000))
    return
  }
  s.tries++
  s.seekedAt = now
  s.seekTarget = target + s.lead
  try { sb.seekTo(s.seekTarget, true) } catch { /* ignore */ }
}

function blendSwap(s: Swap) {
  if (s.poll) clearInterval(s.poll)
  swap = null
  const incoming = decks[s.deck]
  const outgoing = yt
  if (!incoming || !outgoing) { player().replaceCurrent(s.track); player().patch({ resolvingMode: false }); return }
  const fadeMs = settings().motion === 'off' ? 120 : SWAP_FADE_MS
  try { incoming.setVolume(0); incoming.unMute() } catch { /* ignore */ }
  activeDeck = s.deck
  yt = incoming
  currentId = s.track.id
  if (session) session.track = s.track
  updateMediaSession(s.track)
  swapFading = true
  blendOut = outgoing
  // YouTube's overlay restarts with every seek of the line-up: count from the hand-over.
  veilRef = s.track.playbackRef
  videoStartedAt = performance.now()
  player().replaceCurrent(s.track)
  player().patch({ resolvingMode: false, isPlaying: true, isBuffering: false })
  const t0 = performance.now()
  const token = ++blendToken
  const step = () => {
    if (token !== blendToken) return
    const t = Math.min(1, (performance.now() - t0) / fadeMs)
    const vol = targetVolume()
    try {
      incoming.setVolume(Math.round(vol * Math.sin((t * Math.PI) / 2)))
      outgoing.setVolume(Math.round(vol * Math.cos((t * Math.PI) / 2)))
    } catch { /* deck went away */ }
    setDeckView(activeDeck, t < 1 ? t : null)
    if (t < 1) { setTimeout(step, 25); return }
    settleSwap()
  }
  step()
}

/** Finishes a running Song/Video blend at once. */
function settleSwap() {
  if (!swapFading) return
  blendToken++
  swapFading = false
  try { blendOut?.mute(); blendOut?.pauseVideo(); yt?.setVolume(targetVolume()) } catch { /* ignore */ }
  blendOut = null
  setDeckView(activeDeck, null)
}

/** Finds the other upload ahead of time (Now Playing open, quota healthy) so the switch is instant. */
const prefetched = new Set<string>()
function prefetchCounterpart(t: Track | null | undefined, mode: MediaVariant) {
  if (!t || t.variant === mode || prefetched.has(`${t.id}|${mode}`) || noVideo.has(t.id) || ytQuotaState() !== 'NORMAL') return
  if (mode === 'SONG' && t.variant == null) return
  if (mode === 'VIDEO' && t.variant == null && !/- Topic$/i.test(t.channelTitle ?? '')) return
  prefetched.add(`${t.id}|${mode}`)
  void counterpart(t, mode, true).then((alt) => { if (!alt && mode === 'VIDEO') noVideo.add(t.id) })
}

/** Now Playing (or the docked player) is on screen, so a video would be seen. */
const videoVisible = () => player().expanded || (settings().dockedPlayer && matchMedia('(min-width: 1024px)').matches)

/** In Video mode, a song's music video when it's already known (so it can start on it). */
function videoFirst(t: Track): Track | null {
  if (player().mode !== 'VIDEO' || t.variant === 'VIDEO' || noVideo.has(t.id) || !videoVisible()) return null
  return altPairs.get(`${t.id}|VIDEO`) ?? null
}

/** Warms the other upload of what's playing (pointer on the Song/Video switch). */
export function warmMode(mode: MediaVariant) { prefetchCounterpart(currentTrack(), mode) }

/** Songs known to have no music video (Video mode shows their artwork instead of asking again). */
const noVideo = new Set<string>()
export const hasNoVideo = (id: string) => noVideo.has(id)

async function counterpart(t: Track, mode: MediaVariant, background = false): Promise<Track | null> {
  const paired = altPairs.get(`${t.id}|${mode}`)
  if (paired) return paired
  const key = `alt|v2|${t.id}|${mode}`
  const saved = await idbGet<{ alt: Track | null; at: number }>(key, 'cache')
  if (saved && (saved.alt || Date.now() - saved.at < 3 * 86_400_000)) {
    if (saved.alt) { remember(saved.alt); altPairs.set(`${t.id}|${mode}`, saved.alt); altPairs.set(`${saved.alt.id}|${t.variant ?? (mode === 'VIDEO' ? 'SONG' : 'VIDEO')}`, t) }
    return saved.alt
  }
  if (!background) player().patch({ resolvingMode: true })
  try {
    const alt = await alternativeUpload(t, mode, failedRefs).catch(() => null)
    const ok = alt && alt.variant === mode ? alt : alt && mode === 'VIDEO' && alt.variant == null && !/- Topic$/i.test(alt.channelTitle ?? '') ? { ...alt, variant: 'VIDEO' as const } : null
    if (ok) {
      altPairs.set(`${t.id}|${mode}`, ok)
      altPairs.set(`${ok.id}|${t.variant ?? 'SONG'}`, t)
    }
    // A quota or network failure isn't "no video": only real answers are remembered.
    if (alt !== undefined && ytQuotaState() !== 'EXHAUSTED') void idbSet(key, { alt: ok, at: Date.now() }, 'cache')
    return ok
  } finally {
    if (!background && !swap) player().patch({ resolvingMode: false })
  }
}

/** In Video mode every new song switches to its music video — when Now Playing is on screen. */
let autoVideoTimer: ReturnType<typeof setTimeout> | null = null
function autoVideo() {
  if (autoVideoTimer) clearTimeout(autoVideoTimer)
  autoVideoTimer = setTimeout(() => {
    const p = player()
    const t = currentTrack()
    if (p.mode !== 'VIDEO' || !t || t.variant === 'VIDEO' || noVideo.has(t.id)) return
    if (!videoVisible()) return
    void setMode('VIDEO', true)
  }, 700)
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
      player().addAutoplay(recs.map((r) => r.track))
      if (!player().context?.includes('radio')) player().patch({ context: `${it.track.artist} radio` })
    }
  } finally {
    player().patch({ radioLoading: false })
  }
}

function tick() {
  if (!yt || preview) return
  updateVeil()
  const p = player()
  const now = performance.now()
  const dt = Math.min(1000, now - lastTick)
  lastTick = now
  let pos = 0
  try { pos = (yt.getCurrentTime?.() ?? 0) * 1000 } catch { /* player not ready */ }
  const frac = yt.getVideoLoadedFraction?.() ?? 0
  if (p.isPlaying) useProgress.getState().set(pos, frac)
  else if (Math.abs(useProgress.getState().position - pos) > 400 && pos > 0) useProgress.getState().set(pos, frac)
  if (p.isPlaying && !p.isBuffering && session) {
    session.listened += dt * p.rate
    const dur = (yt.getDuration?.() ?? 0) * 1000 || p.duration
    if (dur > 0 && Math.abs(pos - lastPos) < 4000) recordHeard(session.track.id, pos, dur, dt * p.rate)
  }
  if (pos > 0) lastPos = pos
  if (p.isPlaying && p.issue && pos > 0) p.patch({ issue: null })
  let yd = 0
  try { yd = (yt.getDuration?.() ?? 0) * 1000 } catch { /* not ready */ }
  if (yd > 0 && Math.abs(yd - p.duration) > 1500) p.patch({ duration: yd })
  const d = yd || p.duration
  if (p.isPlaying && d > 0 && pos > d * 0.5) void maybeRadio()
  if (p.isPlaying && !p.isBuffering && d > 0) planAutomix(pos, d)
  // Watching videos: find the next song's music video early, so it starts on it.
  if (p.isPlaying && pos > 20_000 && p.mode === 'VIDEO' && videoVisible()) prefetchCounterpart(upcoming()?.track, 'VIDEO')
  // Sleep timer: the music fades slowly over its last 30 seconds instead of stopping short.
  const sleepLeft = p.sleep?.mode === 'time' ? p.sleep.endsAt - Date.now() : Infinity
  if (sleepLeft > 0 && sleepLeft < SLEEP_FADE_MS && p.isPlaying && !mix) { sleepFading = true; yt?.setVolume(Math.round(targetVolume() * (sleepLeft / SLEEP_FADE_MS))) }
  else if (sleepFading && sleepLeft === Infinity) { sleepFading = false; if (!mix) yt?.setVolume(targetVolume()) } // timer cancelled mid-fade
  if (p.sleep?.mode === 'time' && Date.now() >= p.sleep.endsAt) {
    sleepFading = false
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
      // Album art from Apple Music is square; a YouTube frame is 16:9.
      { src: art, sizes: /mzstatic\.com/.test(art) ? '600x600' : '1280x720', type: 'image/jpeg' },
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
      if (st.queue[st.index]?.key !== prev.queue[prev.index]?.key) { cancelSwap(); settleSwap(); radioTried = new Set([...radioTried].slice(-50)); autoVideo() }
      syncTrack(prev.isPlaying)
    }
    if (st.expanded && !prev.expanded) autoVideo()
    if (st.wantPlaying !== prev.wantPlaying && yt) {
      if (st.wantPlaying) {
        if (!currentKey && st.queue[st.index]) syncTrack(false)
        yt.playVideo()
      } else { loadingSince = 0; settleMix(); settleSwap(); cancelSwap(true); yt.pauseVideo() }
    }
    if (st.seekRequest && st.seekRequest !== prev.seekRequest && yt) {
      if (session && st.seekRequest.ms < lastPos - 3000) recordRewind(session.track.id, lastPos, st.seekRequest.ms, st.duration || session.track.durationMs || 0)
      settleMix()
      settleSwap()
      cancelSwap(true)
      yt.seekTo(st.seekRequest.ms / 1000, true)
      useProgress.getState().set(st.seekRequest.ms)
      if (st.wantPlaying) yt.playVideo()
    }
    if ((st.volume !== prev.volume || st.muted !== prev.muted) && yt && mix?.phase !== 'mixing' && !swapFading) {
      fadeToken++
      yt.setVolume(targetVolume())
    }
    if (st.rate !== prev.rate) for (const d of decks) d?.setPlaybackRate(st.rate)
    if (st.isPlaying !== prev.isPlaying || st.index !== prev.index || st.wantPlaying !== prev.wantPlaying) updateTitle()
  })
  setInterval(tick, 250)
  // Read-only engine state for support/debugging (window.__arnavEngine()).
  ;(window as unknown as { __arnavEngine: () => unknown }).__arnavEngine = () => ({
    activeDeck, lastSwap, swapping: !!swap, mix: mix && { phase: mix.phase, key: mix.key, fadeMs: mix.fadeMs, startAt: mix.startAt, deck: mix.deck }, style: automixStyle(), singleDeck,
    decks: decks.map((d) => { try { return d ? { state: d.getPlayerState(), t: Math.round(d.getCurrentTime()), vol: d.getVolume(), muted: d.isMuted(), id: d.getVideoData?.().video_id } : null } catch { return 'n/a' } }),
  })
  if (import.meta.env.DEV) (window as unknown as { __arnavDecks: unknown }).__arnavDecks = decks
  window.addEventListener('pagehide', () => finishSession(true))
}
