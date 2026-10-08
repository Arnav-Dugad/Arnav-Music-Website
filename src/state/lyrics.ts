import { create } from 'zustand'
import { findLyrics, saveLyrics, type Lyrics } from '../lib/lyrics'
import { transcribeLyrics, translateLyrics, aiAvailability, AI_REASON_COPY } from '../lib/ai'
import { currentTrack, usePlayer } from './player'
import { settings } from './settings'
import { toast } from './ui'
import { idbGet, idbSet } from '../lib/idb'

type Status = 'idle' | 'loading' | 'found' | 'none' | 'instrumental' | 'error' | 'off'

interface LyricsState {
  trackId: string | null
  status: Status
  lyrics: Lyrics | null
  translation: { language: string; lines: string[]; romanized: string[] } | null
  translating: boolean
  generating: boolean
  showTranslation: boolean
  /** Cinematic full-screen lyrics (serif type over the blurred cover). */
  cinematic: boolean
  load: (force?: boolean) => Promise<void>
  generate: () => Promise<void>
  translate: (language: string) => Promise<void>
  paste: (raw: string) => Promise<boolean>
  set: (p: Partial<LyricsState>) => void
}

export const useLyrics = create<LyricsState>()((set, get) => ({
  trackId: null,
  status: 'idle',
  lyrics: null,
  translation: null,
  translating: false,
  generating: false,
  showTranslation: false,
  cinematic: false,
  set: (p) => set(p),
  async load(force = false) {
    const t = currentTrack()
    if (!t) return set({ trackId: null, status: 'idle', lyrics: null, translation: null })
    if (!force && get().trackId === t.id && get().status !== 'idle') return
    set({ trackId: t.id, status: settings().onlineLyrics ? 'loading' : 'off', lyrics: null, translation: null })
    if (!settings().onlineLyrics) return
    try {
      const r = await findLyrics(t)
      if (currentTrack()?.id !== t.id) return
      if (r.status === 'found') {
        set({ status: 'found', lyrics: r.lyrics })
        const saved = await idbGet<LyricsState['translation']>(`tr|${t.id}`)
        if (saved && currentTrack()?.id === t.id) set({ translation: saved })
      } else set({ status: r.status === 'instrumental' ? 'instrumental' : 'none' })
    } catch {
      if (currentTrack()?.id === t.id) set({ status: 'error' })
    }
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
      const lyrics = await saveLyrics(t, r.text, 'Arnav AI')
      if (lyrics && currentTrack()?.id === t.id) set({ status: 'found', lyrics })
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
    const lyrics = await saveLyrics(t, raw, 'You')
    if (!lyrics) return false
    set({ status: 'found', lyrics, trackId: t.id })
    return true
  },
}))

// Load lyrics for whatever is playing (cheap: cached per song, LRCLIB is free).
let last: string | null = null
usePlayer.subscribe((s) => {
  const id = s.queue[s.index]?.track.id ?? null
  if (id === last) return
  last = id
  void useLyrics.getState().load()
})
