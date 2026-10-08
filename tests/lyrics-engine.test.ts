import { describe, expect, it } from 'vitest'
import { applyMap, fitSegments, fitTiming, scoreCandidate, shiftLines, titleMatch, type LyricsCandidate } from '../src/services/lyricsEngine'
import { cleanTitle, isIndic, isRtl, parseLrc, syllables } from '../src/lib/lyrics'

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

describe('lyrics across languages', () => {
  it('matches titles by coverage, not just containment', () => {
    expect(titleMatch('Kesariya - Brahmastra', 'Kesariya')).toBeGreaterThan(0.85)
    expect(titleMatch('Kesariya', 'Kesariya')).toBe(1)
    expect(titleMatch('Coke Studio Season 7 Tum Naraaz Ho', 'Pasoori')).toBe(0)
    expect(titleMatch('Tum Hi Ho', 'Tum Hi Ho Aashiqui 2 Full Song')).toBeLessThan(0.6)
    expect(titleMatch('تملي معاك', 'تملي معاك')).toBe(1)
  })
  it('scores lyrics timed to a shorter film edit as well as the full song', () => {
    const cut = { ...ctx, referenceMs: 261_000, videoMs: 204_000 }
    const edit = scoreCandidate(cand({ key: 'lrclib:11', durationMs: 204_000, raw: lrc(40, 5000) }), cut)
    expect(edit.reasons).toContain('exact length')
    expect(edit.reasons).not.toContain('timestamps past the end')
  })
  it('estimates syllables per script', () => {
    expect(syllables('Despacito')).toBe(4)
    expect(syllables('canción')).toBe(2)
    expect(syllables('beautiful')).toBe(3)
    expect(syllables('केसरिया')).toBe(4) // के-स-रि-या
    expect(syllables('प्यार')).toBe(2) // प्या-र: the virama joins प and य
    expect(syllables('ਸੋਹਣੀ')).toBe(3)
    expect(syllables('حبيبي')).toBeGreaterThanOrEqual(2)
    expect(syllables('愛してる')).toBe(4)
  })
  it('knows which lines read right to left', () => {
    expect(isRtl('يا ليلي و يا ليلة')).toBe(true)
    expect(isRtl('دل دل پاکستان')).toBe(true)
    expect(isRtl('Ya lili ya lila')).toBe(false)
    expect(isRtl('Habibi يا نور العين')).toBe(true)
    expect(isIndic('केसरिया तेरा इश्क़ है पिया')).toBe(true)
  })
})

describe('edited videos (piecewise timing)', () => {
  it('finds the parts of an edit and hides the lines it cut', () => {
    // Video plays 0–60 s of the song, cuts 60–100 s, then plays the rest; one anchor is misheard.
    const at = (lrc: number) => ({ lrc, video: lrc < 60_000 ? lrc + 2_000 : lrc - 38_000 })
    const pts = [5_000, 20_000, 35_000, 50_000, 110_000, 130_000, 150_000, 170_000].map(at)
    pts.push({ lrc: 140_000, video: 15_000 })
    const map = fitSegments(pts)!
    expect(map).toHaveLength(2)
    expect(map[0][2]).toBe(2_000)
    expect(map[1][2]).toBe(-38_000)
    const lines = parseLrc(lrc(45, 4000))!
    if (lines.kind !== 'synced') throw new Error('synced')
    const out = applyMap(lines.lines, map)
    expect(out.length).toBeLessThan(lines.lines.length)
    for (let i = 1; i < out.length; i++) expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].start)
    expect(out.some((l) => l.text === 'line number 20 goes here')).toBe(false) // 80 s: cut
  })
  it('returns nothing for too few anchors', () => {
    expect(fitSegments([{ lrc: 1, video: 2 }, { lrc: 3, video: 4 }])).toBeNull()
  })
})

describe('featured artists and exact uploads', () => {
  it('drops guests from the lookup title', () => {
    expect(cleanTitle('Levitating Featuring DaBaby')).toBe('Levitating')
    expect(cleanTitle('Despacito ft. Daddy Yankee')).toBe('Despacito')
    expect(cleanTitle('Shape of You')).toBe('Shape of You')
    expect(cleanTitle('Left and Right (feat. Jung Kook of BTS)')).toBe('Left and Right')
  })
  it('trusts lyrics timed to this exact upload', () => {
    const c = scoreCandidate(cand({ durationMs: 231_000 }), { ...ctx, referenceMs: 204_000, videoMs: 231_000 })
    expect(c.reasons).toContain('exact length')
  })
})
