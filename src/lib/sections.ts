/**
 * Song sections (intro, verse, chorus, bridge, instrumental, outro) from time-synced lyrics: the
 * chorus is the block of lines that comes back most. Arnav AI can label them instead (from the
 * lyrics, or by listening when a song has no synced lyrics) — see state/sections.ts.
 */
import type { LyricLine } from './lyrics'

export type SectionKind = 'intro' | 'verse' | 'chorus' | 'bridge' | 'instrumental' | 'outro'
export interface Section { kind: SectionKind; start: number; end: number }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Line similarity by shared words (choruses vary a word or two between repeats). */
function similar(a: string, b: string): boolean {
  if (a === b) return true
  const x = new Set(a.split(' '))
  const y = new Set(b.split(' '))
  if (!x.size || !y.size) return false
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / Math.max(x.size, y.size) >= 0.7
}

export function sectionsFromLyrics(lines: LyricLine[], durationMs: number): Section[] {
  const sung = lines.map((l, i) => ({ i, l, k: norm(l.text) })).filter((x) => x.k)
  if (sung.length < 4 || !durationMs) return []
  // Blocks: runs of sung lines, broken at instrumental lines or long pauses.
  const blocks: { from: number; to: number; start: number; end: number; keys: string[] }[] = []
  let cur: (typeof blocks)[number] | null = null
  // Line ends are stretched to the next line, so pauses show in the start-to-start spacing.
  const steps = sung.slice(1).map((x, j) => x.l.start - sung[j].l.start).sort((a, b) => a - b)
  const typical = steps[Math.floor(steps.length / 2)] ?? 3500
  const breakAt = Math.max(5500, typical * 1.7)
  const sungEnd = (l: LyricLine) => l.start + Math.min(l.end - l.start, typical * 1.4)
  for (let j = 0; j < sung.length; j++) {
    const s = sung[j]
    const prev = sung[j - 1]
    const gap = prev ? s.l.start - prev.l.start : 0
    const brokenByBreak = prev && lines.slice(prev.i + 1, s.i).some((x) => !x.text.trim() && x.end - x.start >= 3000)
    if (!cur || gap > breakAt || brokenByBreak || cur.keys.length >= 10) {
      cur = { from: j, to: j, start: s.l.start, end: s.l.end, keys: [] }
      blocks.push(cur)
    }
    cur.to = j
    cur.end = sungEnd(s.l)
    cur.keys.push(s.k)
  }
  // How often each line comes back anywhere in the song.
  const repeats = (k: string) => sung.filter((x) => similar(x.k, k)).length
  const score = blocks.map((b) => {
    const r = b.keys.map(repeats)
    const repeatedShare = r.filter((n) => n >= 2).length / b.keys.length
    return { repeatedShare, mean: r.reduce((a, n) => a + n, 0) / r.length }
  })
  const best = Math.max(0, ...score.map((s) => s.mean))
  const out: Section[] = []
  if (blocks[0].start > 6000) out.push({ kind: 'intro', start: 0, end: blocks[0].start })
  blocks.forEach((b, i) => {
    const s = score[i]
    const chorus = best >= 2 && s.repeatedShare >= 0.5 && s.mean >= Math.max(2, best * 0.6)
    const prevEnd = out.length ? out[out.length - 1].end : 0
    if (b.start - prevEnd > 8000 && out.length) out.push({ kind: 'instrumental', start: prevEnd, end: b.start })
    out.push({ kind: chorus ? 'chorus' : 'verse', start: b.start, end: b.end })
  })
  // A one-off verse late in the song, between choruses, is the bridge.
  const lastChorus = out.map((s) => s.kind).lastIndexOf('chorus')
  for (let i = 1; i < lastChorus; i++) {
    if (out[i].kind === 'verse' && out[i - 1].kind === 'chorus' && out[i + 1]?.kind === 'chorus' && out[i].start > durationMs * 0.5) out[i] = { ...out[i], kind: 'bridge' }
  }
  const lastEnd = out[out.length - 1].end
  if (durationMs - lastEnd > 6000) out.push({ kind: 'outro', start: lastEnd, end: durationMs })
  return out
}

/** The next chorus after [posMs] (or the first one when past the last). */
export function nextChorus(sections: Section[], posMs: number): Section | null {
  const ch = sections.filter((s) => s.kind === 'chorus')
  return ch.find((s) => s.start > posMs + 1500) ?? ch[0] ?? null
}

export const SECTION_LABEL: Record<SectionKind, string> = { intro: 'Intro', verse: 'Verse', chorus: 'Chorus', bridge: 'Bridge', instrumental: 'Instrumental', outro: 'Outro' }
