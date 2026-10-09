import { describe, expect, it } from 'vitest'
import { DEFAULT_GLASS, glassFor, type GlassPref } from '../src/state/prefs'
import { buildWrapped } from '../src/lib/wrapped'
import { artistKey, type PlayEvent, type Track } from '../src/lib/types'

describe('glass per device', () => {
  const phone: GlassPref = { style: 'clear', strength: 30, adaptive: true, at: 100 }
  const laptop: GlassPref = { style: 'tinted', strength: 80, adaptive: false, at: 200 }
  it('keeps each device its own glass', () => {
    expect(glassFor({ phone, laptop }, 'phone')).toEqual(phone)
    expect(glassFor({ phone, laptop }, 'laptop')).toEqual(laptop)
  })
  it('a new device starts from your latest choice, or the default', () => {
    expect(glassFor({ phone, laptop }, 'tablet').strength).toBe(80)
    expect(glassFor({}, 'tablet')).toEqual(DEFAULT_GLASS)
  })
})

describe('replay', () => {
  const tr = (id: string, artist: string, album?: string): Track => ({ id: `yt:${id}`, title: id, artist, album, playbackRef: id, durationMs: 200_000, genres: [] }) as Track
  const songs = Array.from({ length: 12 }, (_, i) => tr(`s${i}`, `Artist ${i % 7}`, `Album ${i % 6}`))
  const byId = new Map(songs.map((t) => [t.id, t]))
  const start = new Date(2026, 8, 3).getTime()
  const events: PlayEvent[] = songs.flatMap((t, i) => Array.from({ length: 12 - i }, (_, k) => ({ trackId: t.id, artistKey: artistKey(t.artist), startedAt: start + (i * 20 + k) * 3_600_000, listenedMs: 180_000, durationMs: 200_000, completed: true, skipped: false, source: 'YOUTUBE' as const })))
  it('ranks up to ten songs, artists and albums', () => {
    const w = buildWrapped('2026-09', events, (id) => byId.get(id), 10)!
    expect(w.songs).toHaveLength(10)
    expect(w.songs[0].track.id).toBe('yt:s0')
    expect(w.artists).toHaveLength(7)
    expect(w.albums).toHaveLength(6)
    expect(w.albums[0].name).toBe('Album 0')
  })
  it('the story still shows five', () => {
    expect(buildWrapped('2026-09', events, (id) => byId.get(id))!.songs).toHaveLength(5)
  })
})
