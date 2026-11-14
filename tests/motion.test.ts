import { describe, expect, it } from 'vitest'
import { effectiveMotion } from '../src/state/settings'

describe('motion follows the device', () => {
  it('plays Full as Reduced when the OS asks for reduced motion', () => {
    expect(effectiveMotion('full', true)).toBe('reduced')
    expect(effectiveMotion('full', false)).toBe('full')
  })
  it('never adds motion the user turned down', () => {
    expect(effectiveMotion('reduced', false)).toBe('reduced')
    expect(effectiveMotion('off', true)).toBe('off')
    expect(effectiveMotion('off', false)).toBe('off')
  })
})
