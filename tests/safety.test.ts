import { describe, expect, it } from 'vitest'
import { originAllowed, type ApiEnv } from '../server/util'
import { communityApi } from '../server/meta'
import { REPLAY_CLEARED, usePrefs, type ReplaySnapshot } from '../src/state/prefs'
import { remember, setRegistryKeeper, trackRegistry } from '../src/state/tracks'
import type { Track } from '../src/lib/types'

const req = (origin: string | null, url = 'https://arnav.example/api/yt?ep=search') =>
  new Request(url, { headers: origin ? { origin } : {} })

describe('quota-spending routes only answer this app', () => {
  const env = {} as ApiEnv
  it('lets same-site and Origin-less requests through', () => {
    expect(originAllowed(req(null), env)).toBe(true)
    expect(originAllowed(req('https://arnav.example'), env)).toBe(true)
  })
  it('allows local development', () => {
    expect(originAllowed(req('http://localhost:5173'), env)).toBe(true)
    expect(originAllowed(req('http://127.0.0.1:8787'), env)).toBe(true)
  })
  it('refuses other websites and opaque origins', () => {
    expect(originAllowed(req('https://evil.example'), env)).toBe(false)
    expect(originAllowed(req('https://arnav.example.evil.example'), env)).toBe(false)
    expect(originAllowed(req('null'), env)).toBe(false)
  })
  it('honours ALLOWED_ORIGINS', () => {
    expect(originAllowed(req('https://partner.example'), { ALLOWED_ORIGINS: 'https://a.example, https://partner.example/' } as ApiEnv)).toBe(true)
  })
})

function fakeKv() {
  const store = new Map<string, string>()
  return { store, async get(k: string) { return store.get(k) ?? null }, async put(k: string, v: string) { store.set(k, v) } }
}
const V = 'dQw4w9WgXcQ'
const vote = (kv: ReturnType<typeof fakeKv>, ip: string, body: Record<string, unknown>) => communityApi(
  new Request('https://arnav.example/api/community', { method: 'POST', headers: { 'cf-connecting-ip': ip }, body: JSON.stringify({ v: V, choice: 'lrclib:42', ...body }) }),
  new URL('https://arnav.example/api/community'),
  { YT_CACHE: kv as unknown as KVNamespace } as ApiEnv,
).then((r) => r.json() as Promise<{ votes: number; map: [number, number, number][] | null }>)

describe('community lyric fixes', () => {
  it('counts one vote per visitor per song', async () => {
    const kv = fakeKv()
    await vote(kv, '1.1.1.1', {})
    await vote(kv, '1.1.1.1', {})
    expect((await vote(kv, '1.1.1.1', {})).votes).toBe(1)
    expect((await vote(kv, '2.2.2.2', {})).votes).toBe(2)
    // Vote records hold a hash, never the address.
    expect([...kv.store.keys()].some((k) => k.includes('1.1.1.1'))).toBe(false)
  })
  it('serves the timing map most listeners agree on, not the latest one', async () => {
    const kv = fakeKv()
    const good: [number, number, number][] = [[0, 60_000, 1_000], [60_000, 200_000, 4_000]]
    const close: [number, number, number][] = [[0, 60_000, 1_200], [60_000, 200_000, 4_100]]
    const bad: [number, number, number][] = [[0, 200_000, 90_000]]
    await vote(kv, '1.0.0.1', { map: good })
    await vote(kv, '1.0.0.2', { map: close })
    await vote(kv, '1.0.0.3', { map: good })
    const after = await vote(kv, '6.6.6.6', { map: bad })
    expect(after.map).toEqual(good)
  })
})

const snap = (key: string, minutes: number, at: number): ReplaySnapshot => ({
  key, label: key, kind: 'month', minutes, plays: 1, artistsCount: 1, change: null, songs: [], artists: [], albums: [],
  devices: { phone: 0, tablet: 0, desktop: minutes }, streak: 1, bestStreak: 1, at,
})

describe('clearing history clears saved Replays everywhere', () => {
  it('drops local snapshots and refuses older ones from other devices', () => {
    usePrefs.setState({ replay: {}, replayClearedAt: undefined })
    usePrefs.getState().saveReplay([snap('2026-09', 500, Date.now() - 1000)])
    usePrefs.getState().clearReplay()
    expect(usePrefs.getState().replay).toEqual({})
    // Another device still has the fuller, older copy: it must not come back.
    usePrefs.getState().merge('replay', { '2026-09': snap('2026-09', 900, Date.now() - 5000) }, Date.now())
    expect(usePrefs.getState().replay).toEqual({})
    // Listening after the clear is kept.
    const fresh = snap('2026-11', 12, Date.now() + 10)
    usePrefs.getState().merge('replay', { '2026-11': fresh }, Date.now())
    expect(usePrefs.getState().replay['2026-11']).toEqual(fresh)
  })
  it('applies a clear made on another device', () => {
    const t = Date.now()
    usePrefs.setState({ replay: { '2026-08': snap('2026-08', 300, t - 10_000) }, replayClearedAt: undefined })
    usePrefs.getState().merge('replay', { [REPLAY_CLEARED]: { at: t - 1000 } }, t)
    expect(usePrefs.getState().replay).toEqual({})
    expect(usePrefs.getState().replayClearedAt).toBe(t - 1000)
  })
})

describe('track cache never evicts library songs', () => {
  it('keeps tracks the library uses when it fills up', () => {
    const mine: Track = { id: 'yt:liked000001', title: 'Kept', artist: 'A', genres: [] } as unknown as Track
    remember(mine)
    setRegistryKeeper(() => new Set([mine.id]))
    const filler = Array.from({ length: 6100 }, (_, i) => ({ id: `yt:f${String(i).padStart(10, '0')}`, title: `F${i}`, artist: 'B', genres: [] }) as unknown as Track)
    remember(filler)
    expect(trackRegistry.has(mine.id)).toBe(true)
    expect(trackRegistry.all().length).toBeLessThanOrEqual(6000)
    expect(trackRegistry.has(filler[0].id)).toBe(false)
    setRegistryKeeper(() => new Set())
  })
})
