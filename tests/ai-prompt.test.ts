import { describe, expect, it } from 'vitest'
import { sessionPrompt } from '../src/lib/intent'

describe('Arnav AI follow-ups', () => {
  it('keeps every recent refinement even after a long first request', () => {
    const base = 'energetic coding music, mostly familiar, a few surprises '.repeat(8)
    const q = `${base}. Also: add some Punjabi. Also: fewer remixes. Also: end calm`
    const p = sessionPrompt(q, ['A'], ['pop'], 21)
    expect(p).toContain('- add some Punjabi')
    expect(p).toContain('- fewer remixes')
    expect(p).toContain('- end calm')
    expect(p).toMatch(/Request: "energetic coding music/)
  })
  it('a single request has no refinements block', () => {
    expect(sessionPrompt('chill', [], [], 9)).not.toContain('Refinements')
  })
})
