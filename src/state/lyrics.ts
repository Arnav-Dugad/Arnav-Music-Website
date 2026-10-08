import { create } from 'zustand'
import { parseLrc, type Lyrics } from '../lib/lyrics'
import { alignLyricsAi, transcribeLyrics, translateLyrics, aiAvailability, AI_REASON_COPY } from '../lib/ai'
import { currentTrack, usePlayer, useProgress } from './player'
import { settings } from './settings'
import { prefs } from './prefs'
import { toast } from './ui'
import { idbGet, idbSet } from '../lib/idb'
import { fetchCredits, shareCommunity } from '../lib/meta'
import { buildLyrics, findLyricsCandidates, fitSegments, fitTiming, rescore, timingUncertain, type LyricsCandidate, type LyricsPick, type LyricsTiming } from '../services/lyricsEngine'

type Status = 'idle' | 'loading' | 'found' | 'none' | 'instrumental' | 'error' | 'off'

interface LyricsState {
  trackId: string | null
  status: Status
  lyrics: Lyrics | null
  /** Every version found, best first ("Choose another version"). */
  pick: LyricsPick | null
  chosen: LyricsCandidate | null
  timing: LyricsTiming
  /** Official lyrics from the video description (plain), when the uploader typed them in. */
  official: string | null
  translation: { language: string; lines: string[]; romanized: string[] } | null
  translating: boolean
  generating: boolean
  aligning: boolean
  showTranslation: boolean
  /** Cinematic full-screen lyrics (serif type over the blurred cover). */
  cinematic: boolean
  /** Dock: wide lyrics sidebar with the translation beside each line. */
  sidebar: boolean
  load: (force?: boolean) => Promise<void>
  choose: (key: string) => void
  /** Moves the lyrics later (+) or earlier (−). */
  nudge: (deltaMs: number) => void
  /** "Tap when this line starts": the line at [index] starts now. */
  tapSync: (index: number) => void
  resetTiming: () => void
  /** Arnav AI listens to the video and lines the lyrics up (quiet: automatic, no toasts unless it works). */
  alignAi: (quiet?: boolean) => Promise<void>
  useOfficial: () => void
  generate: () => Promise<void>
  translate: (language: string) => Promise<void>
  paste: (raw: string) => Promise<boolean>
  set: (p: Partial<LyricsState>) => void
}

const NO_TIMING: LyricsTiming = { offsetMs: 0, scale: 1, source: 'none' }
/** Timing fixes are shared with other listeners once they've held for a while. */
let shareTimer: ReturnType<typeof setTimeout> | null = null

function scheduleShare(trackId: string, videoId: string, choice: string, offsetMs?: number, scale?: number) {
  if (shareTimer) clearTimeout(shareTimer)
  shareTimer = setTimeout(() => {
    if (currentTrack()?.id !== trackId) return
    void shareCommunity(videoId, choice, offsetMs, scale)
  }, 20_000)
}

/**
 * Self-aligning lyrics: when the timing is only a guess (a long intro shift, or a film video that is
 * an edit of the song), Arnav AI listens once the song has played a few seconds, and shares the
 * result so every later listener of this video gets it without asking the AI again.
 */
let autoTimer: ReturnType<typeof setTimeout> | null = null
function scheduleAutoAlign(trackId: string, videoId: string) {
  if (autoTimer) clearTimeout(autoTimer)
  if (!settings().autoAlignLyrics || aiAvailability()) return
  autoTimer = setTimeout(async () => {
    if (currentTrack()?.id !== trackId || !usePlayer.getState().isPlaying) return
    const key = `aal|v1|${videoId}`
    if (await idbGet<number>(key, 'cache')) return // tried this video already
    void idbSet(key, Date.now(), 'cache')
    void useLyrics.getState().alignAi(true)
  }, 9000)
}

export const useLyrics = create<LyricsState>()((set, get) => {
  /** Rebuilds the displayed lyrics from the current pick, choice and timing. */
  const apply = (pick: LyricsPick, key?: string | null) => {
    const t = currentTrack()
    if (!t) return
    const chosen = pick.candidates.find((c) => c.key === (key ?? pick.chosen)) ?? null
    if (!chosen) {
      set({ pick, chosen: null, lyrics: null, timing: NO_TIMING, status: pick.status === 'instrumental' ? 'instrumental' : 'none' })
      return
    }
    const built = buildLyrics(t, pick, chosen)
    if (!built) { set({ pick, chosen: null, status: 'none', lyrics: null }); return }
    set({ pick, chosen, lyrics: built.lyrics, timing: built.timing, status: 'found' })
    if (timingUncertain(t, chosen, built.timing)) scheduleAutoAlign(t.id, t.playbackRef)
  }

  return {
    trackId: null,
    status: 'idle',
    lyrics: null,
    pick: null,
    chosen: null,
    timing: NO_TIMING,
    official: null,
    translation: null,
    translating: false,
    generating: false,
    aligning: false,
    showTranslation: false,
    cinematic: false,
    sidebar: false,
    set: (p) => set(p),
    async load(force = false) {
      const t = currentTrack()
      if (!t) return set({ trackId: null, status: 'idle', lyrics: null, translation: null, pick: null, chosen: null })
      if (!force && get().trackId === t.id && get().status !== 'idle') return
      set({ trackId: t.id, status: settings().onlineLyrics ? 'loading' : 'off', lyrics: null, translation: null, pick: null, chosen: null, timing: NO_TIMING, official: null })
      if (!settings().onlineLyrics) return
      try {
        // Your saved / AI / pasted lyrics come first.
        const own = await idbGet<{ raw: string; source: string }>(`lyr-own|${t.id}`, 'cache')
        if (own && currentTrack()?.id === t.id) {
          const l = parseLrc(own.raw, t.durationMs, own.source)
          if (l) {
            const fix = prefs().lyricsFix[t.id]
            const lyrics = l.kind === 'synced' && fix?.choice === 'own' && (fix.offsetMs || fix.scale) ? { ...l, lines: (await import('../services/lyricsEngine')).shiftLines(l.lines, fix.offsetMs ?? 0, fix.scale ?? 1) } : l
            set({ status: 'found', lyrics, chosen: { key: 'own', source: own.source === 'Arnav AI' ? 'Arnav AI' : 'You', title: t.title, artist: t.artist, album: t.album ?? null, durationMs: t.durationMs ?? null, synced: l.kind === 'synced', wordTimed: false, raw: own.raw, score: 999, reasons: [] }, timing: fix?.choice === 'own' ? { offsetMs: fix.offsetMs ?? 0, scale: fix.scale ?? 1, source: 'you' } : NO_TIMING })
            return
          }
        }
        const pick = await findLyricsCandidates(t, { force })
        if (currentTrack()?.id !== t.id) return
        apply(pick)
        const saved = await idbGet<LyricsState['translation']>(`tr|${t.id}`)
        if (saved && currentTrack()?.id === t.id) set({ translation: saved })
        // Low confidence or nothing found: the uploader's own lyrics help (cached credits only cost one call per song, shared).
        const best = pick.candidates[0]
        if (!best || best.score < 75) {
          const cr = await fetchCredits(t).catch(() => null)
          if (currentTrack()?.id !== t.id || !cr?.lyrics) return
          set({ official: cr.lyrics })
          const again = rescore(pick, t, cr.lyrics)
          if (again.chosen !== pick.chosen || (!again.chosen && get().status !== 'found')) apply(again)
          if (!again.chosen && get().status !== 'found') {
            const plain = parseLrc(cr.lyrics, t.durationMs, 'YouTube description')
            if (plain) set({ status: 'found', lyrics: plain, chosen: { key: 'desc', source: 'YouTube description', title: t.title, artist: t.artist, album: null, durationMs: null, synced: false, wordTimed: false, raw: cr.lyrics, score: 50, reasons: ['from the uploader'] } })
          }
        }
      } catch {
        if (currentTrack()?.id === t.id) set({ status: 'error' })
      }
    },
    choose(key) {
      const t = currentTrack()
      const pick = get().pick
      if (!t || !pick) return
      if (key === 'desc') { get().useOfficial(); return }
      prefs().setLyricsFix(t.id, { choice: key, offsetMs: undefined, scale: undefined })
      apply(rescore(pick, t, get().official), key)
      if (/^(lrclib|netease):/.test(key)) void shareCommunity(t.playbackRef, key)
      toast('Lyrics version saved — listeners after you get it too')
    },
    nudge(delta) {
      const t = currentTrack()
      const c = get().chosen
      if (!t || !c || get().lyrics?.kind !== 'synced') return
      const cur = get().timing
      const offsetMs = Math.round(cur.offsetMs + delta)
      // An edited video keeps its parts; the whole map moves together.
      if (cur.map?.length) {
        prefs().setLyricsFix(t.id, { choice: c.key, map: cur.map.map(([a, b, o]) => [a, b, Math.round(o + delta)] as [number, number, number]), offsetMs: undefined, scale: undefined, by: 'you' })
        const pk = get().pick
        if (pk && c.key !== 'own') apply(pk, c.key)
        return
      }
      prefs().setLyricsFix(t.id, { choice: c.key, offsetMs, scale: cur.scale, map: undefined, by: 'you' })
      const pick = get().pick
      if (pick && c.key !== 'own') apply(pick, c.key)
      else void get().load(true)
      if (/^(lrclib|netease):/.test(c.key)) scheduleShare(t.id, t.playbackRef, c.key, offsetMs, cur.scale)
    },
    tapSync(index) {
      const l = get().lyrics
      if (!l || l.kind !== 'synced') return
      const line = l.lines[index]
      if (!line) return
      // The line is displayed at line.start; it's really being sung now.
      const now = useProgress.getState().position
      get().nudge(now - line.start - 120)
    },
    resetTiming() {
      const t = currentTrack()
      const c = get().chosen
      if (!t || !c) return
      prefs().setLyricsFix(t.id, { choice: c.key, offsetMs: 0, scale: 1, map: undefined, by: 'you' })
      const pick = get().pick
      if (pick) apply(pick, c.key)
    },
    async alignAi(quiet = false) {
      const t = currentTrack()
      const c = get().chosen
      const pick = get().pick
      if (!t || !c || !c.synced || get().aligning) return
      const blocked = aiAvailability()
      if (blocked) { if (!quiet) toast(AI_REASON_COPY[blocked].replace(' — answered on device.', '.')); return }
      const raw = parseLrc(c.raw, t.durationMs, c.source)
      if (!raw || raw.kind !== 'synced') return
      set({ aligning: true })
      if (!quiet) toast('Arnav AI is listening for the lyrics… about a minute')
      try {
        const r = await alignLyricsAi(t, raw.lines.filter((l) => l.text.trim()).map((l) => ({ start: l.start, text: l.text })))
        if (!r.ok) { if (!quiet) toast('Arnav AI couldn’t line these lyrics up'); return }
        const share = /^(lrclib|netease):/.test(c.key)
        const fit = fitTiming(r.points)
        if (fit) {
          prefs().setLyricsFix(t.id, { choice: c.key, offsetMs: fit.offsetMs, scale: fit.scale, map: undefined, by: 'ai' })
          if (currentTrack()?.id === t.id && pick && get().chosen?.key === c.key) apply(pick, c.key)
          if (share) void shareCommunity(t.playbackRef, c.key, fit.offsetMs, fit.scale)
          toast(`Lyrics lined up by Arnav AI (${fit.offsetMs >= 0 ? '+' : ''}${(fit.offsetMs / 1000).toFixed(1)} s${fit.scale !== 1 ? `, tempo ×${fit.scale}` : ''})`)
          return
        }
        // No single shift fits: the video is an edit of the song — line up each part on its own.
        const map = fitSegments(r.points)
        if (!map || map.length < 2) { if (!quiet) toast('Arnav AI wasn’t sure enough — timing left as it was'); return }
        prefs().setLyricsFix(t.id, { choice: c.key, map, offsetMs: undefined, scale: undefined, by: 'ai' })
        if (currentTrack()?.id === t.id && pick && get().chosen?.key === c.key) apply(pick, c.key)
        if (share) void shareCommunity(t.playbackRef, c.key, undefined, undefined, map)
        toast(`Lyrics lined up by Arnav AI — this video is an edit, ${map.length} parts matched`)
      } finally {
        set({ aligning: false })
      }
    },
    useOfficial() {
      const t = currentTrack()
      const text = get().official
      if (!t || !text) return
      const plain = parseLrc(text, t.durationMs, 'YouTube description')
      if (plain) set({ status: 'found', lyrics: plain, timing: NO_TIMING, chosen: { key: 'desc', source: 'YouTube description', title: t.title, artist: t.artist, album: null, durationMs: null, synced: false, wordTimed: false, raw: text, score: 50, reasons: ['from the uploader'] } })
    },
    async generate() {
      const t = currentTrack()
      if (!t || get().generating) return
      const blocked = aiAvailability()
      if (blocked) { toast(AI_REASON_COPY[blocked].replace(' — answered on device.', '.')); return }
      set({ generating: true })
      toast('Arnav AI is listening to the song… this can take a minute')
      try {
        const r = await transcribeLyrics(t)
        if (!r.ok) { toast(r.reason === 'no vocals' ? 'Arnav AI heard no singing in this song' : 'Arnav AI couldn’t write lyrics for this song'); return }
        const lyrics = parseLrc(r.text, t.durationMs, 'Arnav AI')
        if (lyrics) await idbSet(`lyr-own|${t.id}`, { raw: r.text, source: 'Arnav AI' }, 'cache')
        if (lyrics && currentTrack()?.id === t.id) void get().load(true)
      } finally {
        set({ generating: false })
      }
    },
    async translate(language) {
      const t = currentTrack()
      const l = get().lyrics
      if (!t || !l || get().translating) return
      const lines = l.kind === 'synced' ? l.lines.map((x) => x.text) : l.lines
      set({ translating: true })
      try {
        const r = await translateLyrics(lines, language)
        if (!r) { toast('Translation isn’t available right now'); return }
        const tr = { language, lines: r.translation, romanized: r.romanized }
        void idbSet(`tr|${t.id}`, tr)
        if (currentTrack()?.id === t.id) set({ translation: tr, showTranslation: true })
      } finally {
        set({ translating: false })
      }
    },
    async paste(raw) {
      const t = currentTrack()
      if (!t) return false
      const lyrics = parseLrc(raw, t.durationMs, 'You')
      if (!lyrics) return false
      await idbSet(`lyr-own|${t.id}`, { raw, source: 'You' }, 'cache')
      await get().load(true)
      return true
    },
  }
})

// Load lyrics for whatever is playing (cheap: cached per song; the sources are free).
let last: string | null = null
usePlayer.subscribe((s) => {
  const id = s.queue[s.index]?.track.id ?? null
  if (id === last) return
  last = id
  void useLyrics.getState().load()
})
