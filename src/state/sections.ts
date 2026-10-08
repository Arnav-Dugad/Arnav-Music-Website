import { create } from 'zustand'
import { idbGet, idbSet } from '../lib/idb'
import { labelSectionsAi, sectionsFromAudioAi, aiAvailability, AI_REASON_COPY } from '../lib/ai'
import { nextChorus, sectionsFromLyrics, type Section, type SectionKind } from '../lib/sections'
import { currentTrack, player, usePlayer, useProgress } from './player'
import { useLyrics } from './lyrics'
import { toast } from './ui'

/** Sections of the song that's playing: from its lyrics at once, or labelled by Arnav AI. */
interface SectionsState {
  trackId: string | null
  sections: Section[]
  source: 'lyrics' | 'ai' | 'ai-audio' | null
  busy: boolean
  detectWithAi: () => Promise<void>
}

const KINDS: Record<string, SectionKind> = { verse: 'verse', chorus: 'chorus', hook: 'chorus', prechorus: 'verse', bridge: 'bridge', outro: 'outro', intro: 'intro', instrumental: 'instrumental' }

export const useSections = create<SectionsState>()((set, get) => ({
  trackId: null,
  sections: [],
  source: null,
  busy: false,
  async detectWithAi() {
    const t = currentTrack()
    if (!t || get().busy) return
    const blocked = aiAvailability()
    if (blocked) { toast(AI_REASON_COPY[blocked].replace(' — answered on device.', '.')); return }
    set({ busy: true })
    try {
      const l = useLyrics.getState().lyrics
      const d = usePlayer.getState().duration || t.durationMs || 0
      let out: Section[] = []
      let source: SectionsState['source'] = 'ai'
      if (l?.kind === 'synced') {
        const sung = l.lines.filter((x) => x.text.trim())
        const r = await labelSectionsAi(t, sung.map((x) => x.text))
        out = (r ?? []).map((s) => ({ kind: KINDS[s.kind] ?? 'verse', start: sung[s.from - 1].start, end: sung[s.to - 1].end }))
      } else {
        toast('Arnav AI is listening for the chorus… about a minute')
        source = 'ai-audio'
        const r = await sectionsFromAudioAi(t)
        out = (r ?? []).map((s) => ({ kind: KINDS[s.kind] ?? 'verse', start: Math.round(s.start * 1000), end: Math.round(Math.min(s.end * 1000, d || s.end * 1000)) }))
      }
      if (currentTrack()?.id !== t.id) return
      if (!out.some((s) => s.kind === 'chorus')) { toast('Arnav AI didn’t hear a clear chorus in this song'); return }
      void idbSet(`sec|v1|${t.id}`, { sections: out, source }, 'cache')
      set({ sections: out, source, trackId: t.id })
      toast('Sections marked on the song map')
    } finally {
      set({ busy: false })
    }
  },
}))

async function refresh() {
  const t = currentTrack()
  if (!t) { useSections.setState({ trackId: null, sections: [], source: null }); return }
  const saved = await idbGet<{ sections: Section[]; source: SectionsState['source'] }>(`sec|v1|${t.id}`, 'cache')
  if (currentTrack()?.id !== t.id) return
  if (saved?.sections.length) { useSections.setState({ trackId: t.id, ...saved }); return }
  const l = useLyrics.getState()
  const d = usePlayer.getState().duration || t.durationMs || 0
  const sections = l.lyrics?.kind === 'synced' && l.trackId === t.id ? sectionsFromLyrics(l.lyrics.lines, d) : []
  useSections.setState({ trackId: t.id, sections, source: sections.length ? 'lyrics' : null })
}
useLyrics.subscribe((s, p) => { if (s.lyrics !== p.lyrics) void refresh() })
usePlayer.subscribe((s, p) => { if (s.queue[s.index]?.track.id !== p.queue[p.index]?.track.id) void refresh() })

export function skipToChorus(): boolean {
  const c = nextChorus(useSections.getState().sections, useProgress.getState().position)
  if (!c) { toast('No chorus found yet — Arnav AI can find it'); return false }
  player().seek(Math.max(0, c.start - 250))
  return true
}
export const hasChorus = (s: Section[]) => s.some((x) => x.kind === 'chorus')
