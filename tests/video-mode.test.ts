import { describe, expect, it } from 'vitest'
import { pickCounterpart } from '../src/services/recs'
import type { Track } from '../src/lib/types'

const t = (p: Partial<Track> & { id: string }): Track => ({ title: 'Kesariya', artist: 'Arijit Singh', playbackRef: p.id.replace('yt:', ''), genres: [], durationMs: 268_000, trust: 3, ...p }) as Track
const topic = t({ id: 'yt:topicAAAAAA', variant: 'SONG', channelTitle: 'Arijit Singh - Topic', rawTitle: 'Kesariya' })

describe('Video mode finds the real music video', () => {
  const official = t({ id: 'yt:officialAAA', variant: 'VIDEO', channelTitle: 'Sony Music India', rawTitle: 'Kesariya - Brahmāstra | Official Music Video | Arijit Singh', durationMs: 290_000 })
  const lyric = t({ id: 'yt:lyricAAAAA', variant: 'VIDEO', channelTitle: 'Sony Music India', rawTitle: 'Kesariya - Lyric Video | Arijit Singh', durationMs: 268_000 })
  const remix = t({ id: 'yt:remixAAAAA', title: 'Kesariya Remix', variant: 'VIDEO', channelTitle: 'Sony Music India', rawTitle: 'Kesariya Remix | Official Video' })
  const short = t({ id: 'yt:shortAAAAA', variant: 'VIDEO', channelTitle: 'Sony Music India', rawTitle: 'Kesariya #shorts official video', durationMs: 40_000 })
  const other = t({ id: 'yt:otherAAAAA', title: 'Tum Hi Ho', variant: 'VIDEO', rawTitle: 'Tum Hi Ho Official Video' })
  it('prefers the official music video over a lyric video, remix or short', () => {
    expect(pickCounterpart(topic, 'VIDEO', [lyric, remix, short, other, official])?.id).toBe('yt:officialAAA')
  })
  it('falls back to a lyric video before giving up', () => {
    expect(pickCounterpart(topic, 'VIDEO', [lyric, remix, other])?.id).toBe('yt:lyricAAAAA')
  })
  it('finds nothing rather than another song or the same upload', () => {
    expect(pickCounterpart(topic, 'VIDEO', [other, remix, topic])).toBeNull()
  })
  it('Song mode picks the audio release for a music video', () => {
    expect(pickCounterpart(official, 'SONG', [lyric, topic, remix])?.id).toBe('yt:topicAAAAAA')
  })
})
