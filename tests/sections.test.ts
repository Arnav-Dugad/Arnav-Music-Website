import { describe, expect, it } from 'vitest'
import { nextChorus, sectionsFromLyrics } from '../src/lib/sections'
import { parseLrc } from '../src/lib/lyrics'

const ts = (ms: number) => `[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}]`
function song(blocks: string[][], gap = 6000): string {
  let t = 12_000
  const out: string[] = []
  for (const b of blocks) {
    for (const line of b) { out.push(`${ts(t)} ${line}`); t += 3500 }
    t += gap
  }
  return out.join('\n')
}

describe('song sections', () => {
  const verse1 = ['walking down the empty road tonight', 'every light is fading out of view', 'I can hear the city breathing slow', 'nothing left to say to you']
  const chorus = ['oh we were burning bright', 'like a fire in the night', 'hold on hold on to me', 'never let me go']
  const verse2 = ['morning comes and paints the window gold', 'coffee cold and stories left untold', 'pictures on the wall are fading too', 'every road leads back to you']
  const bridge = ['and if the sky falls down tonight', 'I will be the one to stay']
  const lrc = parseLrc(song([verse1, chorus, verse2, chorus, bridge, chorus]), 150_000)
  if (!lrc || lrc.kind !== 'synced') throw new Error('parse')
  const s = sectionsFromLyrics(lrc.lines, 150_000)

  it('finds the repeated block as the chorus, verses and the bridge', () => {
    expect(s.map((x) => x.kind)).toEqual(['intro', 'verse', 'chorus', 'verse', 'chorus', 'bridge', 'chorus', 'outro'])
  })
  it('skips to the next chorus', () => {
    const first = s.find((x) => x.kind === 'chorus')!
    expect(nextChorus(s, 0)?.start).toBe(first.start)
    const second = s.filter((x) => x.kind === 'chorus')[1]
    expect(nextChorus(s, first.start + 2000)?.start).toBe(second.start)
  })
  it('stays quiet when nothing repeats', () => {
    const plain = parseLrc(song([verse1, verse2]), 80_000)
    if (!plain || plain.kind !== 'synced') throw new Error('parse')
    expect(sectionsFromLyrics(plain.lines, 80_000).some((x) => x.kind === 'chorus')).toBe(false)
  })
})
