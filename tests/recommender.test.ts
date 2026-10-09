import { describe, expect, it } from 'vitest'
import { buildModel, recommend, sceneOf, scoreTrack, topArtistsNow } from '../src/lib/recommender'
import { artistKey, type PlayEvent, type Track } from '../src/lib/types'

const NOW = Date.UTC(2026, 9, 9, 14)
const tr = (id: string, title: string, artist: string, extra: Partial<Track> = {}): Track => ({ id: `yt:${id}`, title, artist, playbackRef: id, durationMs: 200_000, genres: [], ...extra }) as Track
const T = {
  kes: tr('kes', 'Kesariya', 'Arijit Singh', { channelTitle: 'Sony Music India' }),
  tum: tr('tum', 'Tum Hi Ho', 'Arijit Singh', { channelTitle: 'T-Series' }),
  apna: tr('apna', 'Apna Bana Le', 'Arijit Singh', { channelTitle: 'Zee Music Company' }),
  raat: tr('raat', 'Raataan Lambiyan', 'Jubin Nautiyal', { channelTitle: 'Sony Music India' }),
  lut: tr('lut', 'Lut Gaye', 'Jubin Nautiyal', { channelTitle: 'T-Series' }),
  brown: tr('brown', 'Brown Munde', 'AP Dhillon', { channelTitle: 'APDHILLON' }),
  excuses: tr('exc', 'Excuses', 'AP Dhillon', { channelTitle: 'Intense' }),
  blind: tr('blind', 'Blinding Lights', 'The Weeknd', { channelTitle: 'TheWeekndVEVO', views: 900_000_000 }),
  bad: tr('bad', 'bad guy', 'Billie Eilish', { channelTitle: 'BillieEilishVEVO', views: 1_000_000_000 }),
  skip: tr('skip', 'Skipped Song', 'Some Band', { channelTitle: 'Some Band - Topic' }),
}
const byId = new Map(Object.values(T).map((t) => [t.id, t]))
let clock = NOW - 20 * 86_400_000
const ev = (t: Track, opts: { skip?: boolean; at?: number; gapMin?: number } = {}): PlayEvent => {
  clock = opts.at ?? clock + (opts.gapMin ?? 4) * 60_000
  return { trackId: t.id, artistKey: artistKey(t.artist), startedAt: clock, listenedMs: opts.skip ? 8_000 : 200_000, durationMs: 200_000, completed: !opts.skip, skipped: !!opts.skip, source: 'YOUTUBE' }
}
// Sessions: Kesariya is usually followed by Raataan Lambiyan; Arijit and Jubin share sessions; the
// "Skipped Song" is always skipped.
const events: PlayEvent[] = []
for (let d = 0; d < 12; d++) {
  events.push(ev(T.kes, { gapMin: 60 * 24 }), ev(T.raat), ev(T.tum), ev(T.skip, { skip: true }))
  if (d % 3 === 0) events.push(ev(T.brown))
}
const names = (id: string) => byId.get(id)?.title
const model = () => buildModel(events, (id) => byId.get(id), new Set(), { now: NOW })

describe('recommender v2', () => {
  it('detects scenes from scripts and channels', () => {
    expect(sceneOf(T.kes)).toBe('bollywood')
    expect(sceneOf(T.brown)).toBe('punjabi')
    expect(sceneOf(tr('x', 'تملي معاك', 'Amr Diab'))).toBe('arabic')
    expect(sceneOf(tr('y', 'Despacito', 'Luis Fonsi', { rawTitle: 'Luis Fonsi - Despacito (Video Oficial)' }))).toBe('latin')
    expect(sceneOf(T.blind)).toBe('western')
  })
  it('learns which song follows which and explains it', () => {
    const m = model()
    const p = scoreTrack(T.raat, m, 'radio', { seed: T.kes, names })
    expect(p.kind).toBe('context')
    expect(p.why).toBe('Because you played Kesariya')
    expect(scoreTrack(T.raat, m, 'radio', { seed: T.kes, names }).score).toBeGreaterThan(scoreTrack(T.blind, m, 'radio', { seed: T.kes, names }).score)
  })
  it('punishes songs you skip early', () => {
    const m = model()
    expect(scoreTrack(T.skip, m, 'quick').score).toBeLessThan(scoreTrack(T.apna, m, 'quick').score)
  })
  it('keeps shelves varied: no artist twice in a row, at most two per shelf', () => {
    const m = model()
    const pool = [T.kes, T.tum, T.apna, T.raat, T.lut, T.brown, T.excuses, T.blind, T.bad]
    const picks = recommend(pool, m, { mode: 'quick', limit: 8, names })
    for (let i = 1; i < picks.length; i++) expect(artistKey(picks[i].track.artist)).not.toBe(artistKey(picks[i - 1].track.artist))
    const arijit = picks.filter((p) => p.track.artist === 'Arijit Singh').length
    expect(arijit).toBeLessThanOrEqual(2)
  })
  it('discovery prefers new songs in the scenes you play', () => {
    const m = model()
    const picks = recommend([T.lut, T.excuses, T.bad, T.kes], m, { mode: 'discover', limit: 3, onlyNew: true, names })
    expect(picks.map((p) => p.track.id)).not.toContain(T.kes.id)
    expect(picks[0].track.id).toBe(T.lut.id) // Jubin, already loved, Bollywood
  })
  it('cold start leans on the artists you picked', () => {
    const m = buildModel([], (id) => byId.get(id), new Set(), { now: NOW, seedArtists: ['AP Dhillon'] })
    expect(m.cold).toBe(true)
    const picks = recommend([T.blind, T.excuses, T.kes], m, { mode: 'quick', limit: 3 })
    expect(picks[0].track.id).toBe(T.excuses.id)
    expect(picks[0].why).toBe('Because you like AP Dhillon')
    expect(topArtistsNow(m)).toContain(artistKey('AP Dhillon'))
  })
  it('never repeats what you just played', () => {
    const m = buildModel([...events, ev(T.blind, { at: NOW - 10 * 60_000 })], (id) => byId.get(id), new Set(), { now: NOW })
    expect(recommend([T.blind, T.bad], m, { mode: 'quick', limit: 2 })[0].track.id).toBe(T.bad.id)
  })
})

describe('one song, many uploads', () => {
  it('counts versions of a song once and prefers the original', () => {
    const m = buildModel([], (id) => byId.get(id), new Set(), { now: NOW, seedArtists: ['The Weeknd'] })
    const live = tr('blindlive', 'Blinding Lights (After Hours Til Dawn Tour Live', 'The Weeknd', { channelTitle: 'TheWeekndVEVO' })
    const picks = recommend([live, T.blind, T.bad], m, { mode: 'quick', limit: 3 })
    expect(picks.filter((p) => p.track.artist === 'The Weeknd')).toHaveLength(1)
    expect(picks.find((p) => p.track.artist === 'The Weeknd')!.track.id).toBe(T.blind.id)
  })
})
