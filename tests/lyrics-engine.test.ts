import { describe, expect, it } from 'vitest'
import { fitTiming, scoreCandidate, shiftLines, type LyricsCandidate } from '../src/services/lyricsEngine'
import { parseLrc } from '../src/lib/lyrics'

const lrc = (n: number, step = 4000) => Array.from({ length: n }, (_, i) => `[${String(Math.floor((i * step) / 60000)).padStart(2, '0')}:${String(Math.floor(((i * step) % 60000) / 1000)).padStart(2, '0')}.00] line number ${i} goes here`).join('\n')
const cand = (p: Partial<LyricsCandidate>): LyricsCandidate => ({ key: 'lrclib:1', source: 'LRCLIB', title: 'Kesariya', artist: 'Arijit Singh', album: null, durationMs: 268_000, synced: true, wordTimed: false, raw: lrc(40), score: 0, reasons: [], ...p })
const ctx = { title: 'Kesariya', artists: 'Arijit Singh, Pritam', referenceMs: 268_000, videoMs: 280_000, isVideo: true, preferLatin: true }

describe('lyrics candidates', () => {
  it('prefers the exact audio length, the same artist and synced lines', () => {
    const exact = scoreCandidate(cand({}), ctx)
    const longer = scoreCandidate(cand({ key: 'lrclib:2', durationMs: 300_000 }), ctx)
    const plain = scoreCandidate(cand({ key: 'lrclib:3', synced: false, raw: 'a\nb\nc\nd\ne' }), ctx)
    const other = scoreCandidate(cand({ key: 'lrclib:4', artist: 'Cover Band' }), ctx)
    const remix = scoreCandidate(cand({ key: 'lrclib:5', title: 'Kesariya Remix' }), ctx)
    expect(exact.score - remix.score).toBeGreaterThanOrEqual(45)
    expect(remix.reasons).toContain('another version')
    expect(exact.score).toBeGreaterThan(longer.score)
    expect(exact.score).toBeGreaterThan(plain.score)
    expect(exact.score).toBeGreaterThan(other.score)
    expect(exact.reasons).toContain('exact length')
  })
  it('rejects a different song and timestamps past the end', () => {
    expect(scoreCandidate(cand({ title: 'Tum Hi Ho' }), ctx).score).toBeLessThan(35)
    const late = scoreCandidate(cand({ raw: lrc(40, 9000) }), ctx)
    expect(late.reasons).toContain('timestamps past the end')
  })
  it('lifts the version that matches the official description lyrics, and your own choice above all', () => {
    const reference = new Set(['line', 'number', 'goes', 'here'])
    const a = scoreCandidate(cand({}), { ...ctx, reference })
    const b = scoreCandidate(cand({ key: 'lrclib:9', raw: '[00:01.00] something else entirely\n[00:05.00] totally different words\n[00:09.00] another one here maybe\n[00:12.00] last of them' }), { ...ctx, reference })
    expect(a.score).toBeGreaterThan(b.score)
    expect(scoreCandidate(cand({ key: 'lrclib:7', durationMs: 200_000 }), { ...ctx, yourChoice: 'lrclib:7' }).score).toBeGreaterThan(900)
  })
})

describe('timing fit', () => {
  it('finds offset and tempo from anchors, ignoring a bad one', () => {
    const pts = [10_000, 40_000, 70_000, 100_000, 130_000, 160_000].map((t) => ({ lrc: t, video: Math.round(t * 1.02 + 12_400) }))
    pts.push({ lrc: 90_000, video: 30_000 }) // a misheard line
    const f = fitTiming(pts)
    expect(f).not.toBeNull()
    expect(Math.abs((f!.offsetMs) - 12_400)).toBeLessThan(60)
    expect(f!.scale).toBeCloseTo(1.02, 3)
    expect(f!.used).toBe(6)
  })
  it('refuses when the anchors disagree', () => {
    expect(fitTiming([{ lrc: 0, video: 5000 }, { lrc: 10_000, video: 2000 }, { lrc: 20_000, video: 40_000 }, { lrc: 30_000, video: 1000 }])).toBeNull()
  })
  it('shifts lines and words', () => {
    const l = parseLrc('[00:10.00] hello there friend\n[00:14.00] second line here', 30_000)
    if (!l || l.kind !== 'synced') throw new Error('parse')
    const s = shiftLines(l.lines, 2000, 1)
    const i = l.lines.findIndex((x) => x.text === 'hello there friend')
    expect(s[0].start).toBe(0) // the instrumental intro still starts at 0, just runs longer
    expect(s[0].end).toBe(l.lines[0].end + 2000)
    expect(s[i].start).toBe(l.lines[i].start + 2000)
    expect(s[i + 1].words[0].start).toBe(l.lines[i + 1].words[0].start + 2000)
  })
})
