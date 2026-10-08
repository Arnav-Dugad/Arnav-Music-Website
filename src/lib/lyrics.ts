
/** One sung word with absolute timing (ms). */
export interface LyricWord { start: number; end: number; text: string }

/** A displayed line. No text and no background = instrumental break. */
export interface LyricLine {
  start: number
  end: number
  text: string
  words: LyricWord[]
  background?: string
  backgroundWords?: LyricWord[]
  /** True when word timing was spread by syllables, not timed by the source. */
  estimated: boolean
}

export type Lyrics =
  | { kind: 'synced'; lines: LyricLine[]; source: string }
  | { kind: 'plain'; lines: string[]; source: string }

export const isInstrumental = (l: LyricLine) => !l.text.trim() && !l.background?.trim()

const INSTRUMENTAL_GAP_MS = 6_000
const LAST_LINE_MS = 5_000
const MIN_LINE_MS = 2_500
const MS_PER_WORD = 380

const timeTag = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/
const wordTag = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g
const metaTag = /^\s*\[([A-Za-z#][A-Za-z0-9_\- ]{0,15}):(.*)\]\s*$/
const bgLine = /^\s*\[bg:(.*)]\s*$/i
const voicePrefix = /^\s*v\d{1,2}:\s*/i
const metaKeys = new Set(['ar', 'al', 'ti', 'au', 'by', 'length', 'offset', 're', 've', 'tool', 'la', 'lang', 'id', 'kana', 'sign', 'hash', 'total', '#', 'artist', 'album', 'title', 'author', 'version', 'encoding'])
const sectionLabel = /^\s*[([]?\s*(chorus|verse|bridge|intro|outro|hook|pre-?chorus|refrain|interlude|instrumental|x\d+|\d+x|repeat)\b[^)\]]*[)\]]?\s*$/i

function toMs(m: string, s: string, frac?: string): number {
  const f = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0
  return Number(m) * 60_000 + Number(s) * 1000 + f
}

interface Entry { time: number; text: string; words: LyricWord[]; bg?: string; bgWords?: LyricWord[] }

/** Splits "text <00:01.20>word <00:01.50>word" into display text and timed words. */
function parseWords(body: string): { text: string; words: LyricWord[] } {
  const matches = [...body.matchAll(wordTag)]
  if (matches.length === 0) return { text: body.replace(/\s+/g, ' ').trim(), words: [] }
  const words: LyricWord[] = []
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]
    const start = toMs(m[1], m[2], m[3])
    const from = (m.index ?? 0) + m[0].length
    const to = i + 1 < matches.length ? matches[i + 1].index ?? body.length : body.length
    const text = body.slice(from, to).replace(/\s+/g, ' ')
    if (text.trim()) words.push({ start, end: start, text: text.trim() })
    else if (words.length) words[words.length - 1].end = start
  }
  for (let i = 0; i < words.length; i++) {
    if (words[i].end <= words[i].start) words[i].end = words[i + 1]?.start ?? words[i].start + 600
  }
  return { text: words.map((w) => w.text).join(' ').trim(), words }
}

/** "I'm on my way (on my way)" → lead + backing vocals. Section labels are never vocals. */
function splitBackground(text: string): { text: string; background?: string } {
  if (!text.trim() || sectionLabel.test(text)) return { text }
  const trailing = /^(.*?)\s*[(（]([^()（）]{2,})[)）]\s*$/.exec(text)
  if (trailing && !sectionLabel.test(trailing[2])) return { text: trailing[1].trim(), background: trailing[2].trim() }
  const leading = /^\s*[(（]([^()（）]{2,})[)）]\s*(.*)$/.exec(text)
  if (leading && !sectionLabel.test(leading[1])) return { text: leading[2].trim(), background: leading[1].trim() }
  return { text }
}

/** Writing direction of a lyric line: Arabic, Urdu, Persian and Hebrew read right to left. */
export function isRtl(text: string): boolean {
  const letters = text.match(/\p{L}/gu)
  if (!letters?.length) return false
  return letters.filter((c) => /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(c)).length / letters.length > 0.5
}

/** Indic scripts (Devanagari, Gurmukhi, Bengali, Tamil, Telugu…): vowel signs must stay attached. */
export const isIndic = (text: string) => /[ऀ-෿]/.test(text)

/**
 * Rough syllable count for word-fill estimation, per script:
 *  - Latin (English, Spanish, romanised Hindi/Punjabi): vowel groups, accents folded;
 *  - Indic abugidas: one per consonant or independent vowel, minus conjuncts joined by a virama;
 *  - Arabic: short vowels aren't written — consonants pair up, long vowels (ا و ي) add a beat;
 *  - CJK / kana / Hangul: one per character.
 */
export function syllables(word: string): number {
  const raw = word.toLowerCase()
  if (/[ऀ-෿]/.test(raw)) {
    const bases = raw.match(/[ऄ-हक़-ॡॲ-ॿਅ-ਹਖ਼-ਫ਼અ-હঅ-হଅ-ହஅ-ஹఅ-హಅ-ಹഅ-ഺ]/g)?.length ?? 0
    const viramas = raw.match(/[्੍્্୍்్್്]/g)?.length ?? 0
    return Math.max(1, bases - viramas)
  }
  if (/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(raw)) {
    const letters = raw.match(/[ء-يٱ-ۓ]/g) ?? []
    const long = letters.filter((c) => /[اويىآ]/.test(c)).length
    return Math.max(1, Math.round((letters.length - long) / 2) + Math.ceil(long / 2))
  }
  if (/[぀-ヿ㐀-鿿가-힯]/.test(raw)) return Math.max(1, raw.replace(/[ゃゅょャュョっッー\s\p{P}]/gu, '').length)
  const w = raw.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\p{L}]/gu, '')
  if (!w) return 1
  if (!/[a-z]/.test(w)) return Math.max(1, Math.round(w.length / 2))
  const groups = w.replace(/([^aeiou])e$/, '$1').match(/[aeiouy]+/g)
  return Math.max(1, groups?.length ?? 1)
}

/** Spreads a line's words over its sung stretch by syllables (Apple-style fill for line-synced LRC). */
export function estimateWords(text: string, start: number, end: number): LyricWord[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  // Singers hold the last word of a line and breathe at commas: give those more time.
  const weights = tokens.map((t, i) => syllables(t) + (i === tokens.length - 1 ? 1.1 : 0) + (/[,;:!?…]$/.test(t) ? 0.5 : 0))
  const total = weights.reduce((a, b) => a + b, 0)
  const sung = Math.min(end - start, Math.max(MIN_LINE_MS * 0.8, tokens.length * MS_PER_WORD * 1.15 + 450))
  let t = start
  return tokens.map((tok, i) => {
    const d = (sung * weights[i]) / total
    const w = { start: t, end: t + d, text: tok }
    t += d
    return w
  })
}

export function parseLrc(raw: string, durationMs?: number | null, source = 'LRCLIB'): Lyrics | null {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!text.trim()) return null
  let offset = 0
  const entries: Entry[] = []
  const plain: string[] = []
  let last: Entry[] = []

  for (const line of text.split('\n')) {
    const bg = bgLine.exec(line)
    if (bg) {
      const { text: shown, words } = parseWords(bg[1])
      if (!shown) continue
      plain.push(`(${shown})`)
      for (const e of last) {
        e.bg = e.bg ? `${e.bg} ${shown}` : shown
        e.bgWords = [...(e.bgWords ?? []), ...words.map((w) => ({ ...w, start: w.start + (e.time - last[0].time), end: w.end + (e.time - last[0].time) }))]
      }
      continue
    }
    const stamps: number[] = []
    let rest = line
    for (;;) {
      const m = timeTag.exec(rest)
      if (!m) break
      stamps.push(toMs(m[1], m[2], m[3]))
      rest = rest.slice(m[0].length)
    }
    if (stamps.length === 0) {
      const meta = metaTag.exec(line)
      if (meta) {
        const key = meta[1].trim().toLowerCase()
        if (key === 'offset') offset = Number(meta[2].trim().replace(/^\+/, '')) || offset
        if (metaKeys.has(key)) continue
      }
      plain.push(line.trimEnd())
      continue
    }
    const parsed = parseWords(rest.replace(voicePrefix, ''))
    // "♪" / "…" lines mark instrumental passages.
    const lineText = /^[\s♪♫♬♩…·•.\-]*$/.test(parsed.text) ? '' : parsed.text
    const words = lineText ? parsed.words : []
    const made = stamps.map((s) => ({ time: s, text: lineText, words: words.map((w) => ({ ...w, start: w.start + (s - stamps[0]), end: w.end + (s - stamps[0]) })) }))
    entries.push(...made)
    last = made
  }

  if (entries.length === 0) {
    while (plain.length && !plain[0].trim()) plain.shift()
    while (plain.length && !plain[plain.length - 1].trim()) plain.pop()
    return plain.length ? { kind: 'plain', lines: plain, source } : null
  }

  const sorted = entries
    .map((e) => (offset ? { ...e, time: Math.max(0, e.time - offset), words: e.words.map((w) => ({ ...w, start: w.start - offset, end: w.end - offset })) } : e))
    .sort((a, b) => a.time - b.time)

  const out: LyricLine[] = []
  const first = sorted[0]
  if (first.time >= INSTRUMENTAL_GAP_MS && (first.text || first.bg)) out.push({ start: 0, end: first.time, text: '', words: [], estimated: false })
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]
    const next = sorted[i + 1]
    const hardEnd = next ? next.time : durationMs && durationMs > cur.time ? durationMs : cur.time + LAST_LINE_MS
    if (!cur.text && !cur.bg) {
      // An empty timed line is an explicit break.
      out.push({ start: cur.time, end: hardEnd, text: '', words: [], estimated: false })
      continue
    }
    const split = cur.bg ? { text: cur.text, background: cur.bg } : splitBackground(cur.text)
    const wordCount = split.text.split(/\s+/).filter(Boolean).length
    const sungEnd = cur.words.length ? cur.words[cur.words.length - 1].end : cur.time + Math.max(MIN_LINE_MS, wordCount * MS_PER_WORD * 1.6)
    let end = hardEnd
    let gap = false
    if (next && next.time - sungEnd >= INSTRUMENTAL_GAP_MS) {
      end = Math.max(cur.time + MIN_LINE_MS, sungEnd + 800)
      gap = true
    }
    const words = cur.words.length && !cur.bg && split.background ? cur.words.filter((w) => split.text.includes(w.text)) : cur.words
    out.push({
      start: cur.time,
      end,
      text: split.text,
      words: words.length ? words : estimateWords(split.text, cur.time, end),
      background: split.background,
      backgroundWords: cur.bgWords,
      estimated: words.length === 0,
    })
    if (gap && next) out.push({ start: end, end: next.time, text: '', words: [], estimated: false })
  }
  return { kind: 'synced', lines: out, source }
}

/** Index of the line being sung at [pos]; -1 before the first line. */
export function activeIndex(lines: LyricLine[], pos: number): number {
  if (!lines.length || pos < lines[0].start) return -1
  let lo = 0
  let hi = lines.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    if (lines[mid].start <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function progress(start: number, end: number, pos: number): number {
  if (pos <= start) return 0
  if (end <= start || pos >= end) return 1
  return (pos - start) / (end - start)
}

// ── Title cleaning for lyrics lookups ─────────────────────────────────────────
const noise = /\s*[([](?:[^)\]]*(?:feat|ft\.|with |official|lyric|audio|video|visuali[sz]er|remaster|live|explicit|clean|hd|4k)[^)\]]*)[)\]]/gi
/** "Song - feat. X", "Song ft. X", "Levitating Featuring DaBaby": the guests aren't part of the title. */
const dashFeat = /\s+(?:-\s+)?(?:feat\.?|ft\.|featuring)\s.*$/i
export const cleanTitle = (raw: string) => raw.replace(noise, '').replace(dashFeat, '').trim()
