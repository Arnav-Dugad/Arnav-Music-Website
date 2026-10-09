import { afterEach, describe, expect, it, vi } from 'vitest'
import { musicVideosApi } from '../server/mv'
import type { ApiEnv } from '../server/util'

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(k: string) { return store.get(k) ?? null },
    async getWithMetadata(k: string) { return { value: store.get(k) ?? null, metadata: null } },
    async put(k: string, v: string) { store.set(k, v) },
  }
}
const video = (id: string, title: string, channel: string, dur = 'PT4M10S') => ({ id, snippet: { title, channelTitle: channel, channelId: `UC${id}`, thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } } }, contentDetails: { duration: dur }, status: { embeddable: true }, statistics: { viewCount: '900000000' } })
const SONG = video('topicSong01', 'Blinding Lights', 'The Weeknd - Topic', 'PT3M20S')
const OFFICIAL = video('officialMV1', 'The Weeknd - Blinding Lights (Official Video)', 'TheWeekndVEVO', 'PT4M22S')
const LYRIC = video('lyricVideo1', 'The Weeknd - Blinding Lights (Lyrics)', 'Lyrics Hub', 'PT3M20S')

function stubYouTube(onSearch?: () => void) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (u: string) => {
    const url = new URL(u)
    calls.push(url.pathname.split('/').pop()!)
    const path = url.pathname.split('/').pop()
    if (path === 'search') { onSearch?.(); return new Response(JSON.stringify({ items: [{ id: { videoId: 'lyricVideo1' } }, { id: { videoId: 'officialMV1' } }] })) }
    const ids = (url.searchParams.get('id') ?? '').split(',')
    const all = [SONG, OFFICIAL, LYRIC]
    return new Response(JSON.stringify({ items: all.filter((v) => ids.includes(v.id)) }))
  })
  return calls
}
const req = (ids: string) => [new Request(`https://x/api/mv?ids=${ids}`, { headers: { 'cf-connecting-ip': `1.2.3.${Math.random()}` } }), new URL(`https://x/api/mv?ids=${ids}`)] as const

afterEach(() => vi.unstubAllGlobals())

describe('music videos for your library', () => {
  it('finds the official video for an audio upload, and remembers it for everyone', async () => {
    const kv = fakeKv()
    const env = { YT_CACHE: kv as unknown as KVNamespace, YOUTUBE_API_KEY: 'k' } as ApiEnv
    const calls = stubYouTube()
    const r = await (await musicVideosApi(...req('topicSong01'), env)).json() as { items: Record<string, { alt: { playbackRef: string; variant: string } | null }>; pending: string[] }
    expect(r.items.topicSong01.alt?.playbackRef).toBe('officialMV1')
    expect(r.items.topicSong01.alt?.variant).toBe('VIDEO')
    expect(calls).toContain('search')
    // Second time: straight from KV, no YouTube calls at all.
    const again = stubYouTube()
    const r2 = await (await musicVideosApi(...req('topicSong01'), env)).json() as typeof r
    expect(r2.items.topicSong01.alt?.playbackRef).toBe('officialMV1')
    expect(again).toHaveLength(0)
  })
  it('resolves only a couple of new songs per request; the rest are pending', async () => {
    const kv = fakeKv()
    const env = { YT_CACHE: kv as unknown as KVNamespace, YOUTUBE_API_KEY: 'k' } as ApiEnv
    let searches = 0
    stubYouTube(() => searches++)
    const ids = ['topicSong01', 'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']
    const r = await (await musicVideosApi(...req(ids.join(',')), env)).json() as { pending: string[] }
    expect(searches).toBeLessThanOrEqual(2)
    expect(r.pending.length).toBeGreaterThanOrEqual(2)
  })
  it('stops at the daily budget', async () => {
    const kv = fakeKv()
    kv.store.set(`mv:budget:${new Date().toISOString().slice(0, 10)}`, '40')
    const env = { YT_CACHE: kv as unknown as KVNamespace, YOUTUBE_API_KEY: 'k' } as ApiEnv
    let searches = 0
    stubYouTube(() => searches++)
    const r = await (await musicVideosApi(...req('topicSong01'), env)).json() as { pending: string[] }
    expect(searches).toBe(0)
    expect(r.pending).toEqual(['topicSong01'])
  })
})
