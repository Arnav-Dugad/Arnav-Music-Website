import { describe, expect, it } from 'vitest'
import { sharedTarget } from '../src/lib/links'

describe('sharing into the app', () => {
  it('plays a shared YouTube or YouTube Music song', () => {
    expect(sharedTarget(' https://youtu.be/dQw4w9WgXcQ?si=abc ')).toBe('/track/dQw4w9WgXcQ')
    expect(sharedTarget('Listen https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share')).toBe('/track/dQw4w9WgXcQ')
  })
  it('opens a shared playlist', () => {
    expect(sharedTarget('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG')).toBe('/playlist/ytpl:PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG')
  })
  it('searches for anything else, without the links', () => {
    expect(sharedTarget('Kesariya Arijit Singh https://example.com/x')).toBe('/search?q=Kesariya%20Arijit%20Singh')
    expect(sharedTarget('')).toBe('/search')
  })
})
