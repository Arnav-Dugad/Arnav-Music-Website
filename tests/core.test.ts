/**
 * Ported from the Android app's core/domain unit tests (CoreLogicTest, CatalogTest, IntelligenceTest,
 * LyricsTest) so the web and Android implementations provably agree.
 */
import { describe, expect, it } from 'vitest'
import { duration, parseIsoDuration, compactCount, parseYouTubeTitle } from '../src/lib/format'
import { isCompilation, isSingleTitle, variantOf, titleSimilarity, rankForListening } from '../src/lib/classify'
import { cacheKey, matchScore } from '../src/lib/query'
import { artistKey, type Track } from '../src/lib/types'
import { interpretLocally, parseSession, extractObject, buildSession, energyAt, sanitize } from '../src/lib/intent'
import { buildProfile, rank, smartPlaylist } from '../src/lib/taste'
import { parseLrc, activeIndex, isInstrumental } from '../src/lib/lyrics'

const split = (raw: string, ch: string) => { const p = parseYouTubeTitle(raw, ch); return [p.artist, p.title] }
const tr = (i: number, artist = `Artist ${i % 10}`, energy: number | null = 0.5 + (i % 5) * 0.08): Track => ({
  id: `yt:vid${String(i).padStart(8, '0')}`, title: `Song ${i}`, artist, durationMs: 200_000, playbackRef: `vid${String(i).padStart(8, '0')}`, genres: ['pop'], energy,
})

describe('formatters (CoreLogicTest)', () => {
  it('formats durations and counts', () => {
    expect(duration(185_000)).toBe('3:05')
    expect(duration(3_661_000)).toBe('1:01:01')
    expect(parseIsoDuration('PT4M13S')).toBe(253_000)
    expect(parseIsoDuration('PT1H')).toBe(3_600_000)
    expect(compactCount(1_200_000)).toBe('1.2M')
  })
  it('splits YouTube titles like the app', () => {
    expect(split('Daft Punk - Get Lucky (Official Video)', 'DaftPunkVEVO')).toEqual(['Daft Punk', 'Get Lucky'])
    expect(split('Hello', 'Adele - Topic')).toEqual(['Adele', 'Hello'])
    expect(split('Narayanamma Lyric Video I Aadarsha Kutumbam I Venkatesh, Shriya', 'Aditya Music')).toEqual(['Aditya Music', 'Narayanamma'])
    expect(split('Butta Bomma Full Video Song | Ala Vaikunthapurramuloo', 'T-Series')).toEqual(['T-Series', 'Butta Bomma'])
    expect(split('Sid Sriram - Inkem Inkem (Lyrical Video)', 'Sid Sriram')).toEqual(['Sid Sriram', 'Inkem Inkem'])
    expect(split('Imagine Dragons - Believer (Official Music Video)', 'ImagineDragonsVEVO')).toEqual(['Imagine Dragons', 'Believer'])
    expect(split('Backstreet Boys - I Want It That Way (Official HD Video)', 'Backstreet Boys')).toEqual(['Backstreet Boys', 'I Want It That Way'])
    expect(split('Madonna - Music', 'Madonna')).toEqual(['Madonna', 'Music'])
  })
  it('extracts album and credits from label titles (CatalogTest)', () => {
    const p = parseYouTubeTitle('Samajavaragamana Lyrical | Ala Vaikunthapurramuloo Movie Songs | Allu Arjun, Pooja Hegde', 'Aditya Music')
    expect(p.title).toBe('Samajavaragamana')
    expect(p.album).toBe('Ala Vaikunthapurramuloo')
    expect(p.credits).toBe('Allu Arjun, Pooja Hegde')
    const q = parseYouTubeTitle('Narayanamma Lyric Video I Aadarsha Kutumbam I Venkatesh, Shriya', 'Aditya Music')
    expect(q.album).toBe('Aadarsha Kutumbam')
    expect(q.credits).toBe('Venkatesh, Shriya')
    expect(parseYouTubeTitle('Music Video | Meesaya Murukku | Hiphop Tamizha', 'Vibe Venuma').title).toBe('Meesaya Murukku')
    expect(parseYouTubeTitle('Backstreet Boys - I Want It That Way (Official HD Video)', 'x').album).toBeNull()
  })
})

describe('label uploads (web improvements)', () => {
  it('reads "Song - Movie | Cast | Singers" from Indian labels', () => {
    const p = parseYouTubeTitle('Makhna - Drive | Sushant Singh Rajput, Jacqueline Fernandez | Tanishk Bagchi, Asees Kaur', 'Zee Music Company')
    expect(p.title).toBe('Makhna')
    expect(p.album).toBe('Drive')
    expect(p.artist).toBe('Tanishk Bagchi, Asees Kaur')
    expect(p.credits).toBe('Sushant Singh Rajput, Jacqueline Fernandez')
  })
  it('strips label noise and quotes', () => {
    expect(parseYouTubeTitle('Full Song: Tujhe Kitna Chahne Lage | Kabir Singh', 'T-Series').title).toBe('Tujhe Kitna Chahne Lage')
    expect(parseYouTubeTitle('"Senorita Zindagi Na Milegi Dobara" Full HD', 'T-Series').title).toBe('Senorita Zindagi Na Milegi Dobara')
  })
  it('leaves artist - title uploads from non-label channels alone', () => {
    const p = parseYouTubeTitle('Daft Punk - Get Lucky (Official Video)', 'DaftPunkVEVO')
    expect([p.artist, p.title]).toEqual(['Daft Punk', 'Get Lucky'])
  })
})

describe('catalog (CatalogTest)', () => {
  it('rejects mixes, mashups and mood compilations', () => {
    for (const t of ['Music Mix 2026 | Party Club Dance 2026 | Best Remixes', 'Gym Motivation Music', 'Remixes & Mashups of Popular Songs 2026',
      '2026 Top Hits Clean ♫ Trending Music', 'Pop Party Hits Mix #04 | Early 2000s', 'Arijit Singh Jukebox | Best of Arijit',
      'Lofi Music for Studying 1 Hour', 'Nonstop Bollywood Dance Songs']) expect(isCompilation(t, 200_000), t).toBe(true)
    expect(isCompilation('Some Song', 45 * 60_000)).toBe(true)
  })
  it('keeps real singles, including remixes', () => {
    for (const t of ['Officially Blind (Remix)', 'Starboy', 'One Dance ft. Wizkid & Kyla', 'Blinding Lights', 'Narayanamma', 'Mixed Feelings']) expect(isCompilation(t, 230_000), t).toBe(false)
    expect(isSingleTitle('Intro', 20_000)).toBe(false)
  })
  it('detects song vs video uploads', () => {
    expect(variantOf('The Weeknd - Topic', 'Starboy')).toBe('SONG')
    expect(variantOf('TheWeekndVEVO', 'Starboy')).toBe('VIDEO')
    expect(variantOf('Aditya Music', 'Narayanamma Lyric Video I Aadarsha Kutumbam')).toBe('VIDEO')
    expect(variantOf('Label', 'Song Name (Official Audio)')).toBe('SONG')
    expect(variantOf('Someone', 'Song Name')).toBeNull()
    expect(titleSimilarity('Blinding Lights', 'The Weeknd - Blinding Lights (Official Video)')).toBeGreaterThanOrEqual(0.99)
  })
  it('ranks singles and the preferred upload type first', () => {
    const mix = { ...tr(1), title: 'Best of 2020 mix', compilation: true }
    const video = { ...tr(2), variant: 'VIDEO' as const }
    const song = { ...tr(3), variant: 'SONG' as const }
    expect(rankForListening([mix, video, song], 'SONG').map((t) => t.id)).toEqual([song.id, video.id, mix.id])
  })
})

describe('search + identity (CoreLogicTest)', () => {
  it('normalises cache keys', () => {
    expect(cacheKey('  Daft PUNK!! ')).toBe(cacheKey('daft punk'))
    expect(cacheKey('Beyoncé official video')).toBe(cacheKey('beyonce'))
    expect(matchScore('daft', 'Daft Punk')).toBeGreaterThan(0.8)
    expect(matchScore('blindng lights', 'Blinding Lights')).toBeGreaterThan(0.5)
  })
  it('normalises artist keys exactly like the app', () => {
    expect(artistKey('Daft Punk - Topic')).toBe(artistKey('daft punk'))
    expect(artistKey('TaylorSwiftVEVO')).toBe(artistKey('Taylor Swift'))
    expect(artistKey('Drake feat. Rihanna')).toBe(artistKey('Drake'))
    expect(artistKey('Daft Punk')).toBe('daftpunk')
    expect(artistKey('Drake (ft. Rihanna)')).toBe(artistKey('Drake'))
  })
})

describe('Arnav AI (IntelligenceTest)', () => {
  it('parses duration, mood, negation and curve on device', () => {
    const c = interpretLocally('45 minutes of energetic music for coding but not aggressive, gradually increase in energy, a few surprises')
    expect(c.durationMinutes).toBe(45)
    expect(c.moods).toContain('energetic')
    expect(c.moods).toContain('focus')
    expect(c.avoidMoods).toContain('aggressive')
    expect(c.moods).not.toContain('aggressive')
    expect(c.energyCurve).toBe('RISING')
    expect(c.context).toBe('coding')
    expect(c.searchQueries.length).toBeGreaterThan(0)
  })
  it('handles hours, rediscovery and similar-to', () => {
    expect(interpretLocally('an hour and a half... no, 1.5 hours of chill').durationMinutes).toBe(90)
    expect(interpretLocally("Rediscover music I haven't played recently").rediscover).toBe(true)
    const s = interpretLocally('songs similar to Daft Punk but calmer')
    expect(s.seedArtists[0]).toBe('Daft Punk but calmer')
    expect(s.energyTarget).toBeLessThan(0.6)
    expect(interpretLocally('Give me something upbeat').moods).toContain('upbeat')
  })
  it('parses Gemini JSON tolerantly', () => {
    const raw = 'Sure! Here you go:\n```json\n{"title":"Night {drive}","durationMinutes":999,"energyCurve":"rising","searchQueries":["synthwave"],"unknown":1}\n```'
    const r = parseSession(raw)!
    expect(r.title).toBe('Night {drive}')
    expect(r.durationMinutes).toBe(240)
    expect(r.energyCurve).toBe('RISING')
    expect(parseSession('not json')).toBeNull()
    expect(parseSession('{"title": "x"}')).toBeNull()
    expect(extractObject('{ unterminated')).toBeNull()
  })
  it('drops mix/playlist search phrases from the model', () => {
    expect(sanitize({ searchQueries: ['chill mix', 'chill songs'] }).searchQueries).toEqual(['chill songs'])
  })
  it('builds a session that fills the duration with diverse artists, deterministically', () => {
    const c = sanitize({ durationMinutes: 30, energyTarget: 0.6, artistDiversity: 0.8, searchQueries: ['x'] })
    const tracks = Array.from({ length: 40 }, (_, i) => tr(i))
    const p = buildProfile([], () => undefined, new Set(), 1_700_000_000_000)
    const a = buildSession(c, tracks, p, new Set(), 1_700_000_000_000)
    const b = buildSession(c, tracks, p, new Set(), 1_700_000_000_000)
    expect(a.totalMs).toBeGreaterThanOrEqual(30 * 60_000)
    for (let i = 1; i < a.tracks.length; i++) expect(artistKey(a.tracks[i].artist)).not.toBe(artistKey(a.tracks[i - 1].artist))
    expect(new Set(a.tracks.map((t) => t.id)).size).toBe(a.tracks.length)
    expect(a.tracks.map((t) => t.id)).toEqual(b.tracks.map((t) => t.id))
    expect(buildSession(c, [], p, new Set()).tracks).toEqual([])
    const rising = sanitize({ energyCurve: 'RISING' })
    expect(energyAt(rising, 0)).toBeLessThan(energyAt(rising, 1))
  })
})

describe('recommender + smart playlists (IntelligenceTest)', () => {
  const NOW = 1_700_000_000_000
  const ev = (t: Track, daysAgo: number, completed = true) => ({
    trackId: t.id, artistKey: artistKey(t.artist), startedAt: NOW - daysAgo * 86_400_000, listenedMs: completed ? 200_000 : 20_000,
    durationMs: 200_000, completed, skipped: !completed, source: 'YOUTUBE' as const,
  })
  it('ranks an affine artist above unknown and penalises just-played', () => {
    const tracks = [tr(1, 'Artist 3'), tr(2, 'Artist 9'), tr(3, 'Artist 3')]
    const events = [ev(tracks[0], 1), ev(tracks[0], 2), ev(tracks[2], 3)]
    const p = buildProfile(events, (id) => tracks.find((t) => t.id === id), new Set(), NOW)
    const ranked = rank([tracks[1], tracks[2]], p, { now: NOW })
    expect(ranked[0].track.artist).toBe('Artist 3')
    const justPlayed = { ...ev(tracks[2], 0), startedAt: NOW - 60_000 }
    const p2 = buildProfile([...events, justPlayed], (id) => tracks.find((t) => t.id === id), new Set(), NOW)
    const ranked2 = rank([tracks[2], tracks[1], tracks[0]], p2, { now: NOW })
    expect(ranked2.findIndex((s) => s.track.id === tracks[2].id)).toBeGreaterThan(0)
  })
  it('computes smart playlists', () => {
    const t = tr(1)
    const liked = new Set([t.id])
    expect(smartPlaylist('FORGOTTEN_FAVORITES', [ev(t, 60)], liked, NOW)).toEqual([t.id])
    const a = tr(2)
    const b = tr(3)
    expect(smartPlaylist('HEAVY_ROTATION', [ev(a, 1), ev(b, 1), ev(b, 2), ev(b, 3)], new Set(), NOW)[0]).toBe(b.id)
    expect(smartPlaylist('MOST_REPLAYED', [], new Set(), NOW)).toEqual([])
  })
})

describe('lyrics (LyricsTest)', () => {
  it('parses synced LRC with offsets, multiple stamps and metadata', () => {
    const l = parseLrc('[ar:Someone]\n[offset:+500]\n[00:12.00][00:40.50]Hello world\n[00:15.20]Second line (echo)\n', 60_000)!
    expect(l.kind).toBe('synced')
    if (l.kind !== 'synced') return
    const sung = l.lines.filter((x) => !isInstrumental(x))
    expect(sung.map((x) => x.start)).toEqual([11_500, 14_700, 40_000])
    expect(sung[1].text).toBe('Second line')
    expect(sung[1].background).toBe('echo')
    expect(isInstrumental(l.lines[0])).toBe(true) // 11.5 s lead-in becomes a break
    expect(activeIndex(l.lines, 13_000)).toBe(l.lines.indexOf(sung[0]))
  })
  it('reads enhanced word timing and keeps section labels', () => {
    const l = parseLrc('[00:01.00]<00:01.00>One <00:01.50>two <00:02.00>three\n[00:04.00](Chorus)')!
    if (l.kind !== 'synced') throw new Error('expected synced')
    expect(l.lines[0].words.map((w) => w.text)).toEqual(['One', 'two', 'three'])
    expect(l.lines[0].estimated).toBe(false)
    expect(l.lines[1].text).toBe('(Chorus)')
    expect(l.lines[1].background).toBeUndefined()
  })
  it('treats music-note lines as instrumental and plain text as plain', () => {
    const l = parseLrc('[00:05.00]♪\n[00:20.00]Words')!
    if (l.kind !== 'synced') throw new Error('expected synced')
    expect(isInstrumental(l.lines.find((x) => x.start === 5_000)!)).toBe(true)
    const p = parseLrc('Line one\n\nLine two')!
    expect(p.kind).toBe('plain')
  })
})
